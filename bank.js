'use strict';
/**
 * Bank sync through Plaid — READ-ONLY (the Transactions product: posted transactions and
 * balances). Nothing here can move money.
 *
 *   - The bank login happens on the bank's own page (OAuth) inside Plaid Link; the planner never
 *     sees a password. What it keeps is Plaid's access token, sealed with AES-256-GCM under
 *     BANK_TOKEN_KEY (a Railway variable, not on the volume), and it never leaves the server.
 *   - The server syncs nightly (BANK_SYNC_HOUR, default 20:00 America/Chicago) and when the app is
 *     opened (at most every 20 minutes). After each sync it RECONCILES YESTERDAY from the bank:
 *     closing balance = today's ledger balance − every posted transaction dated after yesterday.
 *     Those reconciles are marked source 'bank' and never move when a transaction is adjusted —
 *     they are what the bank said, not a variance you typed.
 *   - Matching transactions to the projection needs the projection, which lives in the page, so
 *     the PAGE matches and posts its decisions to /api/bank/decide (see "Bank" in index.html).
 *
 * Sandbox (PLAID_SANDBOX_SECRET only) is a dry run: it syncs Plaid's test bank and the page shows
 * what it WOULD do, but nothing is written to the planner. Production (PLAID_SECRET) is live.
 *
 * Env: PLAID_CLIENT_ID, PLAID_SECRET (production) / PLAID_SANDBOX_SECRET, BANK_TOKEN_KEY,
 *      optional PLAID_ENV (force 'sandbox'|'production'), PLAID_REDIRECT_URI, BANK_SYNC_HOUR.
 */
const crypto = require('node:crypto');

module.exports = function makeBank({ store, localNow, json, readBody, KEY_RE, parseAdjustment, saveAdjustment,
                                     rpFor, RANGE_START, RANGE_END }) {
  const env = process.env;
  const MODE = String(env.PLAID_ENV || (env.PLAID_SECRET ? 'production' : env.PLAID_SANDBOX_SECRET ? 'sandbox' : '')).toLowerCase();
  const SECRET = MODE === 'production' ? env.PLAID_SECRET || '' : MODE === 'sandbox' ? env.PLAID_SANDBOX_SECRET || '' : '';
  const CLIENT = env.PLAID_CLIENT_ID || '';
  const BASE = env.PLAID_BASE || `https://${MODE || 'sandbox'}.plaid.com`;
  const KEY = env.BANK_TOKEN_KEY && env.BANK_TOKEN_KEY.length >= 16
    ? crypto.createHash('sha256').update(env.BANK_TOKEN_KEY).digest() : null;
  const missing = [
    !CLIENT && 'PLAID_CLIENT_ID',
    !SECRET && (MODE === 'sandbox' ? 'PLAID_SANDBOX_SECRET' : 'PLAID_SECRET'),
    !KEY && 'BANK_TOKEN_KEY (at least 16 characters)'
  ].filter(Boolean);
  const READY = ['sandbox', 'production'].includes(MODE) && !missing.length;
  const LIVE = READY && MODE === 'production';          // only real bank data writes to the planner
  const DOC = 'bank-' + (MODE || 'none');               // sandbox and production never share data
  const SYNC_HOUR = Number(env.BANK_SYNC_HOUR ?? 20);
  const KEEP_DAYS = 150;                                // transactions older than this are dropped
  if (MODE && !READY) console.warn('[bank] not configured — missing', missing.join(', '));
  else if (READY) console.log('[bank]', MODE, LIVE ? '(live)' : '(dry run)');

  const addDay = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const r2 = n => Math.round(n * 100) / 100;

  /* ---- the access token, sealed ---- */
  const seal = s => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.');
  };
  const unseal = s => {
    const [iv, tag, ct] = String(s).split('.').map(x => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  };

  /* ---- state: one document per mode ----
     { items: {item_id: {id, token, institution, cursor, startOn, accounts:{id:{...}}, lastSync, error}},
       tx: {id: {id, item, account, date, amount (in = +), name, raw, sig, status, key?, label?, suggest?}},
       rules: {sig: label | '*extra' | '*ignore'}, lastNightly, lastRun, lastReconciled }
     status: history (before the connection; never matched) | new | review | matched | extra | ignored */
  const load = () => store.kvGet(DOC) || { items: {}, tx: {}, rules: {}, lastNightly: null, lastRun: null, lastReconciled: null };
  const save = st => store.kvSet(DOC, st);

  // A bank description reduced to what identifies the payee, so "ACH DEBIT ATT* BILL 10/07" and
  // next month's "ACH DEBIT ATT* BILL 11/07" share a rule.
  const NOISE = new Set(['ach', 'debit', 'credit', 'pos', 'purchase', 'payment', 'pmt', 'online', 'transfer', 'card',
    'recurring', 'web', 'id', 'ppd', 'ccd', 'co', 'inc', 'llc', 'the', 'des', 'indn', 'from', 'to', 'www', 'com',
    'checkcard', 'withdrawal', 'deposit', 'electronic', 'bill', 'autopay', 'auto', 'ref', 'trn', 'xx', 'xxxx']);
  const sigOf = s => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ')
    .filter(w => w.length > 1 && !NOISE.has(w)).slice(0, 4).join(' ');

  async function plaid(p, body) {
    const r = await fetch(BASE + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT, secret: SECRET, ...body }), signal: AbortSignal.timeout(30000)
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(out.error_message || `Plaid error ${r.status}`); e.code = out.error_code || ''; throw e; }
    return out;
  }

  /* ---- sync ----
     The network part collects; the apply part runs synchronously on a FRESH copy of the state,
     so a decision the page posts while Plaid is answering is never overwritten. */
  async function fetchItem(item) {
    const token = unseal(item.token);
    let cursor = item.cursor || '', added = [], modified = [], removed = [];
    for (let i = 0; i < 40; i++) {
      let page;
      try { page = await plaid('/transactions/sync', { access_token: token, count: 500, ...(cursor ? { cursor } : {}) }); }
      catch (e) {
        if (e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') { cursor = item.cursor || ''; added = []; modified = []; removed = []; continue; }
        throw e;
      }
      added.push(...(page.added || [])); modified.push(...(page.modified || [])); removed.push(...(page.removed || []));
      cursor = page.next_cursor || cursor;
      if (!page.has_more) break;
    }
    const acc = await plaid('/accounts/get', { access_token: token });
    return { cursor, upserts: [...added, ...modified], removed: removed.map(r => r.transaction_id), accounts: acc.accounts || [] };
  }
  function applyFetch(st, id, f) {
    const item = st.items[id]; if (!item) return;            // disconnected meanwhile
    const at = new Date().toISOString();
    for (const a of f.accounts) {
      const prev = item.accounts[a.account_id];
      item.accounts[a.account_id] = {
        id: a.account_id, name: a.name || a.official_name || 'Account', mask: a.mask || '', type: a.type || '', subtype: a.subtype || '',
        // Checking is what the planner tracks; anything else is opt-in.
        tracked: prev ? prev.tracked : (a.type === 'depository' && a.subtype === 'checking'),
        current: a.balances && Number.isFinite(a.balances.current) ? a.balances.current : null,
        available: a.balances && Number.isFinite(a.balances.available) ? a.balances.available : null, asOf: at
      };
    }
    for (const t of f.upserts) {
      if (t.pending) continue;                                  // posted only: it is what the ledger shows
      const prev = st.tx[t.transaction_id];
      const name = String(t.merchant_name || t.name || 'Bank transaction').slice(0, 120);
      st.tx[t.transaction_id] = {
        ...(prev || {}), id: t.transaction_id, item: id, account: t.account_id, date: t.date,
        amount: r2(-Number(t.amount)), name, raw: String(t.name || '').slice(0, 200), sig: sigOf(t.name || t.merchant_name),
        status: prev ? prev.status : (t.date < item.startOn ? 'history' : 'new')
      };
    }
    for (const tid of f.removed) {
      const p = st.tx[tid];
      if (p && ['new', 'review', 'history'].includes(p.status)) delete st.tx[tid];
    }
    item.cursor = f.cursor; item.lastSync = at; item.error = null; item.errorCode = '';
  }
  function prune(st) {
    const cut = addDay(localNow().date, -KEEP_DAYS);
    for (const [k, t] of Object.entries(st.tx)) if (t.date < cut) delete st.tx[k];
  }
  const trackedAccounts = st => Object.values(st.items).flatMap(i => Object.values(i.accounts).filter(a => a.tracked));

  /* Yesterday's closing balance, from the bank. Only when EVERY connection synced cleanly just now
     (a stale or broken one would give a wrong total), and never over a day already reconciled. */
  function autoReconcile(st) {
    const items = Object.values(st.items);
    if (!items.length || items.some(i => i.error || !i.lastSync || Date.now() - Date.parse(i.lastSync) > 3 * 36e5)) return null;
    const accts = trackedAccounts(st);
    if (!accts.length || accts.some(a => a.current == null)) return null;
    const D = addDay(localNow().date, -1);
    if (D < RANGE_START || D > RANGE_END || store.has(D)) return null;
    if (D < addDay(items.reduce((m, i) => i.startOn < m ? i.startOn : m, '9999-12-31'), -1)) return null;
    const ids = new Set(accts.map(a => a.id));
    let bal = accts.reduce((s, a) => s + a.current, 0);
    for (const t of Object.values(st.tx)) if (ids.has(t.account) && t.date > D) bal -= t.amount;
    const row = { date: D, actual: r2(bal), note: 'From the bank', source: 'bank', created_at: new Date().toISOString() };
    store.insert(row);
    st.lastReconciled = { date: D, actual: row.actual, at: row.created_at };
    return row;
  }

  let running = null;
  function syncAll() {
    if (running) return running;
    running = (async () => {
      const ids = Object.keys(load().items), fetched = {};
      for (const id of ids) {
        const item = load().items[id]; if (!item) continue;
        try { fetched[id] = await fetchItem(item); }
        catch (e) {
          fetched[id] = { error: e.code === 'ITEM_LOGIN_REQUIRED' ? 'The bank wants you to sign in again — tap Reconnect.' : (e.message || 'Sync failed.'),
                          errorCode: e.code || '' };
        }
      }
      let rec = null;
      store.tx(() => {
        const st = load();
        for (const [id, f] of Object.entries(fetched)) {
          if (f.error) { if (st.items[id]) { st.items[id].error = f.error; st.items[id].errorCode = f.errorCode; } }
          else applyFetch(st, id, f);
        }
        prune(st);
        st.lastRun = new Date().toISOString();
        if (LIVE) rec = autoReconcile(st);
        save(st);
      });
      return { reconciled: rec };
    })().finally(() => { running = null; });
    return running;
  }

  /* ---- what the page sees (never the token) ---- */
  function status(extra) {
    const st = load();
    const items = Object.values(st.items).map(i => ({
      id: i.id, institution: i.institution, startOn: i.startOn, lastSync: i.lastSync, error: i.error || null,
      relink: i.errorCode === 'ITEM_LOGIN_REQUIRED',
      accounts: Object.values(i.accounts).map(a => ({ id: a.id, name: a.name, mask: a.mask, subtype: a.subtype, tracked: a.tracked, current: a.current }))
    }));
    const tracked = new Set(trackedAccounts(st).map(a => a.id));
    const all = Object.values(st.tx).filter(t => tracked.has(t.account));
    const open = all.filter(t => t.status === 'new' || t.status === 'review').sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 300);
    const recent = all.filter(t => ['matched', 'extra', 'ignored'].includes(t.status) && t.decidedAt)
      .sort((a, b) => a.decidedAt < b.decidedAt ? 1 : -1).slice(0, 25);
    const claimed = all.filter(t => t.status === 'matched' && t.key).map(t => t.key);
    return { mode: MODE || null, ready: READY, live: LIVE, missing, syncHour: SYNC_HOUR, items,
             lastRun: st.lastRun, lastReconciled: st.lastReconciled, open, recent, claimed, rules: st.rules, ...(extra || {}) };
  }
  // Unplanned transactions you (or the matcher) accepted: the page draws them as their own lines.
  function extras() {
    if (!LIVE) return [];
    const st = load(), tracked = new Set(trackedAccounts(st).map(a => a.id));
    return Object.values(st.tx).filter(t => t.status === 'extra' && tracked.has(t.account) && t.date >= RANGE_START)
      .map(t => ({ id: t.id, date: t.date, amount: t.amount, name: t.name }));
  }

  /* ---- decisions from the page ----
     match  : the transaction is this projected line (key). `adjust`, when present, is the
              adjustment that makes the line say what the bank said (amount, day) — saved exactly as
              a PUT /api/adjustments would be, reconciled variances kept.
     extra  : not in the plan; drawn as its own line.
     ignore : not money in or out of the plan (a transfer between your own accounts).
     review : the matcher was not sure; `suggest` is its best guess. Waits for you.
     `learn` remembers the answer for this payee. `auto` decisions only apply to untouched (new)
     transactions, so two open devices cannot both act on one. */
  function decide(b) {
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 300) return { code: 400, body: { error: 'Nothing to save.' } };
    const saved = [], finalAct = new Map(), done = [];
    try {
      store.tx(() => {
        const st = load();
        const claimed = new Set(Object.values(st.tx).filter(t => t.status === 'matched' && t.key).map(t => t.key));
        for (const x of b.items) {
          const t = st.tx[String(x && x.id || '')]; if (!t) continue;
          if (x.auto ? t.status !== 'new' : !['new', 'review', 'extra', 'ignored'].includes(t.status)) continue;
          const at = new Date().toISOString();
          if (x.action === 'match') {
            const key = String(x.key || '');
            if (!KEY_RE.test(key) || claimed.has(key)) continue;
            if (x.adjust) {
              const p = parseAdjustment(x.adjust, key);
              if (p.error) throw new Error(p.error);
              const o = saveAdjustment(p.row, store.getAdjustment(key));
              o.shifted.forEach(s => finalAct.set(s.date, s.actual)); delete o.shifted; saved.push(o);
            }
            claimed.add(key);
            Object.assign(t, { status: 'matched', key, label: String(x.label || '').slice(0, 200), suggest: null, decidedAt: at, auto: !!x.auto });
            if (x.learn && t.sig && x.label) st.rules[t.sig] = String(x.label).slice(0, 200);
          } else if (x.action === 'extra' || x.action === 'ignore') {
            Object.assign(t, { status: x.action === 'extra' ? 'extra' : 'ignored', key: null, suggest: null, decidedAt: at, auto: !!x.auto });
            if (x.learn && t.sig) st.rules[t.sig] = x.action === 'extra' ? '*extra' : '*ignore';
          } else if (x.action === 'review') {
            const s = x.suggest && KEY_RE.test(String(x.suggest.key || '')) ? { key: x.suggest.key, label: String(x.suggest.label || '').slice(0, 200) } : null;
            Object.assign(t, { status: 'review', suggest: s });
          } else continue;
          done.push(t.id);
        }
        save(st);
      });
    } catch (e) { return { code: 400, body: { error: e.message || 'Could not save.' } }; }
    return { code: 200, body: { done, adjustments: saved, shifted: [...finalAct].map(([date, actual]) => ({ date, actual })), extras: extras() } };
  }

  /* ---- routes (the gate in server.js has already required a signed-in session) ---- */
  let lastLink = null;                       // resumes Link after a bank's OAuth redirect
  function routes(req, res, url) {
    const p = url.pathname, post = req.method === 'POST';
    const fail = (e, code) => json(res, code || 502, { error: e.message || 'The bank service did not answer.' });
    if (p === '/api/bank' && req.method === 'GET') return json(res, 200, status());
    if (!READY) return json(res, 503, { error: `Bank sync is not set up. Missing on the server: ${missing.join(', ')}.` });

    if (p === '/api/bank/link-token' && post) {
      return readBody(req, 4096, async b => {
        if (b && b.resume && lastLink && lastLink.exp > Date.now()) return json(res, 200, { link_token: lastLink.token });
        try {
          const redirect = env.PLAID_REDIRECT_URI || (LIVE ? rpFor(req).origin + '/plaid-oauth' : '');
          const update = b && b.item && load().items[b.item];        // reconnecting a broken connection
          const out = await plaid('/link/token/create', {
            client_name: 'Cash Flow', language: 'en', country_codes: ['US'], user: { client_user_id: 'cash-flow-owner' },
            ...(update ? { access_token: unseal(update.token) }
                       : { products: ['transactions'], transactions: { days_requested: 90 },
                           account_filters: { depository: { account_subtypes: ['checking', 'savings'] } } }),
            ...(redirect ? { redirect_uri: redirect } : {})
          });
          lastLink = { token: out.link_token, exp: Date.now() + 30 * 60 * 1000 };
          json(res, 200, { link_token: out.link_token });
        } catch (e) { fail(e); }
      });
    }
    if (p === '/api/bank/exchange' && post) {
      return readBody(req, 8192, async b => {
        if (!b || typeof b.public_token !== 'string') return json(res, 400, { error: 'Malformed request.' });
        try {
          const out = await plaid('/item/public_token/exchange', { public_token: b.public_token });
          store.tx(() => {
            const st = load();
            st.items[out.item_id] = { id: out.item_id, token: seal(out.access_token),
              institution: String(b.institution || 'Bank').slice(0, 80), cursor: '', accounts: {},
              // Matching starts a few days back so the transactions behind today's balance are in.
              startOn: addDay(localNow().date, -3), connectedAt: new Date().toISOString(), lastSync: null, error: null };
            save(st);
          });
          lastLink = null;
          const r = await syncAll();
          json(res, 200, status(r));
        } catch (e) { fail(e); }
      });
    }
    if (p === '/api/bank/sync' && post) {
      return readBody(req, 1024, async b => {
        const st = load();
        const age = st.lastRun ? Date.now() - Date.parse(st.lastRun) : Infinity;
        if (!Object.keys(st.items).length) return json(res, 200, status());
        if (age < (b && b.force ? 60e3 : 20 * 60e3)) return json(res, 200, status());
        try { const r = await syncAll(); json(res, 200, status(r)); } catch (e) { fail(e); }
      });
    }
    if (p === '/api/bank/accounts' && post) {
      return readBody(req, 1024, b => {
        if (!b) return json(res, 400, { error: 'Malformed request.' });
        store.tx(() => {
          const st = load();
          for (const i of Object.values(st.items)) if (i.accounts[b.id]) i.accounts[b.id].tracked = !!b.tracked;
          save(st);
        });
        json(res, 200, status());
      });
    }
    if (p === '/api/bank/disconnect' && post) {
      return readBody(req, 1024, async b => {
        const item = b && load().items[b.item];
        if (!item) return json(res, 404, { error: 'No such connection.' });
        try { await plaid('/item/remove', { access_token: unseal(item.token) }); } catch { /* removed here regardless */ }
        store.tx(() => {
          const st = load(); delete st.items[b.item];
          // Keep what was decided (the adjustments and extra lines stay true); drop the rest.
          for (const [k, t] of Object.entries(st.tx)) if (t.item === b.item && !['matched', 'extra'].includes(t.status)) delete st.tx[k];
          save(st);
        });
        json(res, 200, status());
      });
    }
    if (p === '/api/bank/decide' && post) {
      if (!LIVE) return json(res, 409, { error: 'Test mode: nothing is written to the planner.' });
      return readBody(req, 262144, b => {
        if (!b) return json(res, 400, { error: 'Malformed request.' });
        const r = decide(b); json(res, r.code, r.code === 200 ? { ...r.body, bank: status() } : r.body);
      });
    }
    return json(res, 404, { error: 'Not found.' });
  }

  // Nightly: once a day after SYNC_HOUR. Checked every 10 minutes; a restart just checks again.
  function schedule() {
    if (!READY) return;
    setInterval(() => {
      const n = localNow();
      if (n.hour < SYNC_HOUR) return;
      let go = false;
      store.tx(() => { const st = load(); if (Object.keys(st.items).length && st.lastNightly !== n.date) { st.lastNightly = n.date; save(st); go = true; } });
      if (go) syncAll().then(r => console.log('[bank] nightly sync', r.reconciled ? 'reconciled ' + r.reconciled.date : ''))
                       .catch(e => console.error('[bank] nightly sync failed:', e.message));
    }, 10 * 60 * 1000);
  }

  return { mode: READY ? MODE : null, routes, extras, schedule, _sigOf: sigOf };
};
