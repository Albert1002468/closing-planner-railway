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
const RANGE_END = '2026-12-31';
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
  store = {
    kind: 'sqlite',
    all: () => db.prepare('SELECT date, actual, note, created_at FROM reconciles ORDER BY date').all(),
    has: d => !!db.prepare('SELECT 1 AS x FROM reconciles WHERE date = ?').get(d),
    insert: r => db.prepare('INSERT INTO reconciles (date,actual,note,created_at) VALUES (?,?,?,?)')
                   .run(r.date, r.actual, r.note, r.created_at)
  };
} catch (err) {
  const file = path.join(DATA_DIR, 'reconciles.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  store = {
    kind: 'json',
    all: () => read().slice().sort((a, b) => a.date < b.date ? -1 : 1),
    has: d => read().some(r => r.date === d),
    insert: r => { const rows = read(); rows.push(r); fs.writeFileSync(file, JSON.stringify(rows, null, 2)); }
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
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const now = localNow();
    return json(res, 200, {
      today: now.date, hour: now.hour, unlockHour: UNLOCK_HOUR, timezone: TZ,
      rangeStart: RANGE_START, rangeEnd: RANGE_END,
      saveEnabled: !!PASSCODE, storage: store.kind,
      reconciles: store.all()
    });
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

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });

  // static
  let rel = decodeURIComponent(url.pathname);
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
