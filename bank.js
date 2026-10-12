'use strict';
/**
 * Bank sync — READ-ONLY (posted transactions and balances). Nothing here can move money.
 *
 * Three sources, chosen by which variables are set (first match wins):
 *   Email (ALERT_EMAIL) — the banks' own alert emails, read from a Gmail inbox used only for
 *     them (see email.js). Free, no data company in between. Starts as a PREVIEW; "Turn on" in
 *     the app makes it write.
 *   Teller (TELLER_APP_ID) — its "development" environment is real bank data, free up to 100
 *     connections. Requests carry Teller's client certificate (mTLS) plus the connection's token.
 *   Plaid (PLAID_CLIENT_ID + a secret) — kept as an alternative; billed once in production.
 *
 *   - The bank login happens on the bank's own page inside Teller Connect / Plaid Link; the
 *     planner never sees a password. What it keeps is the access token, sealed with AES-256-GCM
 *     under BANK_TOKEN_KEY (a Railway variable, not on the volume), and it never leaves the server.
 *   - The server syncs nightly (BANK_SYNC_HOUR, default 20:00 America/Chicago) and when the app is
 *     opened (at most every 20 minutes). After each sync it RECONCILES YESTERDAY from the bank:
 *     closing balance = today's ledger balance − every posted transaction dated after yesterday.
 *     Those reconciles are marked source 'bank' and never move when a transaction is adjusted —
 *     they are what the bank said, not a variance you typed.
 *   - Matching transactions to the projection needs the projection, which lives in the page, so
 *     the PAGE matches and posts its decisions to /api/bank/decide (see "Bank" in index.html).
 *
 * A sandbox (TELLER_ENV=sandbox, or Plaid with only PLAID_SANDBOX_SECRET) is a dry run: it syncs
 * a test bank and the page shows what it WOULD do, but nothing is written to the planner.
 *
 * Env (Teller): TELLER_APP_ID, TELLER_CERT + TELLER_KEY (the PEM files from Teller's dashboard,
 *      pasted whole or base64), TELLER_ENV (development | sandbox | production; default development)
 * Env (Plaid):  PLAID_CLIENT_ID, PLAID_SECRET / PLAID_SANDBOX_SECRET, optional PLAID_ENV, PLAID_REDIRECT_URI
 * Both: BANK_TOKEN_KEY (16+ characters), optional BANK_SYNC_HOUR.
 */
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const mail = require('./email');

module.exports = function makeBank({ store, localNow, json, readBody, KEY_RE, parseAdjustment, saveAdjustment,
                                     rpFor, RANGE_START, RANGE_END }) {
  const env = process.env;
  const KEY = env.BANK_TOKEN_KEY && env.BANK_TOKEN_KEY.length >= 16
    ? crypto.createHash('sha256').update(env.BANK_TOKEN_KEY).digest() : null;
  const PROVIDER = env.ALERT_EMAIL ? 'email' : env.TELLER_APP_ID ? 'teller'
    : (env.PLAID_CLIENT_ID || env.PLAID_SECRET || env.PLAID_SANDBOX_SECRET) ? 'plaid' : null;
  // A PEM pasted into a Railway variable, whole (real or \n newlines) or base64-encoded.
  const pem = v => !v ? '' : /BEGIN/.test(v) ? String(v).replace(/\\n/g, '\n') : Buffer.from(String(v), 'base64').toString('utf8');
  let MODE = null, missing, SECRET = '', CLIENT = '', BASE = '', T_CERT = '', T_KEY = '';
  if (PROVIDER === 'email') {
    MODE = 'alerts';
    missing = [!env.ALERT_EMAIL_PASSWORD && 'ALERT_EMAIL_PASSWORD (a Gmail app password)'].filter(Boolean);
  } else if (PROVIDER === 'teller') {
    MODE = String(env.TELLER_ENV || 'development').toLowerCase();
    T_CERT = pem(env.TELLER_CERT); T_KEY = pem(env.TELLER_KEY);
    BASE = env.TELLER_BASE || 'https://api.teller.io';
    missing = [!['sandbox', 'development', 'production'].includes(MODE) && 'TELLER_ENV (development, sandbox or production)',
               MODE !== 'sandbox' && !T_CERT && 'TELLER_CERT', MODE !== 'sandbox' && !T_KEY && 'TELLER_KEY',
               !KEY && 'BANK_TOKEN_KEY (at least 16 characters)'].filter(Boolean);
  } else if (PROVIDER === 'plaid') {
    MODE = String(env.PLAID_ENV || (env.PLAID_SECRET ? 'production' : 'sandbox')).toLowerCase();
    SECRET = MODE === 'production' ? env.PLAID_SECRET || '' : env.PLAID_SANDBOX_SECRET || '';
    CLIENT = env.PLAID_CLIENT_ID || '';
    BASE = env.PLAID_BASE || `https://${MODE}.plaid.com`;
    missing = [!CLIENT && 'PLAID_CLIENT_ID', !SECRET && (MODE === 'sandbox' ? 'PLAID_SANDBOX_SECRET' : 'PLAID_SECRET'),
               !KEY && 'BANK_TOKEN_KEY (at least 16 characters)'].filter(Boolean);
  } else missing = ['ALERT_EMAIL', 'ALERT_EMAIL_PASSWORD'];
  const READY = !!PROVIDER && !missing.length;
  const LIVE0 = READY && MODE !== 'sandbox';            // only real bank data writes to the planner
  // Email starts as a preview until you turn it on (st.live), since its reader is pattern-based.
  const isLive = st => LIVE0 && (PROVIDER !== 'email' || !!(st || load()).live);
  const EMAIL_EVERY = 15 * 60e3;
  const DOC = `bank-${PROVIDER}-${MODE}`;               // providers and environments never share data
  const SYNC_HOUR = Number(env.BANK_SYNC_HOUR ?? 20);
  const KEEP_DAYS = 150;                                // transactions older than this are dropped
  if (PROVIDER && !READY) console.warn('[bank]', PROVIDER, 'not configured — missing', missing.join(', '));
  else if (READY) console.log('[bank]', PROVIDER, MODE, LIVE0 ? '' : '(dry run)');

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

  // Teller: client certificate (mTLS) on every request, the connection's token as Basic auth.
  const tAgentOpts = T_CERT && T_KEY ? { cert: T_CERT, key: T_KEY } : {};
  const tAgent = PROVIDER === 'teller' && /^https:/.test(BASE) ? new https.Agent({ ...tAgentOpts, keepAlive: true }) : undefined;
  function teller(method, p, token) {
    const u = new URL(p, BASE), mod = u.protocol === 'https:' ? https : http;
    return new Promise((ok, no) => {
      const r = mod.request(u, { method, agent: tAgent, auth: token + ':', headers: { Accept: 'application/json' }, timeout: 30000 }, res => {
        let b = ''; res.on('data', c => { b += c; }); res.on('end', () => {
          let j; try { j = b ? JSON.parse(b) : {}; } catch { j = {}; }
          if (res.statusCode >= 400) {
            const e = new Error((j.error && j.error.message) || `Teller error ${res.statusCode}`);
            e.code = (j.error && j.error.code) || String(res.statusCode); return no(e);
          }
          ok(j);
        });
      });
      r.on('timeout', () => r.destroy(new Error('The bank service timed out.')));
      r.on('error', no); r.end();
    });
  }
  // Checking is what the planner tracks. An alert that does not say which kind of account is
  // assumed to be checking (debit-card and deposit alerts usually are).
  const defaultTracked = a => a.type === 'depository' && (a.subtype === 'checking' || (PROVIDER === 'email' && !a.subtype));
  async function fetchTeller(item) {
    const token = unseal(item.token);
    const list = await teller('GET', '/accounts', token);
    const accounts = [], upserts = [];
    for (const a of list) {
      const prev = item.accounts[a.id];
      const acc = { id: a.id, name: a.name || 'Account', mask: a.last_four || '', type: a.type || '', subtype: a.subtype || '' };
      // Balances and transactions only for the accounts the planner tracks: fewer calls to the bank.
      if (prev ? prev.tracked : defaultTracked(acc)) {
        const b = await teller('GET', `/accounts/${encodeURIComponent(a.id)}/balances`, token);
        acc.current = b.ledger != null ? Number(b.ledger) : null;
        acc.available = b.available != null ? Number(b.available) : null;
        const txs = await teller('GET', `/accounts/${encodeURIComponent(a.id)}/transactions?count=${item.cursor ? 100 : 250}`, token);
        for (const t of txs) upserts.push({ id: t.id, account: a.id, date: t.date, amount: Number(t.amount),   // already signed: out < 0
          name: (t.details && t.details.counterparty && t.details.counterparty.name) || t.description, raw: t.description,
          pending: t.status === 'pending' });
      }
      accounts.push(acc);
    }
    return { cursor: 'teller', upserts, removed: [], accounts };
  }

  /* ---- sync ----
     The network part collects; the apply part runs synchronously on a FRESH copy of the state,
     so a decision the page posts while Plaid is answering is never overwritten. */
  const fetchItem = item => PROVIDER === 'email' ? fetchEmail(item) : PROVIDER === 'teller' ? fetchTeller(item) : fetchPlaid(item);
  const chi = (d, o) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', ...o }).format(d);
  const localDate = d => chi(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const localHour = d => +chi(d, { hour: '2-digit', hour12: false }) % 24;
  const slug = s => String(s).toLowerCase().replace(/[^a-z]+/g, '');
  async function fetchEmail(item) {
    const host = env.ALERT_IMAP_HOST || 'imap.gmail.com';
    const got = await mail.fetchNew({ host, port: Number(env.ALERT_IMAP_PORT || 993), secure: env.ALERT_IMAP_TLS !== '0',
      user: env.ALERT_EMAIL, pass: String(env.ALERT_EMAIL_PASSWORD).replace(/\s+/g, ''), folder: env.ALERT_IMAP_FOLDER || 'INBOX' },
      item.cursor && typeof item.cursor === 'object' ? item.cursor : null);
    const accounts = new Map(), upserts = [], balances = [], unread = [];
    const acct = (bank, last4, type) => {
      const id = `${slug(bank)}-${last4 || 'main'}`;
      if (!accounts.has(id)) accounts.set(id, { id, name: `${bank}${type ? ' ' + type : ''}`, mask: last4 || '', type: type === 'credit' ? 'credit' : 'depository', subtype: type || '' });
      return id;
    };
    for (const m of got.messages) {
      let a;
      try { a = mail.readAlert(mail.parseMessage(m.raw), { localDate, localHour, allowUnsigned: env.ALERT_ALLOW_UNSIGNED === '1' }); }
      catch { a = null; }
      if (!a) continue;                                         // not from a bank (or not signed by it)
      if (a.kind === 'unknown') { unread.push({ subject: String(a.subject).slice(0, 140), date: a.date, bank: a.bank }); continue; }
      if (a.kind === 'balance') { for (const x of a.accounts) balances.push({ account: acct(a.bank, x.last4, x.type), date: a.date, amount: x.balance }); continue; }
      const msg = mail.parseMessage(m.raw);
      upserts.push({ id: mail.msgId(msg, m.uid), account: acct(a.bank, a.last4, a.type), date: a.date, amount: a.amount, name: a.name, raw: msg.subject });
    }
    // A balance read becomes the account's current figure.
    for (const b of balances) { const x = accounts.get(b.account); if (!x.balDate || b.date >= x.balDate) { x.current = b.amount; x.balDate = b.date; } }
    return { cursor: got.cursor, upserts, removed: [], accounts: [...accounts.values()], balances, unread };
  }
  async function fetchPlaid(item) {
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
    return { cursor, removed: removed.map(r => r.transaction_id),
      // Plaid's amounts are positive for money OUT; the planner's are positive for money in.
      upserts: [...added, ...modified].map(t => ({ id: t.transaction_id, account: t.account_id, date: t.date, amount: -Number(t.amount),
        name: t.merchant_name || t.name, raw: t.name, pending: t.pending })),
      accounts: (acc.accounts || []).map(a => ({ id: a.account_id, name: a.name || a.official_name || 'Account', mask: a.mask || '',
        type: a.type || '', subtype: a.subtype || '',
        current: a.balances && Number.isFinite(a.balances.current) ? a.balances.current : null,
        available: a.balances && Number.isFinite(a.balances.available) ? a.balances.available : null })) };
  }
  function applyFetch(st, id, f) {
    const item = st.items[id]; if (!item) return;            // disconnected meanwhile
    const at = new Date().toISOString();
    for (const a of f.accounts) {
      const prev = item.accounts[a.id];
      item.accounts[a.id] = { ...a,
        // Checking is what the planner tracks; anything else is opt-in.
        tracked: prev ? prev.tracked : defaultTracked(a),
        current: a.current !== undefined ? a.current : prev ? prev.current : null,
        available: a.available !== undefined ? a.available : prev ? prev.available : null,
        asOf: a.current !== undefined ? at : prev ? prev.asOf : null };
    }
    for (const t of f.upserts) {
      if (t.pending || !t.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(t.date)) || !Number.isFinite(t.amount)) continue;  // posted only
      const prev = st.tx[t.id];
      st.tx[t.id] = {
        ...(prev || {}), id: t.id, item: id, account: t.account, date: t.date, amount: r2(t.amount),
        name: String(t.name || t.raw || 'Bank transaction').slice(0, 120), raw: String(t.raw || '').slice(0, 200),
        sig: sigOf(t.raw || t.name), status: prev ? prev.status : (t.date < item.startOn ? 'history' : 'new')
      };
    }
    for (const tid of f.removed) {
      const p = st.tx[tid];
      if (p && ['new', 'review', 'history'].includes(p.status)) delete st.tx[tid];
    }
    for (const b of f.balances || []) ((st.balances = st.balances || {})[b.account] = st.balances[b.account] || {})[b.date] = b.amount;
    if (f.unread && f.unread.length) st.unread = [...f.unread.reverse(), ...(st.unread || [])].slice(0, 20);
    item.cursor = f.cursor; item.lastSync = at; item.error = null; item.errorCode = '';
  }
  function prune(st) {
    const cut = addDay(localNow().date, -KEEP_DAYS);
    for (const [k, t] of Object.entries(st.tx)) if (t.date < cut) delete st.tx[k];
    for (const days of Object.values(st.balances || {})) for (const d of Object.keys(days)) if (d < addDay(localNow().date, -40)) delete days[d];
  }
  const trackedAccounts = st => Object.values(st.items).flatMap(i => Object.values(i.accounts).filter(a => a.tracked));

  /* Yesterday's closing balance, from the bank. Only when EVERY connection synced cleanly just now
     (a stale or broken one would give a wrong total), and never over a day already reconciled. */
  /* Email: a day is reconciled when every tracked account that reports balances has one for that
     day. Each balance alert says which day it closes (see readAlert). Returns the rows it added. */
  function emailReconcile(st) {
    const today = localNow().date, ids = trackedAccounts(st).map(a => a.id).filter(id => st.balances && st.balances[id]);
    if (!ids.length) return [];
    const start = addDay(Object.values(st.items).reduce((m, i) => i.startOn < m ? i.startOn : m, '9999-12-31'), -1);
    const days = new Set(ids.flatMap(id => Object.keys(st.balances[id])));
    const rows = [];
    for (const D of [...days].sort()) {
      if (D > today || D < start || D < RANGE_START || D > RANGE_END || store.has(D)) continue;
      if (!ids.every(id => st.balances[id][D] != null)) continue;
      const row = { date: D, actual: r2(ids.reduce((s, id) => s + st.balances[id][D], 0)), note: 'From the bank (balance alert)',
                    source: 'bank', created_at: new Date().toISOString() };
      store.insert(row); rows.push(row);
      st.lastReconciled = { date: D, actual: row.actual, at: row.created_at };
    }
    return rows;
  }
  // What the email reconcile WOULD do, for the preview.
  function emailWould(st) {
    const ids = trackedAccounts(st).map(a => a.id).filter(id => st.balances && st.balances[id]);
    if (!ids.length) return [];
    const days = [...new Set(ids.flatMap(id => Object.keys(st.balances[id])))].sort().slice(-5);
    return days.filter(D => ids.every(id => st.balances[id][D] != null))
      .map(D => ({ date: D, actual: r2(ids.reduce((s, id) => s + st.balances[id][D], 0)), already: store.has(D) }));
  }

  function autoReconcile(st) {
    const items = Object.values(st.items);
    if (!items.length || items.some(i => i.error || !i.lastSync || Date.now() - Date.parse(i.lastSync) > 3 * 36e5)) return null;
    const accts = trackedAccounts(st);
    if (!accts.length || accts.some(a => a.current == null || !a.asOf || Date.now() - Date.parse(a.asOf) > 3 * 36e5)) return null;
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
      if (PROVIDER === 'email') store.tx(() => {         // one standing "connection": the inbox
        const st = load();
        if (!st.items.email) { st.items.email = { id: 'email', institution: 'Bank alert emails', cursor: null, accounts: {},
          startOn: addDay(localNow().date, -3), connectedAt: new Date().toISOString(), lastSync: null, error: null }; save(st); }
      });
      const ids = Object.keys(load().items), fetched = {};
      for (const id of ids) {
        const item = load().items[id]; if (!item) continue;
        try { fetched[id] = await fetchItem(item); }
        catch (e) {
          const relink = /ITEM_LOGIN_REQUIRED|disconnected|mfa|credentials|login/i.test(e.code || '');
          fetched[id] = { error: relink ? 'The bank wants you to sign in again — tap Reconnect.' : (e.message || 'Sync failed.'),
                          errorCode: relink ? 'relink' : (e.code || '') };
        }
      }
      let rec = null, recs = [];
      store.tx(() => {
        const st = load();
        for (const [id, f] of Object.entries(fetched)) {
          if (f.error) { if (st.items[id]) { st.items[id].error = f.error; st.items[id].errorCode = f.errorCode; } }
          else applyFetch(st, id, f);
        }
        prune(st);
        st.lastRun = new Date().toISOString();
        if (isLive(st)) { if (PROVIDER === 'email') { recs = emailReconcile(st); rec = recs[recs.length - 1] || null; } else { rec = autoReconcile(st); recs = rec ? [rec] : []; } }
        save(st);
      });
      return { reconciled: rec, reconciles: recs };
    })().finally(() => { running = null; });
    return running;
  }

  /* ---- what the page sees (never the token) ---- */
  function status(extra) {
    const st = load();
    const items = Object.values(st.items).map(i => ({
      id: i.id, institution: i.institution, startOn: i.startOn, lastSync: i.lastSync, error: i.error || null,
      relink: i.errorCode === 'relink',
      accounts: Object.values(i.accounts).map(a => ({ id: a.id, name: a.name, mask: a.mask, subtype: a.subtype, tracked: a.tracked, current: a.current }))
    }));
    const tracked = new Set(trackedAccounts(st).map(a => a.id));
    const all = Object.values(st.tx).filter(t => tracked.has(t.account));
    const open = all.filter(t => t.status === 'new' || t.status === 'review').sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 300);
    const recent = all.filter(t => ['matched', 'extra', 'ignored'].includes(t.status) && t.decidedAt)
      .sort((a, b) => a.decidedAt < b.decidedAt ? 1 : -1).slice(0, 25);
    const claimed = all.filter(t => t.status === 'matched' && t.key).map(t => t.key);
    return { provider: PROVIDER, mode: MODE, ready: READY, live: isLive(st), missing, syncHour: SYNC_HOUR, items,
             address: PROVIDER === 'email' ? env.ALERT_EMAIL : undefined, unread: st.unread || [],
             would: PROVIDER === 'email' && !isLive(st) ? emailWould(st) : [],
             appId: PROVIDER === 'teller' ? env.TELLER_APP_ID : undefined,
             lastRun: st.lastRun, lastReconciled: st.lastReconciled, open, recent, claimed, rules: st.rules, ...(extra || {}) };
  }
  // Unplanned transactions you (or the matcher) accepted: the page draws them as their own lines.
  function extras() {
    if (!isLive()) return [];
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

    if (p === '/api/bank/link-token' && post && PROVIDER === 'plaid') {
      return readBody(req, 4096, async b => {
        if (b && b.resume && lastLink && lastLink.exp > Date.now()) return json(res, 200, { link_token: lastLink.token });
        try {
          const redirect = env.PLAID_REDIRECT_URI || (LIVE0 ? rpFor(req).origin + '/plaid-oauth' : '');
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
        const ok = PROVIDER === 'teller' ? b && /^[\w-]{8,200}$/.test(String(b.access_token || '')) && /^[\w-]{3,200}$/.test(String(b.enrollment_id || ''))
                                         : b && typeof b.public_token === 'string';
        if (!ok) return json(res, 400, { error: 'Malformed request.' });
        try {
          // Teller Connect hands the token to the page, which passes it straight here; Plaid's has to be exchanged.
          const out = PROVIDER === 'teller' ? { item_id: String(b.enrollment_id), access_token: String(b.access_token) }
                                            : await plaid('/item/public_token/exchange', { public_token: b.public_token });
          const existing = load().items[out.item_id];
          store.tx(() => {
            const st = load();
            // Reconnecting keeps the connection's accounts, start date and history.
            st.items[out.item_id] = existing ? { ...st.items[out.item_id], token: seal(out.access_token), error: null, errorCode: '' }
              : { id: out.item_id, token: seal(out.access_token),
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
        if (!Object.keys(st.items).length && PROVIDER !== 'email') return json(res, 200, status());
        if (age < (b && b.force ? 60e3 : PROVIDER === 'email' ? 2 * 60e3 : 20 * 60e3)) return json(res, 200, status());
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
        try {
          if (PROVIDER === 'teller') for (const a of Object.keys(item.accounts)) await teller('DELETE', `/accounts/${encodeURIComponent(a)}`, unseal(item.token));
          else await plaid('/item/remove', { access_token: unseal(item.token) });
        } catch { /* removed here regardless */ }
        store.tx(() => {
          const st = load(); delete st.items[b.item];
          // Keep what was decided (the adjustments and extra lines stay true); drop the rest.
          for (const [k, t] of Object.entries(st.tx)) if (t.item === b.item && !['matched', 'extra'].includes(t.status)) delete st.tx[k];
          save(st);
        });
        json(res, 200, status());
      });
    }
    // Email: leave the preview and start writing (or go back to the preview).
    if (p === '/api/bank/live' && post && PROVIDER === 'email') {
      return readBody(req, 1024, b => {
        let recs = [];
        store.tx(() => { const st = load(); st.live = !!(b && b.on); if (st.live) recs = emailReconcile(st); save(st); });
        json(res, 200, status({ reconciles: recs, reconciled: recs[recs.length - 1] || null }));
      });
    }
    if (p === '/api/bank/decide' && post) {
      if (!isLive()) return json(res, 409, { error: 'Preview: nothing is written to the planner yet.' });
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
    // Email: the inbox is checked every 15 minutes, all day (it costs nothing).
    if (PROVIDER === 'email') {
      const tick = () => syncAll().then(r => { if (r.reconciles.length) console.log('[bank] reconciled', r.reconciles.map(x => x.date).join(', ')); })
                                 .catch(e => console.error('[bank] email check failed:', e.message));
      setTimeout(tick, 5000); setInterval(tick, EMAIL_EVERY);
      return;
    }
    setInterval(() => {
      const n = localNow();
      if (n.hour < SYNC_HOUR) return;
      let go = false;
      store.tx(() => { const st = load(); if (Object.keys(st.items).length && st.lastNightly !== n.date) { st.lastNightly = n.date; save(st); go = true; } });
      if (go) syncAll().then(r => console.log('[bank] nightly sync', r.reconciled ? 'reconciled ' + r.reconciled.date : ''))
                       .catch(e => console.error('[bank] nightly sync failed:', e.message));
    }, 10 * 60 * 1000);
  }

  return { mode: READY ? `${PROVIDER}-${MODE}` : null, routes, extras, schedule, _sigOf: sigOf };
};
