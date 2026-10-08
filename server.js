'use strict';
/**
 * Closing & Home-Sale Planner — zero-dependency server (Node 20+).
 * Serves /public and persists reconciliation entries to a Railway volume.
 *
 * Storage: node:sqlite (Node 22+) → planner.db, else JSON file. Both live in DATA_DIR.
 *
 * Sign-in: passkeys (Face ID / Touch ID) in front of the WHOLE site, required every time the app
 * is opened (each session serves the planner page once; see THE GATE).
 * The PIN is only used to register a passkey on a new device (and as recovery).
 *
 * Env:
 *   RECONCILE_PASSCODE  (required) PIN for adding a device's passkey; unset ⇒ nobody can sign in
 *   RP_ID               (optional) passkey domain; defaults to the request's host
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

if (!PASSCODE) console.warn('[warn] RECONCILE_PASSCODE not set — no device can be set up to sign in.');
const SESSION_HOURS = 12;   // hard ceiling; in practice a session ends when the page does
const RP_ID_ENV = process.env.RP_ID || '';

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
  // Sign-in: one row per registered passkey, and one per signed-in device (token stored hashed).
  db.exec(`CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY, jwk TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, passkey_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  try { db.exec('ALTER TABLE sessions ADD COLUMN page_served INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  store = {
    kind: 'sqlite',
    passkeys: () => db.prepare('SELECT id, jwk, alg, sign_count, name, created_at, last_used FROM passkeys ORDER BY created_at').all(),
    getPasskey: id => db.prepare('SELECT id, jwk, alg, sign_count, name FROM passkeys WHERE id = ?').get(id) || null,
    addPasskey: k => db.prepare('INSERT OR REPLACE INTO passkeys (id,jwk,alg,sign_count,name,created_at) VALUES (?,?,?,?,?,?)')
                      .run(k.id, k.jwk, k.alg, k.sign_count, k.name, k.created_at),
    usePasskey: (id, count, at) => db.prepare('UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?').run(count, at, id),
    addSession: x => db.prepare('INSERT INTO sessions (token_hash,passkey_id,created_at,expires_at) VALUES (?,?,?,?)')
                      .run(x.token_hash, x.passkey_id, x.created_at, x.expires_at),
    getSession: h => db.prepare('SELECT token_hash, passkey_id, expires_at, page_served FROM sessions WHERE token_hash = ?').get(h) || null,
    markServed: h => db.prepare('UPDATE sessions SET page_served = 1 WHERE token_hash = ?').run(h),
    dropSession: h => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h),
    pruneSessions: now => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now),
    adjustments: () => db.prepare('SELECT key, date, label, amount, projected, note, move_to AS moveTo, updated_at FROM adjustments ORDER BY date').all(),
    setAdjustment: a => db.prepare(`INSERT INTO adjustments (key,date,label,amount,projected,note,move_to,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET amount=excluded.amount,
      projected=excluded.projected, note=excluded.note, label=excluded.label, move_to=excluded.move_to,
      updated_at=excluded.updated_at`)
      .run(a.key, a.date, a.label, a.amount, a.projected, a.note, a.moveTo, a.updated_at),
    clearAdjustment: k => db.prepare('DELETE FROM adjustments WHERE key = ?').run(k),
    getAdjustment: k => db.prepare('SELECT key, date, label, amount, projected, note, move_to AS moveTo FROM adjustments WHERE key = ?').get(k) || null,
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
  const kfile = path.join(DATA_DIR, 'passkeys.json'), sfile = path.join(DATA_DIR, 'sessions.json');
  const readK = () => { try { return JSON.parse(fs.readFileSync(kfile, 'utf8')); } catch { return []; } };
  const writeK = rows => fs.writeFileSync(kfile, JSON.stringify(rows, null, 2));
  const readS = () => { try { return JSON.parse(fs.readFileSync(sfile, 'utf8')); } catch { return []; } };
  const writeS = rows => fs.writeFileSync(sfile, JSON.stringify(rows, null, 2));
  store = {
    kind: 'json',
    passkeys: () => readK(),
    getPasskey: id => readK().find(k => k.id === id) || null,
    addPasskey: k => writeK([...readK().filter(x => x.id !== k.id), k]),
    usePasskey: (id, count, at) => writeK(readK().map(k => k.id === id ? { ...k, sign_count: count, last_used: at } : k)),
    addSession: x => writeS([...readS(), x]),
    getSession: h => readS().find(x => x.token_hash === h) || null,
    markServed: h => writeS(readS().map(x => x.token_hash === h ? { ...x, page_served: 1 } : x)),
    dropSession: h => writeS(readS().filter(x => x.token_hash !== h)),
    pruneSessions: now => writeS(readS().filter(x => x.expires_at >= now)),
    adjustments: () => readA().sort((a, b) => a.date < b.date ? -1 : 1),
    setAdjustment: a => { const rows = readA().filter(x => x.key !== a.key); rows.push(a); writeA(rows); },
    clearAdjustment: k => writeA(readA().filter(x => x.key !== k)),
    getAdjustment: k => readA().find(x => x.key === k) || null,
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

/* ------------------------- sign-in (passkeys) -------------------------
   WebAuthn without a library. Registration: check clientDataJSON (type, challenge, origin),
   then authenticatorData (RP ID hash, user present + VERIFIED — i.e. Face ID actually ran),
   and keep the credential's public key as a JWK. Sign-in: same checks, plus the signature
   over authenticatorData ‖ SHA-256(clientDataJSON). Attestation is not requested ('none'):
   this is one person's planner, not an enterprise device policy. */
const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s || ''), 'base64url');
const sha256 = d => crypto.createHash('sha256').update(d).digest();

// Minimal CBOR (RFC 8949) reader: enough for attestationObject and COSE keys.
function cbor(buf, pos = 0) {
  const ib = buf[pos++], major = ib >> 5, info = ib & 31;
  let len;
  if (info < 24) len = info;
  else if (info === 24) { len = buf[pos]; pos += 1; }
  else if (info === 25) { len = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { len = buf.readUInt32BE(pos); pos += 4; }
  else if (info === 27) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
  else throw new Error('cbor: unsupported length');
  switch (major) {
    case 0: return [len, pos];
    case 1: return [-1 - len, pos];
    case 2: return [buf.subarray(pos, pos + len), pos + len];
    case 3: return [buf.subarray(pos, pos + len).toString('utf8'), pos + len];
    case 4: { const a = []; for (let i = 0; i < len; i++) { const [v, p] = cbor(buf, pos); a.push(v); pos = p; } return [a, pos]; }
    case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const [k, p1] = cbor(buf, pos); const [v, p2] = cbor(buf, p1); m.set(k, v); pos = p2; } return [m, pos]; }
    case 7: return [info === 20 ? false : info === 21 ? true : null, pos];
    default: throw new Error('cbor: unsupported type');
  }
}
// COSE public key → JWK. ES256 (what iPhones use) and RS256 (Windows Hello).
function coseToJwk(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1)
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)) } };
  if (kty === 3 && alg === -257)
    return { alg, jwk: { kty: 'RSA', n: b64u(m.get(-1)), e: b64u(m.get(-2)) } };
  throw new Error('Unsupported passkey type.');
}
function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('Bad authenticator data.');
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33) };
  if (out.flags & 0x40) {                                  // attested credential data
    const idLen = ad.readUInt16BE(53);
    out.credId = ad.subarray(55, 55 + idLen);
    out.cose = cbor(ad, 55 + idLen)[0];
  }
  return out;
}
// The site's passkey domain and origin. Fixed by RP_ID when set; otherwise this request's host.
function rpFor(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const hostname = host.replace(/:\d+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || (hostname === 'localhost' ? 'http' : 'https')).split(',')[0].trim();
  return { id: RP_ID_ENV || hostname, origin: `${proto}://${host}`, secure: proto === 'https' };
}
function checkClient(cdjBuf, type, rp) {
  let c; try { c = JSON.parse(cdjBuf.toString('utf8')); } catch { throw new Error('Bad client data.'); }
  if (c.type !== type) throw new Error('Wrong ceremony.');
  const ch = challenges.get(c.challenge);
  challenges.delete(c.challenge);                          // single use, whatever happens next
  if (!ch || ch.type !== type || ch.exp < Date.now()) throw new Error('This sign-in request expired. Try again.');
  if (c.origin !== rp.origin) throw new Error('Wrong site.');
  return ch;
}
function checkFlags(a, rp) {
  if (!a.rpIdHash.equals(sha256(rp.id))) throw new Error('Passkey is for another site.');
  if (!(a.flags & 0x01)) throw new Error('No user presence.');
  if (!(a.flags & 0x04)) throw new Error('Face ID / device unlock was not used.');
}
// Challenges live in memory for 5 minutes. A restart only means asking again.
const challenges = new Map();
function newChallenge(type) {
  const c = b64u(crypto.randomBytes(32)), now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  challenges.set(c, { type, exp: now + 5 * 60 * 1000 });
  return c;
}
// Sessions: a random token in an HttpOnly cookie; only its hash is stored.
function cookieToken(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function sessionOf(req) {
  const t = cookieToken(req); if (!t) return null;
  const s = store.getSession(sha256(t).toString('hex'));
  return s && s.expires_at > new Date().toISOString() ? s : null;
}
function startSession(req, res, passkeyId) {
  const token = b64u(crypto.randomBytes(32)), now = new Date();
  const exp = new Date(now.getTime() + SESSION_HOURS * 36e5);
  try { store.pruneSessions(now.toISOString()); } catch { /* best effort */ }
  store.addSession({ token_hash: sha256(token).toString('hex'), passkey_id: passkeyId,
                     created_at: now.toISOString(), expires_at: exp.toISOString() });
  // No Max-Age: a browser-session cookie, gone when the browser or home-screen app is closed.
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax`
                              + (rpFor(req).secure ? '; Secure' : ''));
}
const readBody = (req, max, cb) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > max) req.destroy(); });
  req.on('end', () => { let b; try { b = JSON.parse(raw || '{}'); } catch { b = null; } cb(b); });
};
const USER_ID = b64u(Buffer.from('cash-flow-owner'));      // one owner; every passkey is theirs

/* Returns true when it handled the request. */
function authRoutes(req, res, url, ip) {
  const rp = rpFor(req);
  if (url.pathname === '/api/auth/status' && req.method === 'GET')
    return json(res, 200, { signedIn: !!sessionOf(req), hasPasskeys: store.passkeys().length > 0,
                            setupEnabled: !!PASSCODE }), true;

  // Adding a device: the PIN (or an existing session) unlocks one registration challenge.
  if (url.pathname === '/api/auth/register/options' && req.method === 'POST') {
    readBody(req, 4096, b => {
      if (!b) return json(res, 400, { error: 'Malformed request.' });
      if (!sessionOf(req)) {
        if (throttled(ip)) return json(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
        if (!PASSCODE) return json(res, 503, { error: 'Setup is disabled: RECONCILE_PASSCODE is not set on the server.' });
        if (!passOk(b.passcode)) { noteFail(ip); return json(res, 401, { error: 'Incorrect PIN.' }); }
      }
      json(res, 200, {
        challenge: newChallenge('webauthn.create'),
        rp: { id: rp.id, name: 'Cash Flow' },
        user: { id: USER_ID, name: 'Cash Flow', displayName: 'Cash Flow' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none', timeout: 120000,
        excludeCredentials: store.passkeys().map(k => ({ type: 'public-key', id: k.id }))
      });
    });
    return true;
  }
  if (url.pathname === '/api/auth/register/verify' && req.method === 'POST') {
    readBody(req, 65536, b => {
      try {
        if (!b) throw new Error('Malformed request.');
        const cdj = unb64u(b.clientDataJSON);
        checkClient(cdj, 'webauthn.create', rp);
        const att = cbor(unb64u(b.attestationObject))[0];
        if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('Bad attestation.');
        const a = parseAuthData(att.get('authData'));
        checkFlags(a, rp);
        if (!a.credId || !a.cose) throw new Error('No credential in the response.');
        const { alg, jwk } = coseToJwk(a.cose);
        crypto.createPublicKey({ key: jwk, format: 'jwk' });   // throws on a malformed key
        const id = b64u(a.credId);
        store.addPasskey({ id, jwk: JSON.stringify(jwk), alg, sign_count: a.signCount,
                           name: String(b.name || '').slice(0, 80), created_at: new Date().toISOString() });
        startSession(req, res, id);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message || 'Could not register the passkey.' }); }
    });
    return true;
  }
  if (url.pathname === '/api/auth/login/options' && req.method === 'POST') {
    // Discoverable credentials: no list is sent, the device offers the passkey it holds.
    json(res, 200, { challenge: newChallenge('webauthn.get'), rpId: rp.id, userVerification: 'required', timeout: 120000 });
    return true;
  }
  if (url.pathname === '/api/auth/login/verify' && req.method === 'POST') {
    readBody(req, 65536, b => {
      try {
        if (!b) throw new Error('Malformed request.');
        if (throttled(ip)) return json(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
        const key = store.getPasskey(String(b.id || ''));
        if (!key) { noteFail(ip); throw new Error('This passkey is not registered here. Set up this device with the PIN.'); }
        const cdj = unb64u(b.clientDataJSON), ad = unb64u(b.authenticatorData);
        checkClient(cdj, 'webauthn.get', rp);
        const a = parseAuthData(ad);
        checkFlags(a, rp);
        const pub = crypto.createPublicKey({ key: JSON.parse(key.jwk), format: 'jwk' });
        const ok = crypto.verify('sha256', Buffer.concat([ad, sha256(cdj)]),
                                 key.alg === -7 ? { key: pub, dsaEncoding: 'der' } : pub, unb64u(b.signature));
        if (!ok) { noteFail(ip); throw new Error('Passkey check failed.'); }
        // A counter that goes backwards means a cloned authenticator. Synced passkeys report 0.
        if (a.signCount && key.sign_count && a.signCount <= key.sign_count) throw new Error('Passkey counter went backwards.');
        store.usePasskey(key.id, a.signCount, new Date().toISOString());
        startSession(req, res, key.id);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 401, { error: e.message || 'Sign-in failed.' }); }
    });
    return true;
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const t = cookieToken(req);
    if (t) store.dropSession(sha256(t).toString('hex'));
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (rp.secure ? '; Secure' : ''));
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}
// Public without a session: the sign-in page, its icons and the PWA manifest.
const PUBLIC_FILES = new Set(['/login.html', '/manifest.json', '/icon.svg', '/icon-192.png', '/icon-512.png',
                              '/apple-touch-icon.png', '/favicon-32.png']);

/* ------------------------- server ------------------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  /* The LAST X-Forwarded-For entry is the one Railway's edge appended; anything before it was
     sent by the client and can be forged. Keying the lockout on the first entry let a client
     rotate a fake address per request and never be locked out. */
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || 'unknown';

  if (url.pathname === '/api/health' && req.method === 'GET')
    return json(res, 200, { ok: true, storage: store.kind, setupEnabled: !!PASSCODE });
  if (url.pathname.startsWith('/api/auth/')) {
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== rpFor(req).origin)
      return json(res, 403, { error: 'Wrong site.' });
    if (authRoutes(req, res, url, ip)) return;
    return json(res, 404, { error: 'Not found.' });
  }
  /* ⚠️ THE GATE. Everything else — the planner page and every API — needs a signed-in session.
     Writes also refuse a cross-site Origin (the cookie is SameSite=Lax; this is belt and braces).
     A page request without a session gets the sign-in page instead.
     Passkey EVERY time the app is opened: a session serves the planner page ONCE. Its APIs keep
     working for that loaded page, but opening or reloading the app is a new page request, which
     ends the session and shows sign-in. (iOS can keep a home-screen app's session cookie alive
     across launches, so the cookie's lifetime alone would not guarantee this.) The page also
     signs itself out after a minute in the background — see LOCK_AFTER_MS in index.html. */
  const sess = sessionOf(req);
  let signedIn = !!sess;
  // A page is a document load (/, *.html, or an extensionless path that falls back to the app) —
  // not /favicon.ico, which browsers fetch on their own and must not use up the session.
  const isApi = url.pathname.startsWith('/api/'), isPublic = PUBLIC_FILES.has(url.pathname);
  const isPage = !isApi && !isPublic && (/\.html$/i.test(url.pathname) || !/\.[a-z0-9]+$/i.test(url.pathname));
  if (sess && isPage) {
    if (sess.page_served) { store.dropSession(sess.token_hash); signedIn = false; }
    else store.markServed(sess.token_hash);
  }
  if (url.pathname.startsWith('/api/')) {
    if (!signedIn) return json(res, 401, { error: 'Signed out. Reload to sign in.', signedOut: true });
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== rpFor(req).origin)
      return json(res, 403, { error: 'Wrong site.' });
  } else if (!signedIn && !isPublic && !isPage) {
    res.writeHead(404); return res.end('Not found');
  } else if (!signedIn && isPage) {
    return fs.readFile(path.join(PUBLIC_DIR, 'login.html'), (e, html) => {
      if (e) { res.writeHead(500); return res.end('Sign-in page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html);
    });
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const now = localNow();
    return json(res, 200, {
      today: now.date, hour: now.hour, unlockHour: UNLOCK_HOUR, timezone: TZ,
      rangeStart: RANGE_START, rangeEnd: RANGE_END,
      saveEnabled: true, storage: store.kind,
      reconciles: store.all(), edits: store.edits(), adjustments: store.adjustments()
    });
  }

  if (url.pathname === '/api/reconciles' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 32768) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Malformed request.' }); }

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
     history quietly changing underneath you. Requires a signed-in session, like every write. */
  if (url.pathname === '/api/reconciles' && req.method === 'PUT') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 32768) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Malformed request.' }); }

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

  /* ⚠️ An adjustment KEEPS EVERY RECONCILED VARIANCE. What the reader enters when reconciling is
     the day's variance (unplanned spending), so changing a transaction's amount or day must not
     quietly rewrite it: moving a +$3,300 rent off a reconciled day used to leave that day's
     balance pinned and turn its $0.00 variance into +$3,300. Instead the line comes off its old
     day and lands on its new one, and every reconciled balance moves by the net change up to its
     date — so its projected balance and its actual move together. Runs inside store.tx. */
  function keepVariances(oldDay, oldAmt, newDay, newAmt, why) {
    const at = new Date().toISOString(), shifted = [];
    for (const r of store.all()) {
      const d = (r.date >= newDay ? newAmt : 0) - (r.date >= oldDay ? oldAmt : 0);
      const delta = Math.round(d * 100) / 100;
      if (!delta) continue;
      const moved = Math.round((r.actual + delta) * 100) / 100;
      store.logEdit({ date: r.date, prev_actual: r.actual, prev_note: r.note || '', new_actual: moved,
                      new_note: r.note || '', reason: `moved ${delta > 0 ? '+' : ''}${delta.toFixed(2)}: ${why}`.slice(0, 200),
                      edited_at: at });
      store.update({ date: r.date, actual: moved, note: r.note || '' });
      shifted.push({ date: r.date, actual: moved });
    }
    return shifted;
  }

  const KEY_RE = /^\d{4}-\d{2}-\d{2}\|.{1,200}$/;
  // One adjustment's fields, validated. Shared by the single PUT and the batch.
  function parseAdjustment(b, key) {
    const date = key.slice(0, 10);
    if (date < RANGE_START || date > RANGE_END) return { error: 'Date is outside the planning window.' };
    const amount = Number(b.amount), projected = Number(b.projected);
    if (!Number.isFinite(amount) || !Number.isFinite(projected)) return { error: 'Amount must be a number.' };
    const label = String(b.label ?? '').trim().slice(0, 200);
    // Optional: the day it actually happened. null = the projection's own day.
    const moveTo = b.moveTo == null || b.moveTo === '' || b.moveTo === date ? null : String(b.moveTo);
    if (moveTo !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(moveTo) || moveTo < RANGE_START || moveTo > RANGE_END))
      return { error: 'The new date is outside the planning window.' };
    const note = String(b.note ?? '').trim();
    if (note.length > 500) return { error: 'Note too long (500 characters max).' };
    return { row: { key, date, label, amount: Math.round(amount * 100) / 100,
                    projected: Math.round(projected * 100) / 100, note, moveTo, updated_at: new Date().toISOString() } };
  }
  // Runs inside store.tx. What was there before: the previous adjustment, or else the projection.
  function saveAdjustment(row, prev) {
    const shifted = keepVariances(prev ? (prev.moveTo || prev.date) : row.date, prev ? prev.amount : row.projected,
                                  row.moveTo || row.date, row.amount, `adjusted ${row.label || row.key}`);
    store.setAdjustment(row);
    return { ...row, shifted };
  }

  /* Adjust one projected transaction (PUT sets its actual amount, DELETE returns it to the
     projection). Requires a signed-in session. Any date in the planning window —
     past (what actually cleared) or future (a bill you already know). */
  if (url.pathname === '/api/adjustments' && (req.method === 'PUT' || req.method === 'DELETE')) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 131072) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Malformed request.' }); }
      /* Several at once (moving a day's worth of lines): { items: [...] }, each shaped like a single
         PUT. All validated first, then saved in ONE transaction — every line and every reconcile it
         shifts lands together or none do. A line moved back to its own day, at its projected amount
         and with no note, is simply cleared. */
      if (req.method === 'PUT' && Array.isArray(b.items)) {
        if (!b.items.length || b.items.length > 200) return json(res, 400, { error: 'Pick 1–200 transactions.' });
        const rows = [];
        for (const x of b.items) {
          const k = String(x && x.key || '');
          if (!KEY_RE.test(k)) return json(res, 400, { error: 'Invalid transaction.' });
          const p = parseAdjustment(x, k);
          if (p.error) return json(res, 400, { error: p.error });
          rows.push(p.row);
        }
        if (new Set(rows.map(r => r.key)).size !== rows.length) return json(res, 400, { error: 'A transaction is listed twice.' });
        const saved = [], finalAct = new Map();
        try {
          store.tx(() => {
            for (const row of rows) {
              const prev = store.getAdjustment(row.key);
              if (!row.moveTo && row.amount === row.projected && !row.note) {
                if (prev) {
                  keepVariances(prev.moveTo || prev.date, prev.amount, prev.date, prev.projected,
                                `projection restored for ${prev.label || row.key}`).forEach(x => finalAct.set(x.date, x.actual));
                  store.clearAdjustment(row.key);
                }
                saved.push({ key: row.key, cleared: true });
              } else {
                const o = saveAdjustment(row, prev);
                o.shifted.forEach(x => finalAct.set(x.date, x.actual));
                delete o.shifted; saved.push(o);
              }
            }
          });
        } catch { return json(res, 500, { error: 'Could not save the moves.' }); }
        return json(res, 200, { items: saved, shifted: [...finalAct].map(([date, actual]) => ({ date, actual })) });
      }
      const key = String(b.key ?? '');
      if (!KEY_RE.test(key)) return json(res, 400, { error: 'Invalid transaction.' });
      const prev = store.getAdjustment(key);
      if (req.method === 'DELETE') {
        if (!prev) return json(res, 200, { key, cleared: true, shifted: [] });
        let shifted;
        try {
          store.tx(() => {
            // Back to the projection: its amount, on its own day.
            shifted = keepVariances(prev.moveTo || prev.date, prev.amount, prev.date, prev.projected,
                                    `projection restored for ${prev.label || key}`);
            store.clearAdjustment(key);
          });
        } catch { return json(res, 500, { error: 'Could not remove the adjustment.' }); }
        return json(res, 200, { key, cleared: true, shifted });
      }
      const parsed = parseAdjustment(b, key);
      if (parsed.error) return json(res, 400, { error: parsed.error });
      let out;
      try { store.tx(() => { out = saveAdjustment(parsed.row, prev); }); }
      catch { return json(res, 500, { error: 'Could not save the adjustment.' }); }
      return json(res, 200, out);
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
