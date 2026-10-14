'use strict';
/**
 * Bank alert emails → transactions and balances. No dependencies: a minimal IMAP client over
 * node:tls (LOGIN, SELECT, UID SEARCH, UID FETCH BODY.PEEK[] — it never deletes, moves or even
 * marks a message read), a MIME decoder, and a reader for the alerts Wells Fargo and Chase send.
 *
 * Only messages FROM a bank domain whose DKIM signature Gmail verified (Authentication-Results:
 * dkim=pass for that domain) are read, so a spoofed "balance" email cannot set your balance.
 *
 * ⚠️ The reader is pattern-based. Bank alert wording varies and changes; anything it cannot read
 * is kept as "unread" (subject and date only) so it can be taught — see readAlert.
 */
const tls = require('node:tls');
const net = require('node:net');
const crypto = require('node:crypto');

/* ------------------------- IMAP ------------------------- */
function imapConnect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = Buffer.alloc(0), greeted = false, cur = null, seq = 0;
    const responses = [];                         // untagged responses of the running command
    sock.setTimeout(60000, () => sock.destroy(new Error('The mail server timed out.')));
    sock.on('error', e => { if (cur) cur.reject(e); else reject(e); });
    sock.on('data', d => { buf = Buffer.concat([buf, d]); pump(); });
    // One response = a line, plus any {n} literals it announces (each followed by more line).
    function pump() {
      for (;;) {
        let pos = 0, text = '', lits = [];
        for (;;) {
          const crlf = buf.indexOf('\r\n', pos); if (crlf < 0) return;
          const line = buf.subarray(pos, crlf).toString('latin1');
          const m = /\{(\d+)\}$/.exec(line);
          if (!m) { text += line; pos = crlf + 2; break; }
          const n = +m[1], start = crlf + 2;
          if (buf.length < start + n) return;                 // wait for the whole literal
          text += line; lits.push(buf.subarray(start, start + n)); pos = start + n;
        }
        buf = buf.subarray(pos);
        handle(text, lits);
      }
    }
    function handle(text, lits) {
      if (!greeted) {
        greeted = true;
        if (!/^\* (OK|PREAUTH)/i.test(text)) return reject(new Error('Unexpected mail server greeting.'));
        return resolve(api);
      }
      if (cur && text.startsWith(cur.tag + ' ')) {
        const c = cur; cur = null;
        if (/^\S+ OK/i.test(text)) c.resolve(responses.splice(0));
        else { responses.length = 0; c.reject(new Error(text.replace(/^\S+ (NO|BAD)\s*/i, '') || 'Mail server refused.')); }
      } else responses.push({ text, lits });
    }
    const api = {
      cmd(s) {
        return new Promise((res, rej) => {
          const tag = 'A' + (++seq); cur = { tag, resolve: res, reject: rej };
          sock.write(`${tag} ${s}\r\n`);
        });
      },
      end() { try { sock.write('Z LOGOUT\r\n'); } catch { /* closing anyway */ } sock.end(); }
    };
  });
}
const q = s => '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';
const imapDate = d => { const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getUTCDate()}-${m[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };

/* New messages since `lastUid` (or the last `days` days on the first run). */
async function fetchNew(cfg, cursor, { days = 10, max = 200 } = {}) {
  const c = await imapConnect(cfg);
  try {
    await c.cmd(`LOGIN ${q(cfg.user)} ${q(cfg.pass)}`);
    const sel = await c.cmd(`SELECT ${q(cfg.folder || 'INBOX')}`);
    const uv = (sel.map(r => /UIDVALIDITY (\d+)/i.exec(r.text)).find(Boolean) || [])[1] || '';
    const fresh = !cursor || cursor.uidValidity !== uv;          // a reset mailbox starts over
    const search = fresh ? await c.cmd(`UID SEARCH SINCE ${imapDate(new Date(Date.now() - days * 864e5))}`)
                         : await c.cmd(`UID SEARCH UID ${cursor.lastUid + 1}:*`);
    let uids = search.flatMap(r => /^\* SEARCH/i.test(r.text) ? r.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number) : []);
    if (!fresh) uids = uids.filter(u => u > cursor.lastUid);   // "n:*" always returns the newest one
    uids = uids.sort((a, b) => a - b).slice(-max);
    const messages = [];
    for (let i = 0; i < uids.length; i += 25) {
      const set = uids.slice(i, i + 25).join(',');
      const out = await c.cmd(`UID FETCH ${set} (UID BODY.PEEK[])`);
      for (const r of out) {
        const u = /UID (\d+)/i.exec(r.text);
        if (u && r.lits.length) messages.push({ uid: +u[1], raw: r.lits[r.lits.length - 1] });
      }
    }
    const lastUid = Math.max(fresh ? 0 : cursor.lastUid, ...uids, 0);
    return { cursor: { uidValidity: uv, lastUid }, messages };
  } finally { c.end(); }
}

/* ------------------------- MIME ------------------------- */
function splitHead(buf) {
  const s = buf.toString('latin1'), i = s.search(/\r?\n\r?\n/);
  const head = i < 0 ? s : s.slice(0, i), body = i < 0 ? '' : s.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(l => {
    const k = l.indexOf(':'); if (k <= 0) return;
    const name = l.slice(0, k).trim().toLowerCase(), v = l.slice(k + 1).trim();
    headers[name] = headers[name] ? headers[name] + '\n' + v : v;
  });
  return { headers, body };
}
const param = (h, p) => { const m = new RegExp(p + '\\s*=\\s*"?([^";]+)"?', 'i').exec(h || ''); return m ? m[1] : ''; };
function decodeBody(body, enc, charset) {
  let b;
  enc = String(enc || '').toLowerCase();
  if (enc === 'base64') b = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable')
    b = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  else b = Buffer.from(body, 'latin1');
  return /^(us-ascii|iso-8859-1|latin1|windows-1252)$/i.test(charset || '') ? b.toString('latin1') : b.toString('utf8');
}
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([QB])\?([^?]*)\?=/gi, (_, cs, e, t) => e.toUpperCase() === 'B'
    ? decodeBody(t, 'base64', cs) : decodeBody(t.replace(/_/g, ' '), 'quoted-printable', cs));
}
function htmlText(h) {
  return h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n').replace(/<\/t[dh]>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function textOf(part, depth = 0) {
  const ct = part.headers['content-type'] || 'text/plain';
  if (/^multipart\//i.test(ct) && depth < 6) {
    const bnd = param(ct, 'boundary'); if (!bnd) return { plain: '', html: '' };
    const out = { plain: '', html: '' };
    for (const chunk of part.body.split('--' + bnd).slice(1)) {
      if (/^--/.test(chunk)) break;
      const p = splitHead(Buffer.from(chunk.replace(/^\r?\n/, ''), 'latin1')), t = textOf(p, depth + 1);
      out.plain += t.plain; out.html += t.html;
    }
    return out;
  }
  const text = decodeBody(part.body, part.headers['content-transfer-encoding'], param(ct, 'charset'));
  return /^text\/html/i.test(ct) ? { plain: '', html: text } : /^text\//i.test(ct) ? { plain: text, html: '' } : { plain: '', html: '' };
}
function parseMessage(raw) {
  const top = splitHead(raw), t = textOf(top);
  const text = (t.plain.trim() ? t.plain : htmlText(t.html)).replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { headers: top.headers, subject: decodeWords(top.headers.subject), from: decodeWords(top.headers.from), text };
}

/* ------------------------- reading an alert ------------------------- */
const BANKS = [{ name: 'Wells Fargo', domain: 'wellsfargo.com' }, { name: 'Chase', domain: 'chase.com' }];
// The sender is a bank AND Gmail verified the bank's DKIM signature.
function bankOf(msg, allowUnsigned) {
  const from = (msg.from.match(/@([\w.-]+)/) || [])[1] || '';
  const bank = BANKS.find(b => from.toLowerCase() === b.domain || from.toLowerCase().endsWith('.' + b.domain));
  if (!bank) return null;
  const auth = String(msg.headers['authentication-results'] || '').toLowerCase();
  const signed = new RegExp(`dkim=pass[^;]*header\\.(i|d)=@?([\\w.-]*\\.)?${bank.domain.replace('.', '\\.')}`).test(auth);
  return signed || allowUnsigned ? bank : null;
}
const money = s => Number(String(s).replace(/[$,\s]/g, ''));
const AMT = /\$\s?(-?[\d,]+\.\d{2})/;
// Wells Fargo's tables: "Purchase amount 33.97 USD" (no $).
const AMT_LABELED = /\b(?:purchase|transaction|withdrawal|deposit|payment|transfer|debit|credit)?\s*amount:?\s*\$?\s?(-?[\d,]+\.\d{2})(?:\s*USD)?/i;
const AMT_USD = /\b(-?[\d,]+\.\d{2})\s*USD\b/;
// "ending in 1234", "account …1234", "Checking ...1234", "x1234", "*1234".
const LAST4 = /(?:(?:ending in|ending with|ending|account|card|acct|checking|savings)[^\d$]{0,12}(?:x+|\*+|\.{2,}|…)?\s?|(?:\bx{1,}|\*{1,}|\.{2,}|…)\s?)(\d{4})\b/i;
const IN_WORDS = /\b(deposit(?:ed)?|direct dep|credit(?:ed)? to|received|refund|payroll|incoming|transfer from|zelle (?:payment )?from|paid you|sent you)\b/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function dateIn(text, year) {
  let m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:, (\d{4}))?/i.exec(text);
  if (m) return `${m[3] || year}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return null;
}
// "As of 10/14/2026 at 03:38 a.m." — the hour it states (null without one); before 6 a.m. it is
// the previous day's close.
const asOfTime = text => { const i = text.search(/as of/i); if (i < 0) return null;
  const t = /\b(\d{1,2}):\d{2}\s*([ap])\.?m\b/i.exec(text.slice(i, i + 80));
  return t ? (+t[1] % 12) + (/p/i.test(t[2]) ? 12 : 0) : null; };
const asOfMidday = text => { const h = asOfTime(text); return h != null && h >= 6 && h < 22; };
function asOfDay(text, day) {
  const i = text.search(/as of/i); if (i < 0) return null;
  const d = dateIn(text.slice(i, i + 80), day.slice(0, 4)); if (!d) return null;
  const h = asOfTime(text);
  return h != null && h < 6 ? addDay(d, -1) : d;
}
/* Wells Fargo's daily "account update": the balances, then what POSTED since the last one, under
   "Withdrawals" / "Deposits" / "Checks" — each item its description followed by its $ amount.
   Card purchases say "PURCHASE AUTHORIZED ON 10/08 … CARD 2954": that day and that card. */
function digestLines(text, postedOn) {
  const heads = [...text.matchAll(/\b(Withdrawals|Deposits|Credits|Checks)(?![a-z])/g)];
  const stop = /As of\b|Note about balances|WellsFargo\.com|To modify or cancel/i, out = [];
  heads.forEach((h, k) => {
    let sec = text.slice(h.index + h[0].length, k + 1 < heads.length ? heads[k + 1].index : undefined);
    const e = sec.search(stop); if (e >= 0) sec = sec.slice(0, e);
    const sign = /Deposits|Credits/.test(h[1]) ? 1 : -1;
    for (const m of sec.matchAll(/([^$]*?)\$\s?([\d,]+\.\d{2})/g)) {
      const raw = m[1].replace(/\s+/g, ' ').trim();
      if (!/[a-z]{3}/i.test(raw) || /\btotal\b/i.test(raw)) continue;
      const auth = /AUTHORIZED ON (\d{1,2})\/(\d{1,2})/i.exec(raw), card = /CARD\s+(\d{4})\s*$/i.exec(raw);
      let date = postedOn;
      if (auth) { const y = +postedOn.slice(0, 4), mm = +auth[1];
        date = `${mm > +postedOn.slice(5, 7) + 1 ? y - 1 : y}-${String(mm).padStart(2, '0')}-${String(auth[2]).padStart(2, '0')}`; }
      let name = raw.replace(/^(?:PURCHASE|RECURRING PAYMENT|PAYMENT|ATM WITHDRAWAL)?\s*AUTHORIZED ON \d{1,2}\/\d{1,2}\s*/i, '')
                    .replace(/\s+[A-Z]?\d{9,}\s+CARD\s+\d{4}\s*$/i, '').replace(/\s+CARD\s+\d{4}\s*$/i, '');
      const cut = name.search(/\s\d+(?:\s|$)/); if (cut >= 6) name = name.slice(0, cut);   // "…PREM. OCT 26 13 653 349 NAME"
      out.push({ date, amount: sign * money(m[2]), name: name.slice(0, 80), raw: name, card: card ? card[1] : '' });
    }
  });
  return out;
}
/* → {kind:'balance', bank, accounts:[{last4, type, balance}], date, lines?}
     {kind:'tx', bank, last4, type, amount (in = +), name, date}
     {kind:'unknown', bank, subject}
   `localDate(d)`/`localHour(d)` turn the email's time into America/Chicago. */
function readAlert(msg, { localDate, localHour, allowUnsigned }) {
  const bank = bankOf(msg, allowUnsigned); if (!bank) return null;
  const sent = new Date(msg.headers.date || Date.now());
  const day = localDate(sent), all = `${msg.subject}\n${msg.text}`;
  // "Your balance is above $0.01": a threshold alert at some moment of the day, not a day's close.
  if (/balance (?:is )?(?:above|below)|zero balance/i.test(msg.subject)) return null;
  const typeOf = s => /credit card/i.test(s) ? 'credit' : /savings/i.test(s) ? 'savings' : /checking|debit card/i.test(s) ? 'checking' : '';
  if (/balance summary/i.test(msg.text) && /(?:available|ending) balance/i.test(msg.text)) {
    const l4 = LAST4.exec(all);
    const b = /available balance(?:\s*\d(?![\d,.]))?\D{0,8}\$\s?(-?[\d,]+\.\d{2})/i.exec(msg.text) || /ending balance(?:\s*\d(?![\d,.]))?\D{0,8}\$\s?(-?[\d,]+\.\d{2})/i.exec(msg.text);
    const date = asOfDay(msg.text, day) || (localHour(sent) < 12 ? addDay(day, -1) : day);
    if (!b) return { kind: 'unknown', bank: bank.name, subject: msg.subject, date: day };
    return { kind: 'balance', bank: bank.name, accounts: [{ last4: l4 ? l4[1] : '', type: typeOf(msg.subject), balance: money(b[1]) }],
             date, lines: digestLines(msg.text, date) };
  }
  // A balance alert: says "balance" up front and is not about one purchase or deposit.
  if (/balance/i.test(msg.subject) && !/purchase|transaction|withdrawal|deposit made|payment (?:to|of)/i.test(msg.subject)) {
    const accounts = [];
    // Each account mention (…1234) owns the next balance figure after it.
    const re = new RegExp(LAST4.source, 'gi'); let m;
    const marks = []; while ((m = re.exec(all))) marks.push({ at: m.index, last4: m[1] });
    for (let i = 0; i < marks.length; i++) {
      const seg = all.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : undefined);
      /* "Your available balance is $7,510.04 for account ...5565": the figure can come BEFORE the
         account, so with nothing after it, the last figure since the previous account counts. */
      const before = [...all.slice(i ? marks[i - 1].at : 0, marks[i].at).matchAll(/\$\s?(-?[\d,]+\.\d{2})/g)];
      const b = /(?:available|current|ending|ledger|account)?\s*balance[^$\n]{0,40}\$\s?(-?[\d,]+\.\d{2})/i.exec(seg) || AMT.exec(seg)
             || before[before.length - 1];
      if (b && !accounts.some(a => a.last4 === marks[i].last4))
        accounts.push({ last4: marks[i].last4, type: typeOf(seg.slice(0, 120) + ' ' + msg.subject), balance: money(b[1]) });
    }
    if (!accounts.length) { const b = AMT.exec(all); if (b) accounts.push({ last4: '', type: typeOf(all), balance: money(b[1]) }); }
    if (!accounts.length) return { kind: 'unknown', bank: bank.name, subject: msg.subject, date: day };
    // A balance "as of 2:15 p.m." is a moment in the day, not how it closed: not a reconcile.
    if (asOfMidday(all)) return null;
    // "as of 10/12/2026" when it says; otherwise a morning email is the previous day's close.
    const date = asOfDay(all, day) || (localHour(sent) < 12 ? addDay(day, -1) : day);
    return { kind: 'balance', bank: bank.name, accounts, date };
  }
  const a = AMT.exec(msg.subject) || AMT_LABELED.exec(msg.text) || AMT_USD.exec(msg.text) || AMT.exec(msg.text);
  if (!a || !/purchase|transaction|withdrawal|deposit|payment|transfer|debit|credit|charge|zelle|sent|received|paid|ach/i.test(all))
    return { kind: 'unknown', bank: bank.name, subject: msg.subject, date: day };
  const amt = Math.abs(money(a[1])), inbound = IN_WORDS.test(msg.subject) || (!/purchase|withdrawal|debit|charge|payment to|sent/i.test(msg.subject) && IN_WORDS.test(msg.text));
  // "Merchant details at CVS/PHARMACY #11092 in OKLAHOMA CITY UNITED STATES"
  const merchant = /merchant(?: details| name)?:?\s+(?:at\s+)?(.+?)(?=\s+in\s+[A-Z0-9][A-Za-z0-9 .'()-]*?(?:UNITED STATES|USA|\bUS\b)|\s+Date\b|\n|$)/i.exec(msg.text);
  // "Deposited by: COTERRA ENERGY I PAYROLL 261016 930645528717CXK …" — the payer, without its codes.
  const payer = /\bdeposited by:?\s+(.+)/i.exec(msg.text);
  if (payer) { const cut = payer[1].search(/\s\d+(?:\s|$)/); if (cut >= 6) payer[1] = payer[1].slice(0, cut); }
  const who = merchant || payer || /\b(?:at|to|from|with|by|merchant:?)\s+([A-Za-z0-9][\w &*'.#\/-]{1,40}?)(?=\s+(?:on|was|for|using|has|in the amount|from|exceeded)\b|[.,;](?=\s|$)|\n|$)/i.exec(msg.subject + '\n' + msg.text);
  const l4 = LAST4.exec(all);
  // The alert's own "Date 10/13/2026 04:17 PM" when it has one (a late email is still that day's).
  const when = /\bDate:?\s+(\d{1,2}\/\d{1,2}\/\d{4})/.exec(msg.text);
  /* Wells Fargo "Early Pay Day" ("You just got paid early!"): usable today, but it posts — and the
     morning email lists it — a day or two later (`early`, see the twin rule in bank.js). */
  const early = inbound && /paid early|early pay day/i.test(all);
  return { kind: 'tx', bank: bank.name, last4: l4 ? l4[1] : '', type: typeOf(all),
           amount: inbound ? amt : -amt, name: (who ? who[1] : msg.subject).trim().slice(0, 80), date: (when && dateIn(when[1])) || day,
           ...(early ? { early: true } : {}) };
}
const addDay = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const msgId = (msg, uid) => 'em-' + crypto.createHash('sha1').update(String(msg.headers['message-id'] || uid)).digest('hex').slice(0, 20);

module.exports = { fetchNew, parseMessage, readAlert, msgId };
