'use strict';
// Local stand-in for Cloudinary (STORE=dev): same interface, files on disk. For trying/testing offline.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.DEV_DATA_DIR || path.join(__dirname, '..', '.devdata');
fs.mkdirSync(path.join(DIR, 'files'), { recursive: true });
const STATE = path.join(DIR, 'state.json');
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
const fileOf = (id) => path.join(DIR, 'files', id.replace(/\//g, '__'));

async function loadState() { return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null; }
async function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }
function signUpload(albumId) {
  return { uploadUrl: '/dev-upload', fields: { public_id: `jpia-media/${albumId}/${crypto.randomBytes(9).toString('hex')}` }, maxBytes: MAX_BYTES };
}
async function verifyAsset(albumId, publicId) {
  if (typeof publicId !== 'string' || !publicId.startsWith(`jpia-media/${albumId}/`) || /[^\w\-\/]/.test(publicId) || !fs.existsSync(fileOf(publicId))) {
    throw Object.assign(new Error('Upload could not be verified. Please try again.'), { status: 400 });
  }
  return { publicId, version: 1, format: 'png', bytes: fs.statSync(fileOf(publicId)).size };
}
function urls(p) {
  const u = `/dev-files/${p.publicId.replace(/\//g, '__')}`;
  return { thumb: u, download: `${u}?download=1&name=${encodeURIComponent(p.name || 'photo')}` };
}
async function usage(fallbackBytes) { return { usedBytes: fallbackBytes, percent: Math.min(100, (fallbackBytes / 25 / 1024 ** 3) * 100) }; }

function parseMultipart(buf, boundary) {
  const out = { fields: {}, file: null };
  const sep = Buffer.from('--' + boundary);
  let pos = buf.indexOf(sep);
  while (pos !== -1) {
    const next = buf.indexOf(sep, pos + sep.length);
    if (next === -1) break;
    const part = buf.subarray(pos + sep.length + 2, next - 2);
    const hEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, hEnd).toString();
    const body = part.subarray(hEnd + 4);
    const name = /name="([^"]+)"/.exec(head);
    if (name) { if (/filename=/.test(head)) out.file = body; else out.fields[name[1]] = body.toString(); }
    pos = next;
  }
  return out;
}

async function handle(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/dev-upload') {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 40e6) { res.writeHead(413).end(); return true; } chunks.push(c); }
    const m = /boundary=(.+)$/.exec(req.headers['content-type'] || '');
    const { fields, file } = m ? parseMultipart(Buffer.concat(chunks), m[1]) : {};
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!file || !fields.public_id || /[^\w\-\/]/.test(fields.public_id)) return send(400, { error: { message: 'empty upload' } }), true;
    if (file.length > MAX_BYTES) return send(400, { error: { message: 'File size too large' } }), true;
    fs.writeFileSync(fileOf(fields.public_id), file);
    send(200, { public_id: fields.public_id, version: 1, format: 'png', bytes: file.length });
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/dev-files/')) {
    const f = path.join(DIR, 'files', path.basename(url.pathname));
    if (!fs.existsSync(f)) return res.writeHead(404).end(), true;
    const h = { 'Content-Type': 'image/png' };
    if (url.searchParams.get('download')) h['Content-Disposition'] = `attachment; filename="${(url.searchParams.get('name') || 'photo').replace(/[^\w.\-]/g, '_')}"`;
    res.writeHead(200, h); res.end(fs.readFileSync(f));
    return true;
  }
  return false;
}
module.exports = { loadState, saveState, signUpload, verifyAsset, urls, usage, handle };
