'use strict';
/**
 * Bank sync from the banks' own ALERT EMAILS — read-only, free, nothing in between but Gmail.
 *
 * The banks email a daily balance and one alert per transaction to a Gmail inbox used only for
 * them. Every 15 minutes (and when the app is opened) the server reads new mail over IMAP
 * (email.js), then:
 *   - a balance alert RECONCILES its day: the sum of the ticked accounts' balances for that day.
 *     Those rows are marked source 'bank' and never move when a transaction is adjusted — they
 *     are what the bank said, not a variance you typed.
 *   - a transaction alert is kept for the PAGE to match: matching needs the projection, which
 *     lives in the page, so it posts its decisions to /api/bank/decide (see "Bank" in index.html).
 *
 * It starts as a PREVIEW (reads, shows what it would do, writes nothing) until "Turn it on",
 * because the alert reader is pattern-based and should be checked against real alerts first.
 *
 * Env: ALERT_EMAIL, ALERT_EMAIL_PASSWORD (a Gmail app password),
 *      optional ALERT_IMAP_HOST / ALERT_IMAP_PORT / ALERT_IMAP_FOLDER / ALERT_IMAP_TLS=0 (tests).
 */
const mail = require('./email');

module.exports = function makeBank({ store, localNow, json, readBody, KEY_RE, parseAdjustment, saveAdjustment,
                                     RANGE_START, RANGE_END }) {
  const env = process.env;
  const missing = [!env.ALERT_EMAIL && 'ALERT_EMAIL', !env.ALERT_EMAIL_PASSWORD && 'ALERT_EMAIL_PASSWORD (a Gmail app password)'].filter(Boolean);
  const READY = !missing.length;
  const DOC = 'bank-email-alerts';
  const EVERY = 15 * 60e3;          // inbox check
  const KEEP_DAYS = 150;            // transactions older than this are dropped
  if (READY) console.log('[bank] reading alert emails sent to', env.ALERT_EMAIL);

  const addDay = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const r2 = n => Math.round(n * 100) / 100;
  const chi = (d, o) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', ...o }).format(d);
  const localDate = d => chi(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const localHour = d => +chi(d, { hour: '2-digit', hour12: false }) % 24;

  /* ---- state: one document ----
     { live, cursor:{uidValidity,lastUid}, startOn, lastRun, error, lastReconciled,
       accounts: {id: {id, name, mask, type, subtype, tracked, current}},
       balances: {account: {date: amount}},
       tx: {id: {id, account, date, amount (in = +), name, raw, sig, status, key?, label?, suggest?, decidedAt?}},
       rules: {sig: label | '*extra' | '*ignore'}, unread: [{subject, date, bank}] }
     status: history (before the start date; never matched) | new | review | matched | extra | ignored */
  function load() {
    const st = store.kvGet(DOC) || {};
    if (st.items) {                       // first version kept the inbox as a "connection"
      const i = st.items.email || {};
      Object.assign(st, { cursor: i.cursor || null, startOn: i.startOn, accounts: i.accounts || {} });
      delete st.items;
    }
    return { live: false, cursor: null, startOn: addDay(localNow().date, -3), lastRun: null, error: null, lastReconciled: null,
             accounts: {}, balances: {}, tx: {}, rules: {}, unread: [], ...st };
  }
  const save = st => store.kvSet(DOC, st);

  // A bank description reduced to what identifies the payee, so "ACH DEBIT ATT* BILL 10/07" and
  // next month's "ACH DEBIT ATT* BILL 11/07" share a rule.
  const NOISE = new Set(['ach', 'debit', 'credit', 'pos', 'purchase', 'payment', 'pmt', 'online', 'transfer', 'card',
    'recurring', 'web', 'id', 'ppd', 'ccd', 'co', 'inc', 'llc', 'the', 'des', 'indn', 'from', 'to', 'www', 'com',
    'checkcard', 'withdrawal', 'deposit', 'electronic', 'bill', 'autopay', 'auto', 'ref', 'trn', 'xx', 'xxxx']);
  const sigOf = s => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ')
    .filter(w => w.length > 1 && !NOISE.has(w)).slice(0, 4).join(' ');
  // Checking is what the planner tracks. An alert that does not say which kind of account is
  // assumed to be checking (debit-card and deposit alerts usually are).
  const defaultTracked = a => a.subtype === 'checking' || !a.subtype;
  const tracked = st => Object.values(st.accounts).filter(a => a.tracked).map(a => a.id);

  /* ---- reading the inbox ----
     The network part collects; the apply part runs synchronously on a FRESH copy of the state,
     so a decision the page posts while the mail server is answering is never overwritten. */
  async function readInbox(cursor) {
    const got = await mail.fetchNew({
      host: env.ALERT_IMAP_HOST || 'imap.gmail.com', port: Number(env.ALERT_IMAP_PORT || 993), secure: env.ALERT_IMAP_TLS !== '0',
      user: env.ALERT_EMAIL, pass: String(env.ALERT_EMAIL_PASSWORD).replace(/\s+/g, ''), folder: env.ALERT_IMAP_FOLDER || 'INBOX'
    }, cursor);
    const accounts = new Map(), txs = [], balances = [], unread = [];
    const acct = (bank, last4, type) => {
      const id = `${bank.toLowerCase().replace(/[^a-z]+/g, '')}-${last4 || 'main'}`;
      if (!accounts.has(id)) accounts.set(id, { id, name: bank + (type ? ' ' + type : ''), mask: last4 || '', subtype: type || '' });
      return id;
    };
    for (const m of got.messages) {
      let msg, a;
      try { msg = mail.parseMessage(m.raw); a = mail.readAlert(msg, { localDate, localHour, allowUnsigned: env.ALERT_ALLOW_UNSIGNED === '1' }); }
      catch { a = null; }
      if (!a) continue;                                         // not from a bank (or not signed by it)
      if (a.kind === 'unknown') unread.push({ subject: String(a.subject).slice(0, 140), date: a.date, bank: a.bank });
      else if (a.kind === 'balance') for (const x of a.accounts) balances.push({ account: acct(a.bank, x.last4, x.type), date: a.date, amount: x.balance });
      else txs.push({ id: mail.msgId(msg, m.uid), account: acct(a.bank, a.last4, a.type), date: a.date, amount: a.amount, name: a.name, raw: msg.subject });
    }
    return { cursor: got.cursor, accounts: [...accounts.values()], txs, balances, unread };
  }
  function apply(st, f) {
    for (const a of f.accounts) if (!st.accounts[a.id]) st.accounts[a.id] = { ...a, tracked: defaultTracked(a), current: null };
    for (const b of f.balances) {
      (st.balances[b.account] = st.balances[b.account] || {})[b.date] = b.amount;
      const days = Object.keys(st.balances[b.account]).sort();
      st.accounts[b.account].current = st.balances[b.account][days[days.length - 1]];
    }
    for (const t of f.txs) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.date)) || !Number.isFinite(t.amount)) continue;
      const prev = st.tx[t.id];
      st.tx[t.id] = { ...(prev || {}), id: t.id, account: t.account, date: t.date, amount: r2(t.amount),
        name: String(t.name || t.raw || 'Bank transaction').slice(0, 120), raw: String(t.raw || '').slice(0, 200),
        sig: sigOf(t.raw || t.name), status: prev ? prev.status : (t.date < st.startOn ? 'history' : 'new') };
    }
    if (f.unread.length) st.unread = [...f.unread.reverse(), ...st.unread].slice(0, 20);
    st.cursor = f.cursor; st.error = null;
    // Keep ~5 months of transactions and ~6 weeks of balances.
    const today = localNow().date;
    for (const [k, t] of Object.entries(st.tx)) if (t.date < addDay(today, -KEEP_DAYS)) delete st.tx[k];
    for (const days of Object.values(st.balances)) for (const d of Object.keys(days)) if (d < addDay(today, -40)) delete days[d];
  }

  /* A day is reconciled once every ticked account that reports balances has one for it (each
     balance alert says which day it closes — see readAlert). Never over a day already reconciled.
     `dry` lists what it WOULD do, for the preview. */
  function reconcileDays(st, dry) {
    const ids = tracked(st).filter(id => st.balances[id]);
    if (!ids.length) return [];
    const today = localNow().date, start = addDay(st.startOn, -1), rows = [];
    for (const D of [...new Set(ids.flatMap(id => Object.keys(st.balances[id])))].sort()) {
      if (D > today || D < start || D < RANGE_START || D > RANGE_END) continue;
      if (!ids.every(id => st.balances[id][D] != null)) continue;
      const actual = r2(ids.reduce((s, id) => s + st.balances[id][D], 0));
      if (dry) { rows.push({ date: D, actual, already: store.has(D) }); continue; }
      if (store.has(D)) continue;
      const row = { date: D, actual, note: 'From the bank (balance alert)', source: 'bank', created_at: new Date().toISOString() };
      store.insert(row); rows.push(row);
      st.lastReconciled = { date: D, actual, at: row.created_at };
    }
    return dry ? rows.slice(-5) : rows;
  }

  let running = null;
  function sync() {
    if (running) return running;
    running = (async () => {
      let f = null, err = null;
      try { f = await readInbox(load().cursor); } catch (e) { err = e.message || 'Could not read the alerts inbox.'; }
      let recs = [];
      store.tx(() => {
        const st = load();
        if (f) apply(st, f); else st.error = err;
        st.lastRun = new Date().toISOString();
        if (st.live) recs = reconcileDays(st);
        save(st);
      });
      return recs;
    })().finally(() => { running = null; });
    return running;
  }

  /* ---- what the page sees ---- */
  function status(reconciles) {
    const st = load(), mine = new Set(tracked(st));
    const all = Object.values(st.tx).filter(t => mine.has(t.account));
    return {
      ready: READY, missing, live: st.live, address: env.ALERT_EMAIL || '', lastRun: st.lastRun, error: st.error,
      lastReconciled: st.lastReconciled, unread: st.unread, would: st.live ? [] : reconcileDays(st, true),
      accounts: Object.values(st.accounts).map(a => ({ id: a.id, name: a.name, mask: a.mask, tracked: a.tracked, current: a.current })),
      open: all.filter(t => t.status === 'new' || t.status === 'review').sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 300),
      recent: all.filter(t => t.decidedAt).sort((a, b) => a.decidedAt < b.decidedAt ? 1 : -1).slice(0, 25),
      claimed: all.filter(t => t.status === 'matched' && t.key).map(t => t.key),
      rules: st.rules, reconciles: reconciles || []
    };
  }
  // Unplanned transactions you (or the matcher) accepted: the page draws them as their own lines.
  function extras() {
    const st = load(); if (!st.live) return [];
    const mine = new Set(tracked(st));
    return Object.values(st.tx).filter(t => t.status === 'extra' && mine.has(t.account) && t.date >= RANGE_START)
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
  function decide(items) {
    const saved = [], finalAct = new Map(), done = [];
    store.tx(() => {
      const st = load();
      const claimed = new Set(Object.values(st.tx).filter(t => t.status === 'matched' && t.key).map(t => t.key));
      for (const x of items) {
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
          Object.assign(t, { status: 'matched', key, label: String(x.label || '').slice(0, 200), suggest: null, decidedAt: at });
          if (x.learn && t.sig && x.label) st.rules[t.sig] = String(x.label).slice(0, 200);
        } else if (x.action === 'extra' || x.action === 'ignore') {
          Object.assign(t, { status: x.action === 'extra' ? 'extra' : 'ignored', key: null, suggest: null, decidedAt: at });
          if (x.learn && t.sig) st.rules[t.sig] = x.action === 'extra' ? '*extra' : '*ignore';
        } else if (x.action === 'review') {
          t.status = 'review';
          t.suggest = x.suggest && KEY_RE.test(String(x.suggest.key || '')) ? { key: x.suggest.key, label: String(x.suggest.label || '').slice(0, 200) } : null;
        } else continue;
        done.push(t.id);
      }
      save(st);
    });
    return { done, adjustments: saved, shifted: [...finalAct].map(([date, actual]) => ({ date, actual })), extras: extras() };
  }

  /* ---- routes (the gate in server.js has already required a signed-in session) ---- */
  function routes(req, res, url) {
    const p = url.pathname, post = req.method === 'POST';
    if (p === '/api/bank' && req.method === 'GET') return json(res, 200, status());
    if (!READY) return json(res, 503, { error: `Bank sync is not set up. Missing on the server: ${missing.join(', ')}.` });
    if (!post) return json(res, 404, { error: 'Not found.' });
    readBody(req, 262144, async b => {
      if (!b) return json(res, 400, { error: 'Malformed request.' });
      if (p === '/api/bank/sync') {
        const st = load(), age = st.lastRun ? Date.now() - Date.parse(st.lastRun) : Infinity;
        return json(res, 200, status(age < (b.force ? 30e3 : 2 * 60e3) ? [] : await sync()));
      }
      if (p === '/api/bank/accounts') {
        store.tx(() => { const st = load(); if (st.accounts[b.id]) st.accounts[b.id].tracked = !!b.tracked; save(st); });
        return json(res, 200, status());
      }
      // Leave the preview and start writing (or go back to the preview).
      if (p === '/api/bank/live') {
        let recs = [];
        store.tx(() => { const st = load(); st.live = !!b.on; if (st.live) recs = reconcileDays(st); save(st); });
        return json(res, 200, status(recs));
      }
      if (p === '/api/bank/decide') {
        if (!load().live) return json(res, 409, { error: 'Preview: nothing is written to the planner yet.' });
        if (!Array.isArray(b.items) || !b.items.length || b.items.length > 300) return json(res, 400, { error: 'Nothing to save.' });
        try { return json(res, 200, { ...decide(b.items), bank: status() }); }
        catch (e) { return json(res, 400, { error: e.message || 'Could not save.' }); }
      }
      json(res, 404, { error: 'Not found.' });
    });
  }

  function schedule() {
    if (!READY) return;
    const tick = () => sync().then(r => { if (r.length) console.log('[bank] reconciled', r.map(x => x.date).join(', ')); })
                             .catch(e => console.error('[bank] inbox check failed:', e.message));
    setTimeout(tick, 5000); setInterval(tick, EVERY);
  }

  return { mode: READY ? 'email-alerts' : null, routes, extras, schedule };
};
