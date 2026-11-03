'use strict';
// Cloudinary storage layer using only Node built-ins + Cloudinary's REST API.
//  - Photos are uploaded straight from the browser with a server-signed request
//    (so the web host's request-size limits can never break an upload).
//  - Photos are delivered from Cloudinary's CDN.
//  - App data (albums, access keys, history) is one private ("authenticated") raw file.
const crypto = require('crypto');

function parseConfig() {
  let cloud = process.env.CLOUDINARY_CLOUD_NAME, key = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
  const u = process.env.CLOUDINARY_URL;
  if (u) {
    const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(u.trim());
    if (m) [, key, secret, cloud] = m;
  }
  if (!cloud || !key || !secret) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_URL (cloudinary://API_KEY:API_SECRET@CLOUD_NAME) or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.');
  }
  return { cloud, key, secret };
}

const { cloud, key: API_KEY, secret: API_SECRET } = parseConfig();
const ROOT = (process.env.CLOUDINARY_FOLDER || 'jpia-media').replace(/^\/+|\/+$/g, '');
const STATE_ID = `${ROOT}/_data/state.json`;
const ALLOWED = 'jpg,jpeg,png,gif,webp,heic,heif,avif,bmp,tif,tiff';
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
const API = `https://api.cloudinary.com/v1_1/${cloud}`;

function sign(params) {
  const s = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(s + API_SECRET).digest('hex');
}
const auth = 'Basic ' + Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e.http_code && e.http_code >= 400 && e.http_code < 500 && e.http_code !== 429) throw e;
      await sleep(400 * 2 ** i);
    }
  }
  throw last;
}

async function failure(r, what) {
  let msg = '';
  try { msg = (await r.json()).error.message; } catch (_) {}
  return Object.assign(new Error(`${what} failed (${r.status})${msg ? ': ' + msg : ''}`), { http_code: r.status });
}

async function admin(path) {
  return retry(async () => {
    const r = await fetch(API + path, { headers: { Authorization: auth } });
    if (!r.ok) throw await failure(r, 'Cloudinary request');
    return r.json();
  });
}

async function destroy(publicIds) {
  // Permanently deletes images (Cloudinary Admin API, 100 per call). "not_found" counts as already gone.
  for (let i = 0; i < publicIds.length; i += 100) {
    const qs = new URLSearchParams({ invalidate: 'true' });
    publicIds.slice(i, i + 100).forEach((id) => qs.append('public_ids[]', id));
    await retry(async () => {
      const r = await fetch(`${API}/resources/image/upload?${qs}`, { method: 'DELETE', headers: { Authorization: auth } });
      if (!r.ok) throw await failure(r, 'Deleting from Cloudinary');
      return r.json();
    });
  }
  cache = { at: 0, val: null };
}

async function loadState() {
  try {
    await admin(`/resources/raw/authenticated/${encodeURI(STATE_ID)}`);
  } catch (e) {
    if (e.http_code === 404) return null; // first run
    throw e;
  }
  const p = { public_id: STATE_ID, type: 'authenticated', timestamp: Math.round(Date.now() / 1000) };
  const qs = new URLSearchParams({ ...p, api_key: API_KEY, signature: sign(p) });
  return retry(async () => {
    const r = await fetch(`${API}/raw/download?${qs}`);
    if (!r.ok) throw await failure(r, 'Reading app data');
    return r.json();
  });
}

async function saveState(state) {
  await retry(async () => {
    const p = { invalidate: 'true', overwrite: 'true', public_id: STATE_ID, timestamp: Math.round(Date.now() / 1000), type: 'authenticated' };
    const fd = new FormData();
    for (const [k, v] of Object.entries(p)) fd.append(k, v);
    fd.append('api_key', API_KEY);
    fd.append('signature', sign(p));
    fd.append('file', 'data:application/json;base64,' + Buffer.from(JSON.stringify(state)).toString('base64'));
    const r = await fetch(`${API}/raw/upload`, { method: 'POST', body: fd });
    if (!r.ok) throw await failure(r, 'Saving app data');
  });
}

function signUpload(albumId) {
  const params = {
    allowed_formats: ALLOWED,
    folder: `${ROOT}/${albumId}`,
    public_id: crypto.randomBytes(9).toString('hex'),
    timestamp: Math.round(Date.now() / 1000),
  };
  return {
    uploadUrl: `${API}/image/upload`,
    fields: { ...params, api_key: API_KEY, signature: sign(params) },
    maxBytes: MAX_BYTES,
  };
}

async function verifyAsset(albumId, publicId) {
  if (typeof publicId !== 'string' || !publicId.startsWith(`${ROOT}/${albumId}/`) || /[^\w\-\/]/.test(publicId)) {
    throw Object.assign(new Error('Invalid upload.'), { status: 400 });
  }
  try {
    const r = await admin(`/resources/image/upload/${encodeURI(publicId)}`);
    return { publicId: r.public_id, version: r.version, format: r.format, bytes: r.bytes };
  } catch (e) {
    throw Object.assign(new Error('Upload could not be verified. Please try again.'), { status: 400 });
  }
}

function safeName(name) {
  const base = String(name || 'photo').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (base || 'photo').slice(0, 60);
}

function urls(p) {
  const root = `https://res.cloudinary.com/${cloud}/image/upload`;
  return {
    thumb: `${root}/w_520,h_520,c_fill,g_auto,q_auto,f_auto/v${p.version}/${p.publicId}`,
    download: `${root}/fl_attachment:${safeName(p.name)}/v${p.version}/${p.publicId}.${p.format}`,
  };
}

let cache = { at: 0, val: null };
async function usage(fallbackBytes) {
  if (cache.val && Date.now() - cache.at < 60000) return cache.val;
  let val = { usedBytes: fallbackBytes, percent: null };
  try {
    const u = await admin('/usage');
    const used = Number(u.storage && u.storage.usage) || 0;
    let pct = u.storage && typeof u.storage.used_percent === 'number' ? u.storage.used_percent : null;
    if (pct === null && u.credits && typeof u.credits.used_percent === 'number') pct = u.credits.used_percent;
    val = { usedBytes: used || fallbackBytes, percent: pct };
  } catch (_) {}
  if (val.percent === null) {
    const limit = Number(process.env.STORAGE_LIMIT_GB || 25) * 1024 ** 3;
    val.percent = Math.min(100, (val.usedBytes / limit) * 100);
  }
  cache = { at: Date.now(), val };
  return val;
}

module.exports = { loadState, saveState, signUpload, verifyAsset, urls, usage, destroy };
