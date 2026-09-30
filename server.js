'use strict';
/**
 * Closing & Home-Sale Planner — zero-dependency server (Node 20+).
 * Serves /public and persists reconciliation entries to a Railway volume.
 *
 * Storage: node:sqlite (Node 22+) → planner.db, else JSON file. Both live in DATA_DIR.
 *
 * Env:
 *   RECONCILE_PASSCODE  (required to save) passcode for writing a reconcile
 *   DATA_DIR            (default /data) persistent volume mount path
 *   PORT                (Railway provides)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PASSCODE = process.env.RECONCILE_PASSCODE || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = 'America/Chicago';
const RANGE_START = '2026-08-14';
const RANGE_END = '2056-12-31';
const UNLOCK_HOUR = Number(process.env.RECONCILE_UNLOCK_HOUR ?? 19); // today unlocks at 7pm local

if (!PASSCODE) console.warn('[warn] RECONCILE_PASSCODE not set — saving is disabled.');

/* ------------------------- storage ------------------------- */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

let store;
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'planner.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS reconciles (
    date TEXT PRIMARY KEY, actual REAL NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
  /* Corrections live in their own table, never by mutating history in place. A separate table
     also means no migration of `reconciles` — existing rows are untouched. */
  db.exec(`CREATE TABLE IF NOT EXISTS reconcile_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
    prev_actual REAL NOT NULL, prev_note TEXT NOT NULL DEFAULT '',
    new_actual REAL NOT NULL, new_note TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '', edited_at TEXT NOT NULL)`);
  /* Adjustments: the ACTUAL amount of one projected transaction (a paycheck that came in higher,
     a bill that was lower). Keyed by the page as `date|label`; one row per transaction. */
  db.exec(`CREATE TABLE IF NOT EXISTS adjustments (
    key TEXT PRIMARY KEY, date TEXT NOT NULL, label TEXT NOT NULL, amount REAL NOT NULL,
    projected REAL NOT NULL, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`);
  // Added later: the day it actually happened, when that differs from the projection's day.
  // A table created before this has no such column, so add it once (it throws if present).
  try { db.exec('ALTER TABLE adjustments ADD COLUMN move_to TEXT'); } catch { /* already there */ }
  store = {
    kind: 'sqlite',
    adjustments: () => db.prepare('SELECT key, date, label, amount, projected, note, move_to AS moveTo, updated_at FROM adjustments ORDER BY date').all(),
    setAdjustment: a => db.prepare(`INSERT INTO adjustments (key,date,label,amount,projected,note,move_to,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET amount=excluded.amount,
      projected=excluded.projected, note=excluded.note, label=excluded.label, move_to=excluded.move_to,
      updated_at=excluded.updated_at`)
      .run(a.key, a.date, a.label, a.amount, a.projected, a.note, a.moveTo, a.updated_at),
    clearAdjustment: k => db.prepare('DELETE FROM adjustments WHERE key = ?').run(k),
    all: () => db.prepare('SELECT date, actual, note, created_at FROM reconciles ORDER BY date').all(),
    has: d => !!db.prepare('SELECT 1 AS x FROM reconciles WHERE date = ?').get(d),
    get: d => db.prepare('SELECT date, actual, note, created_at FROM reconciles WHERE date = ?').get(d),
    insert: r => db.prepare('INSERT INTO reconciles (date,actual,note,created_at) VALUES (?,?,?,?)')
                   .run(r.date, r.actual, r.note, r.created_at),
    update: r => db.prepare('UPDATE reconciles SET actual = ?, note = ? WHERE date = ?')
                   .run(r.actual, r.note, r.date),
    logEdit: e => db.prepare(`INSERT INTO reconcile_edits
      (date,prev_actual,prev_note,new_actual,new_note,reason,edited_at) VALUES (?,?,?,?,?,?,?)`)
      .run(e.date, e.prev_actual, e.prev_note, e.new_actual, e.new_note, e.reason, e.edited_at),
    edits: () => db.prepare('SELECT date, prev_actual, new_actual, reason, edited_at FROM reconcile_edits ORDER BY edited_at').all(),
    // All-or-nothing: a correction and the entries it shifts land together or not at all.
    tx: fn => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  };
} catch (err) {
  const file = path.join(DATA_DIR, 'reconciles.json');
  const efile = path.join(DATA_DIR, 'reconcile_edits.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  const readE = () => { try { return JSON.parse(fs.readFileSync(efile, 'utf8')); } catch { return []; } };
  const write = rows => fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  const afile = path.join(DATA_DIR, 'adjustments.json');
  const readA = () => { try { return JSON.parse(fs.readFileSync(afile, 'utf8')); } catch { return []; } };
  const writeA = rows => fs.writeFileSync(afile, JSON.stringify(rows, null, 2));
  store = {
    kind: 'json',
    adjustments: () => readA().sort((a, b) => a.date < b.date ? -1 : 1),
    setAdjustment: a => { const rows = readA().filter(x => x.key !== a.key); rows.push(a); writeA(rows); },
    clearAdjustment: k => writeA(readA().filter(x => x.key !== k)),
    all: () => read().slice().sort((a, b) => a.date < b.date ? -1 : 1),
    has: d => read().some(r => r.date === d),
    get: d => read().find(r => r.date === d) || null,
    insert: r => { const rows = read(); rows.push(r); write(rows); },
    update: r => { const rows = read(); const i = rows.findIndex(x => x.date === r.date);
                   if (i >= 0) { rows[i].actual = r.actual; rows[i].note = r.note; write(rows); } },
    logEdit: e => { const rows = readE(); rows.push(e); fs.writeFileSync(efile, JSON.stringify(rows, null, 2)); },
    edits: () => readE(),
    tx: fn => fn()
  };
  console.log('[store] node:sqlite unavailable (' + err.code + ') — using JSON file');
}
console.log('[store]', store.kind, 'in', DATA_DIR);

/* ------------------------- helpers ------------------------- */
function localNow() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  let hour = parseInt(g('hour'), 10); if (hour === 24) hour = 0;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour };
}
const fails = new Map();
function throttled(ip) {
  const r = fails.get(ip);
  if (!r) return false;
  if (Date.now() - r.first > 15 * 60 * 1000) { fails.delete(ip); return false; }
  return r.count >= 8;
}
function noteFail(ip) {
  const r = fails.get(ip);
  if (!r || Date.now() - r.first > 15 * 60 * 1000) fails.set(ip, { count: 1, first: Date.now() });
  else r.count++;
}
function passOk(given) {
  if (!PASSCODE) return false;
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(PASSCODE, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
};
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/* ------------------------- server ------------------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  /* The LAST X-Forwarded-For entry is the one Railway's edge appended; anything before it was
     sent by the client and can be forged. Keying the lockout on the first entry let a client
     rotate a fake address per request and never be locked out. */
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || 'unknown';

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const now = localNow();
    return json(res, 200, {
      today: now.date, hour: now.hour, unlockHour: UNLOCK_HOUR, timezone: TZ,
      rangeStart: RANGE_START, rangeEnd: RANGE_END,
      saveEnabled: !!PASSCODE, storage: store.kind,
      reconciles: store.all(), edits: store.edits(), adjustments: store.adjustments()
    });
  }

  if (url.pathname === '/api/verify' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Malformed request.' }); }
      if (throttled(ip)) return json(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
      if (!PASSCODE) return json(res, 503, { error: 'Saving is disabled: RECONCILE_PASSCODE is not set on the server.' });
      if (!passOk(b.passcode)) { noteFail(ip); return json(res, 401, { error: 'Incorrect PIN.' }); }
      return json(res, 200, { ok: true });
    });
    return;
  }

  if (url.pathname === '/api/reconciles' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 32768) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Malformed request.' }); }
      if (throttled(ip)) return json(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
      if (!PASSCODE) return json(res, 503, { error: 'Saving is disabled: RECONCILE_PASSCODE is not set on the server.' });
      if (!passOk(b.passcode)) { noteFail(ip); return json(res, 401, { error: 'Incorrect passcode.' }); }

      const date = b.date;
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'Invalid date.' });
      const amt = Number(b.actual);
      if (!Number.isFinite(amt)) return json(res, 400, { error: 'Actual balance must be a number.' });
      const note = String(b.note ?? '').trim();
      if (note.length > 500) return json(res, 400, { error: 'Note too long (500 characters max).' });

      const now = localNow();
      if (date < RANGE_START || date > RANGE_END) return json(res, 400, { error: 'Date is outside the planning window.' });
      if (date > now.date) return json(res, 400, { error: 'Cannot reconcile a future date.' });
      if (date === now.date && now.hour < UNLOCK_HOUR)
        return json(res, 400, { error: `Today unlocks at ${UNLOCK_HOUR}:00 ${TZ}.` });
      if (store.has(date)) return json(res, 409, { error: 'This date is already reconciled and cannot be changed.' });

      const row = { date, actual: Math.round(amt * 100) / 100, note, created_at: new Date().toISOString() };
      try { store.insert(row); } catch { return json(res, 409, { error: 'This date is already reconciled.' }); }
      return json(res, 201, row);
    });
    return;
  }

  /* Correcting a reconcile. A reconcile stays immutable in SPIRIT: the row is updated, but the
     previous value is written to reconcile_edits first, so a typo can be fixed without the
     history quietly changing underneath you. Requires the passcode, same as a new entry. */
  if (url.pathname === '/api/reconciles' && req.method === 'PUT') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 32768) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Malformed request.' }); }
      if (throttled(ip)) return json(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
      if (!PASSCODE) return json(res, 503, { error: 'Saving is disabled: RECONCILE_PASSCODE is not set on the server.' });
      if (!passOk(b.passcode)) { noteFail(ip); return json(res, 401, { error: 'Incorrect passcode.' }); }

      const date = b.date;
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'Invalid date.' });
      const prev = store.get(date);
      if (!prev) return json(res, 404, { error: 'That date has not been reconciled, so there is nothing to correct.' });
      const amt = Number(b.actual);
      if (!Number.isFinite(amt)) return json(res, 400, { error: 'Actual balance must be a number.' });
      const note = String(b.note ?? '').trim();
      if (note.length > 500) return json(res, 400, { error: 'Note too long (500 characters max).' });
      const reason = String(b.reason ?? '').trim().slice(0, 200);

      const actual = Math.round(amt * 100) / 100;
      if (actual === prev.actual && note === prev.note)
        return json(res, 400, { error: 'That is the same figure already recorded.' });

      /* ⚠️ A correction CASCADES. Each entry is stored as the resulting balance, but what the
         reader enters is that day's variance — that day's unplanned spending. Fixing an earlier
         day must therefore move every later balance by the same amount, so their variances stay
         as entered. Left alone, the next entry silently absorbed the difference (its variance
         changed by -delta) and today's balance never moved. Every shifted entry is audited. */
      const delta = Math.round((actual - prev.actual) * 100) / 100;
      const later = delta ? store.all().filter(r => r.date > date) : [];
      const at = new Date().toISOString();
      const shifted = [];
      try {
        store.tx(() => {
          store.logEdit({ date, prev_actual: prev.actual, prev_note: prev.note || '',
                          new_actual: actual, new_note: note, reason, edited_at: at });
          store.update({ date, actual, note });
          for (const r of later) {
            const moved = Math.round((r.actual + delta) * 100) / 100;
            store.logEdit({ date: r.date, prev_actual: r.actual, prev_note: r.note || '',
                            new_actual: moved, new_note: r.note || '',
                            reason: `moved ${delta > 0 ? '+' : ''}${delta.toFixed(2)} with the ${date} correction`,
                            edited_at: at });
            store.update({ date: r.date, actual: moved, note: r.note || '' });
            shifted.push({ date: r.date, actual: moved });
          }
        });
      } catch { return json(res, 500, { error: 'Could not save the correction.' }); }
      return json(res, 200, { date, actual, note, corrected: true, prev_actual: prev.actual, delta, shifted });
    });
    return;
  }

  /* Adjust one projected transaction (PUT sets its actual amount, DELETE returns it to the
     projection). Same passcode and lockout as reconciling. Any date in the planning window —
     past (what actually cleared) or future (a bill you already know). */
  if (url.pathname === '/api/adjustments' && (req.method === 'PUT' || req.method === 'DELETE')) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Malformed request.' }); }
      if (throttled(ip)) return json(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
      if (!PASSCODE) return json(res, 503, { error: 'Saving is disabled: RECONCILE_PASSCODE is not set on the server.' });
      if (!passOk(b.passcode)) { noteFail(ip); return json(res, 401, { error: 'Incorrect passcode.' }); }
      const key = String(b.key ?? '');
      if (!/^\d{4}-\d{2}-\d{2}\|.{1,200}$/.test(key)) return json(res, 400, { error: 'Invalid transaction.' });
      if (req.method === 'DELETE') {
        try { store.clearAdjustment(key); } catch { return json(res, 500, { error: 'Could not remove the adjustment.' }); }
        return json(res, 200, { key, cleared: true });
      }
      const date = key.slice(0, 10);
      if (date < RANGE_START || date > RANGE_END) return json(res, 400, { error: 'Date is outside the planning window.' });
      const amount = Number(b.amount), projected = Number(b.projected);
      if (!Number.isFinite(amount) || !Number.isFinite(projected)) return json(res, 400, { error: 'Amount must be a number.' });
      const label = String(b.label ?? '').trim().slice(0, 200);
      // Optional: the day it actually happened. null = the projection's own day.
      let moveTo = b.moveTo == null || b.moveTo === '' || b.moveTo === date ? null : String(b.moveTo);
      if (moveTo !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(moveTo) || moveTo < RANGE_START || moveTo > RANGE_END))
        return json(res, 400, { error: 'The new date is outside the planning window.' });
      const note = String(b.note ?? '').trim();
      if (note.length > 500) return json(res, 400, { error: 'Note too long (500 characters max).' });
      const row = { key, date, label, amount: Math.round(amount * 100) / 100,
                    projected: Math.round(projected * 100) / 100, note, moveTo, updated_at: new Date().toISOString() };
      try { store.setAdjustment(row); } catch { return json(res, 500, { error: 'Could not save the adjustment.' }); }
      return json(res, 200, row);
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });

  // static
  // A malformed %-escape throws, and an uncaught throw here takes the whole process down.
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
      });
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=86400'
    });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`[ready] http://localhost:${PORT} — ${store.kind} store, tz ${TZ}`));
