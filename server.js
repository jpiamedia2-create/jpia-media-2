'use strict';
// JPIA Media — National University Bacolod. Zero-dependency Node server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- tiny .env loader (local use; hosts set real environment variables) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {}

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET || '';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
if (SECRET.length < 16) throw new Error('Set SESSION_SECRET to a random string of at least 16 characters.');
if (!process.env.PRESIDENT_KEY) throw new Error('Set PRESIDENT_KEY (the first JPIA President access key).');

const store = process.env.STORE === 'dev' ? require('./lib/dev') : require('./lib/cloudinary');

// ---- access keys are encrypted before they are written to storage (AES-256-GCM) ----
// A Cloudinary login alone can no longer read them; the server needs KEY_SECRET to decrypt.
const KEY_SECRET = process.env.KEY_SECRET || SECRET;
const AES_KEY = crypto.createHash('sha256').update('jpia-keys:' + KEY_SECRET).digest();
function encKey(plain) {
  if (typeof plain !== 'string' || plain.startsWith('enc1:')) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decKey(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc1:')) return stored; // older plain-text data: re-encrypted on next save
  try {
    const b = Buffer.from(stored.slice(5), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', AES_KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (_) {
    throw new Error('Cannot decrypt the saved access keys. KEY_SECRET (or SESSION_SECRET) is different from the one used before.');
  }
}
function mapKeys(st, fn) {
  const c = structuredClone(st);
  c.keys.president.key = fn(c.keys.president.key);
  for (const r of ['vp', 'sc']) c.keys[r].forEach((k) => (k.key = fn(k.key)));
  return c;
}
const saveSecure = (st) => store.saveState(mapKeys(st, encKey));
const loadSecure = async () => { const st = await store.loadState(); return st ? mapKeys(st, decKey) : st; };

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const id = () => crypto.randomBytes(6).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameKey = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const fp = (key) => crypto.createHash('sha256').update('fp:' + key).digest('hex').slice(0, 10);
const ROLES = ['president', 'vp', 'sc'];
const ROLE_LABEL = { president: 'PRESIDENT', vp: 'VP', sc: 'SC' };

function signToken(p) {
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function readToken(t) {
  if (typeof t !== 'string' || !t.includes('.')) return null;
  const [b, s] = t.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- state
let state = null;
function freshState() {
  return {
    version: 1,
    keys: { president: { name: process.env.PRESIDENT_NAME || 'President', key: process.env.PRESIDENT_KEY }, vp: [], sc: [] },
    albums: [],
    photos: [],
    history: [],
  };
}

let chain = Promise.resolve();
// Every change runs one at a time on a copy; it only becomes live once Cloudinary has it saved.
function mutate(fn) {
  const run = chain.then(async () => {
    const draft = structuredClone(state);
    const out = fn(draft);
    draft.version += 1;
    if (draft.history.length > 500) draft.history.length = 500;
    try { await saveSecure(draft); } catch (e) { console.error('save failed:', e.message); throw new HttpError(503, 'Could not save right now. Please try again.'); }
    state = draft;
    return out;
  });
  chain = run.catch(() => {});
  return run;
}

function log(draft, p, text, detail) {
  draft.history.unshift({ who: who(p), text, detail: detail || '', at: Date.now() });
}
function who(p) { return p.role === 'president' ? 'PRESIDENT' : `${ROLE_LABEL[p.role]} ${String(p.name).toUpperCase()}`; }

// ---------------------------------------------------------------- auth
function principalOf(req) {
  const h = req.headers.authorization || '';
  const p = readToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return null;
  let entry;
  if (p.role === 'president') entry = state.keys.president;
  else if (p.role === 'vp' || p.role === 'sc') entry = state.keys[p.role].find((k) => k.id === p.kid);
  if (!entry || fp(entry.key) !== p.fp) return null; // key changed or deleted: session ends
  return { role: p.role, kid: p.kid, name: entry.name, fp: p.fp };
}
function tokenFor(role, kid, entry) {
  return signToken({ role, kid, fp: fp(entry.key), exp: Date.now() + SESSION_HOURS * 3600e3 });
}
function requireRole(p, ...roles) {
  if (!p) throw new HttpError(401, 'Please sign in.');
  if (!roles.includes(p.role)) throw new HttpError(403, 'Your access key level cannot do that.');
}
const EDITORS = ROLES;

const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.reset > now && a.n >= 8) throw new HttpError(429, 'Too many tries. Please wait a few minutes.');
}
function failedLogin(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset <= now) attempts.set(ip, { n: 1, reset: now + 10 * 60e3 });
  else a.n++;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of attempts) if (v.reset <= n) attempts.delete(k); }, 60e3).unref();

// ---------------------------------------------------------------- validation
function cleanName(v, label) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) throw new HttpError(400, `${label} cannot be empty.`);
  if (s.length > 60) throw new HttpError(400, `${label} is too long (max 60).`);
  return s;
}
function cleanKey(v, draft, exceptEntry) {
  const s = String(v == null ? '' : v).trim();
  if (s.length < 6) throw new HttpError(400, 'Access key must be at least 6 characters.');
  if (s.length > 64) throw new HttpError(400, 'Access key is too long (max 64).');
  const all = [draft.keys.president, ...draft.keys.vp, ...draft.keys.sc];
  if (all.some((k) => k !== exceptEntry && sameKey(k.key, s))) throw new HttpError(400, 'That access key is already in use.');
  return s;
}
const activeAlbum = (d, aid) => {
  const a = d.albums.find((x) => x.id === aid && !x.deleted);
  if (!a) throw new HttpError(404, 'Album not found.');
  return a;
};

// ---------------------------------------------------------------- views
function photoView(p) {
  const u = store.urls(p);
  return { id: p.id, name: p.name, pinned: !!p.pinned, thumb: u.thumb, download: u.download };
}
function sortPhotos(list) {
  return list.slice().sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at));
}

// ---------------------------------------------------------------- routes
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
}

route('POST', '/api/login', async ({ body, ip }) => {
  throttle(ip);
  const role = body.role;
  if (!ROLES.includes(role) || typeof body.key !== 'string' || !body.key) throw new HttpError(400, 'Enter an access key.');
  let entry, kid;
  if (role === 'president') { if (sameKey(state.keys.president.key, body.key)) { entry = state.keys.president; kid = 'president'; } }
  else { entry = state.keys[role].find((k) => sameKey(k.key, body.key)); kid = entry && entry.id; }
  if (!entry) { failedLogin(ip); throw new HttpError(401, 'Wrong access key.'); }
  return { token: tokenFor(role, kid, entry), role, name: entry.name };
});

route('GET', '/api/data', async ({ req, query, p }) => {
  const editor = !!p;
  const authInvalid = !p && !!req.headers.authorization;
  const s = state;
  const albums = s.albums.filter((a) => !a.deleted).map((a) => ({ id: a.id, name: a.name }));
  let albumId = query.get('album');
  if (!albums.some((a) => a.id === albumId)) albumId = albums.length ? albums[0].id : null;
  const auth = p ? p.role : '';
  if (query.get('v') === String(s.version) && query.get('album') === albumId && query.get('auth') === auth && !authInvalid) return { unchanged: true };
  const here = s.photos.filter((x) => x.albumId === albumId);
  const out = {
    version: s.version,
    authInvalid,
    albums,
    albumId,
    photos: sortPhotos(here.filter((x) => !x.deleted)).map(photoView),
  };
  if (editor) {
    out.deletedAlbums = s.albums.filter((a) => a.deleted).map((a) => ({ id: a.id, name: a.name }));
    out.deletedPhotos = here.filter((x) => x.deleted).sort((a, b) => b.deletedAt - a.deletedAt).map(photoView);
  }
  return out;
});

route('POST', '/api/albums', async ({ body, p }) => {
  requireRole(p, ...EDITORS);
  return mutate((d) => {
    const name = cleanName(body.name, 'Album name');
    const a = { id: id(), name, deleted: false, at: Date.now() };
    d.albums.push(a);
    log(d, p, 'CREATED AN ALBUM', name);
    return { id: a.id };
  });
});
route('PATCH', '/api/albums/:aid', async ({ body, params, p }) => {
  requireRole(p, ...EDITORS);
  return mutate((d) => {
    const a = activeAlbum(d, params.aid);
    const old = a.name;
    a.name = cleanName(body.name, 'Album name');
    if (old !== a.name) log(d, p, 'RENAMED AN ALBUM', `${old} → ${a.name}`);
    return { ok: true };
  });
});
route('DELETE', '/api/albums/:aid', async ({ params, p }) => {
  requireRole(p, ...EDITORS);
  return mutate((d) => {
    const a = activeAlbum(d, params.aid);
    a.deleted = true; a.deletedAt = Date.now();
    log(d, p, 'DELETED AN ALBUM', a.name);
    return { ok: true };
  });
});
route('POST', '/api/albums/:aid/restore', async ({ params, p }) => {
  requireRole(p, ...EDITORS);
  return mutate((d) => {
    const a = d.albums.find((x) => x.id === params.aid && x.deleted);
    if (!a) throw new HttpError(404, 'Album not found.');
    a.deleted = false; delete a.deletedAt;
    log(d, p, 'RESTORED AN ALBUM', a.name);
    return { ok: true };
  });
});

route('POST', '/api/albums/:aid/sign', async ({ params, p }) => {
  requireRole(p, ...EDITORS);
  activeAlbum(state, params.aid);
  return store.signUpload(params.aid);
});
route('POST', '/api/albums/:aid/photos', async ({ params, body, p }) => {
  requireRole(p, ...EDITORS);
  activeAlbum(state, params.aid);
  const asset = await store.verifyAsset(params.aid, body.publicId);
  return mutate((d) => {
    const a = activeAlbum(d, params.aid);
    if (d.photos.some((x) => x.publicId === asset.publicId)) return { ok: true };
    d.photos.push({
      id: id(), albumId: a.id, publicId: asset.publicId, version: asset.version, format: asset.format, bytes: asset.bytes || 0,
      name: String(body.name || 'photo').slice(0, 120), pinned: false, deleted: false, at: Date.now(),
    });
    log(d, p, `UPLOADED PHOTO IN ${a.name.toUpperCase()}`, String(body.name || ''));
    return { ok: true };
  });
});

function photoAction(method, suffix, fn) {
  route(method, '/api/photos/:pid' + suffix, async (ctx) => {
    requireRole(ctx.p, ...EDITORS);
    return mutate((d) => {
      const ph = d.photos.find((x) => x.id === ctx.params.pid);
      if (!ph) throw new HttpError(404, 'Photo not found.');
      const al = d.albums.find((x) => x.id === ph.albumId);
      fn(d, ph, (al ? al.name : 'AN ALBUM').toUpperCase(), ctx);
      return { ok: true };
    });
  });
}
photoAction('DELETE', '', (d, ph, an, c) => { if (ph.deleted) throw new HttpError(404, 'Photo not found.'); ph.deleted = true; ph.deletedAt = Date.now(); log(d, c.p, `DELETED PHOTO IN ${an}`, ph.name); });
photoAction('POST', '/restore', (d, ph, an, c) => { if (!ph.deleted) throw new HttpError(404, 'Photo not found.'); ph.deleted = false; delete ph.deletedAt; log(d, c.p, `RESTORED PHOTO IN ${an}`, ph.name); });
photoAction('POST', '/pin', (d, ph, an, c) => {
  if (ph.deleted) throw new HttpError(404, 'Photo not found.');
  const want = !!c.body.pinned;
  if (ph.pinned === want) return;
  ph.pinned = want;
  log(d, c.p, `${want ? 'PINNED' : 'UNPINNED'} PHOTO IN ${an}`, ph.name);
});

// ---- delete forever (only items that are already in RESTORE): erases the files from Cloudinary
async function eraseFiles(ids) {
  try { await store.destroy(ids); } catch (e) { console.error('destroy failed:', e.message); throw new HttpError(503, 'Could not delete from Cloudinary right now. Nothing was removed. Please try again.'); }
}
route('DELETE', '/api/photos/:pid/purge', async ({ params, p }) => {
  requireRole(p, ...EDITORS);
  const ph = state.photos.find((x) => x.id === params.pid);
  if (!ph || !ph.deleted) throw new HttpError(404, 'Photo not found in RESTORE.');
  await eraseFiles([ph.publicId]);
  return mutate((d) => {
    const i = d.photos.findIndex((x) => x.id === params.pid);
    if (i < 0) return { ok: true };
    const [g] = d.photos.splice(i, 1);
    const al = d.albums.find((x) => x.id === g.albumId);
    log(d, p, `DELETED FOREVER A PHOTO IN ${(al ? al.name : 'AN ALBUM').toUpperCase()}`, g.name);
    return { ok: true };
  });
});
route('DELETE', '/api/albums/:aid/purge', async ({ params, p }) => {
  requireRole(p, ...EDITORS);
  const al = state.albums.find((x) => x.id === params.aid && x.deleted);
  if (!al) throw new HttpError(404, 'Album not found in RESTORE.');
  await eraseFiles(state.photos.filter((x) => x.albumId === al.id).map((x) => x.publicId));
  return mutate((d) => {
    d.photos = d.photos.filter((x) => x.albumId !== params.aid);
    const i = d.albums.findIndex((x) => x.id === params.aid);
    if (i >= 0) d.albums.splice(i, 1);
    log(d, p, 'DELETED FOREVER AN ALBUM', al.name);
    return { ok: true };
  });
});

route('POST', '/api/trash/purge', async ({ body, p }) => {
  requireRole(p, ...EDITORS);
  const aIds = new Set(Array.isArray(body.albums) ? body.albums.map(String) : []);
  const pIds = new Set(Array.isArray(body.photos) ? body.photos.map(String) : []);
  const albums = state.albums.filter((a) => a.deleted && aIds.has(a.id));
  const albumSet = new Set(albums.map((a) => a.id));
  const photos = state.photos.filter((x) => albumSet.has(x.albumId) || (x.deleted && pIds.has(x.id)));
  if (!albums.length && !photos.length) throw new HttpError(404, 'Nothing to delete.');
  await eraseFiles(photos.map((x) => x.publicId));
  const gone = new Set(photos.map((x) => x.id));
  return mutate((d) => {
    d.photos = d.photos.filter((x) => !gone.has(x.id));
    d.albums = d.albums.filter((a) => !albumSet.has(a.id));
    log(d, p, 'DELETED FOREVER ALL IN RESTORE', `${photos.length} photo(s), ${albums.length} album(s)`);
    return { ok: true, photos: photos.length, albums: albums.length };
  });
});

route('GET', '/api/history', async ({ p }) => {
  requireRole(p, ...EDITORS);
  const photoBytes = state.photos.reduce((n, x) => n + (x.bytes || 0), 0);
  const u = await store.usage(photoBytes);
  return { history: state.history.map((h) => ({ who: h.who, text: h.text, detail: h.detail, at: h.at })), usage: u };
});

// ---- access keys
function keysView(p) {
  const k = state.keys;
  const full = (e) => ({ id: e.id || 'president', name: e.name, key: e.key });
  const out = {
    role: p.role,
    president: p.role === 'president' ? full(k.president) : { id: 'president', name: k.president.name, key: null },
    vp: k.vp.map(full),
    sc: k.sc.map(full),
    canVp: p.role === 'president',
    canSc: true,
    canPresident: p.role === 'president',
  };
  return out;
}
route('GET', '/api/keys', async ({ p }) => { requireRole(p, 'president', 'vp'); return keysView(p); });

function canTouch(p, role) {
  if (role === 'president') return p.role === 'president';
  if (role === 'vp') return p.role === 'president';
  if (role === 'sc') return p.role === 'president' || p.role === 'vp';
  return false;
}
route('POST', '/api/keys', async ({ body, p }) => {
  requireRole(p, 'president', 'vp');
  const role = body.role;
  if (!['vp', 'sc'].includes(role) || !canTouch(p, role)) throw new HttpError(403, 'Your access key level cannot do that.');
  await mutate((d) => {
    if (d.keys[role].length >= (role === 'vp' ? 10 : 100)) throw new HttpError(400, 'Too many access keys for this level.');
    const name = cleanName(body.name, 'Name');
    const key = cleanKey(body.key, d);
    d.keys[role].push({ id: id(), name, key });
    log(d, p, `ADDED ${ROLE_LABEL[role]} ACCESS KEY`, name);
  });
  return keysView(p);
});
route('PATCH', '/api/keys/:role/:kid', async ({ body, params, p }) => {
  requireRole(p, 'president', 'vp');
  const role = params.role;
  if (!ROLES.includes(role) || !canTouch(p, role)) throw new HttpError(403, 'Your access key level cannot do that.');
  let token = null;
  await mutate((d) => {
    const entry = role === 'president' ? d.keys.president : d.keys[role].find((k) => k.id === params.kid);
    if (!entry) throw new HttpError(404, 'Access key not found.');
    const oldName = entry.name, oldKey = entry.key;
    if (body.name !== undefined) entry.name = cleanName(body.name, 'Name');
    if (body.key !== undefined) entry.key = cleanKey(body.key, d, entry);
    if (entry.key !== oldKey) log(d, p, `CHANGED ${ROLE_LABEL[role]} ACCESS KEY`, entry.name);
    else if (entry.name !== oldName) log(d, p, `RENAMED ${ROLE_LABEL[role]} ACCESS KEY`, `${oldName} → ${entry.name}`);
    // keep the editor signed in if they changed their own key
    if (p.role === role && p.kid === (role === 'president' ? 'president' : params.kid)) token = tokenFor(role, p.kid, entry);
  });
  return { ok: true, token };
});
route('DELETE', '/api/keys/:role/:kid', async ({ params, p }) => {
  requireRole(p, 'president', 'vp');
  const role = params.role;
  if (!['vp', 'sc'].includes(role) || !canTouch(p, role)) throw new HttpError(403, 'Your access key level cannot do that.');
  await mutate((d) => {
    const i = d.keys[role].findIndex((k) => k.id === params.kid);
    if (i < 0) throw new HttpError(404, 'Access key not found.');
    const [gone] = d.keys[role].splice(i, 1);
    log(d, p, `DELETED ${ROLE_LABEL[role]} ACCESS KEY`, gone.name);
  });
  return { ok: true };
});

// ---------------------------------------------------------------- http server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const PUB = path.join(__dirname, 'public');

function sendJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 100e3) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (_) { reject(new HttpError(400, 'Bad request.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (store.handle && (await store.handle(req, res, url))) return;

    if (url.pathname.startsWith('/api/')) {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return sendJson(res, 404, { error: 'Not found.' });
      const m = r.re.exec(url.pathname);
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const out = await r.handler({ req, params, body, query: url.searchParams, p: principalOf(req), ip });
      return sendJson(res, 200, out);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !(e instanceof HttpError) ? 'Something went wrong. Please try again.' : e.message });
  }
});

(async () => {
  state = await loadSecure();
  if (!state) { state = freshState(); await saveSecure(state); console.log('Created new app data.'); }
  if (process.env.RESET_PRESIDENT === '1') {
    state.keys.president = { name: process.env.PRESIDENT_NAME || state.keys.president.name, key: process.env.PRESIDENT_KEY };
    await saveSecure(state);
    console.log('President key reset from environment. Remove RESET_PRESIDENT now.');
  }
  server.listen(PORT, () => console.log(`JPIA Media running on port ${PORT} (${process.env.STORE === 'dev' ? 'DEV store' : 'Cloudinary'})`));
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });

module.exports = { server };
