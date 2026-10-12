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
/* → {kind:'balance', bank, accounts:[{last4, type, balance}], date}
     {kind:'tx', bank, last4, type, amount (in = +), name, date}
     {kind:'unknown', bank, subject}
   `localDate(d)`/`localHour(d)` turn the email's time into America/Chicago. */
function readAlert(msg, { localDate, localHour, allowUnsigned }) {
  const bank = bankOf(msg, allowUnsigned); if (!bank) return null;
  const sent = new Date(msg.headers.date || Date.now());
  const day = localDate(sent), all = `${msg.subject}\n${msg.text}`;
  const typeOf = s => /credit card/i.test(s) ? 'credit' : /savings/i.test(s) ? 'savings' : /checking|debit card/i.test(s) ? 'checking' : '';
  // A balance alert: says "balance" up front and is not about one purchase or deposit.
  if (/balance/i.test(msg.subject) && !/purchase|transaction|withdrawal|deposit made|payment (?:to|of)/i.test(msg.subject)) {
    const accounts = [];
    // Each account mention (…1234) owns the next balance figure after it.
    const re = new RegExp(LAST4.source, 'gi'); let m;
    const marks = []; while ((m = re.exec(all))) marks.push({ at: m.index, last4: m[1] });
    for (let i = 0; i < marks.length; i++) {
      const seg = all.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : undefined);
      const b = /(?:available|current|ending|ledger|account)?\s*balance[^$\n]{0,40}\$\s?(-?[\d,]+\.\d{2})/i.exec(seg) || AMT.exec(seg);
      if (b && !accounts.some(a => a.last4 === marks[i].last4))
        accounts.push({ last4: marks[i].last4, type: typeOf(seg.slice(0, 120) + ' ' + msg.subject), balance: money(b[1]) });
    }
    if (!accounts.length) { const b = AMT.exec(all); if (b) accounts.push({ last4: '', type: typeOf(all), balance: money(b[1]) }); }
    if (!accounts.length) return { kind: 'unknown', bank: bank.name, subject: msg.subject, date: day };
    // "as of 10/12/2026" when it says; otherwise a morning email is the previous day's close.
    const asOf = /as of/i.test(all) ? dateIn(all.slice(all.search(/as of/i)), day.slice(0, 4)) : null;
    const date = asOf || (localHour(sent) < 12 ? addDay(day, -1) : day);
    return { kind: 'balance', bank: bank.name, accounts, date };
  }
  const a = AMT.exec(msg.subject) || AMT.exec(msg.text);
  if (!a || !/purchase|transaction|withdrawal|deposit|payment|transfer|debit|credit|charge|zelle|sent|received|paid|ach/i.test(all))
    return { kind: 'unknown', bank: bank.name, subject: msg.subject, date: day };
  const amt = Math.abs(money(a[1])), inbound = IN_WORDS.test(msg.subject) || (!/purchase|withdrawal|debit|charge|payment to|sent/i.test(msg.subject) && IN_WORDS.test(msg.text));
  const who = /\b(?:at|to|from|with|by|merchant:?)\s+([A-Za-z0-9][\w &*'.#\/-]{1,40}?)(?=\s+(?:on|was|for|using|has|in the amount|from|exceeded)\b|[.,;](?=\s|$)|\n|$)/i.exec(msg.subject + '\n' + msg.text);
  const l4 = LAST4.exec(all);
  return { kind: 'tx', bank: bank.name, last4: l4 ? l4[1] : '', type: typeOf(all),
           amount: inbound ? amt : -amt, name: (who ? who[1] : msg.subject).trim().slice(0, 80), date: day };
}
const addDay = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const msgId = (msg, uid) => 'em-' + crypto.createHash('sha1').update(String(msg.headers['message-id'] || uid)).digest('hex').slice(0, 20);

module.exports = { fetchNew, parseMessage, readAlert, msgId };
