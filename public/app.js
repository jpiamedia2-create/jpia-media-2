'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
    return e;
  };

  // ------------------------------------------------------------ icons (drawn to match the baseline)
  const person = (stroke, fill, bg) =>
    `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="${bg || 'none'}" stroke="${stroke}" stroke-width="2.2"/><circle cx="20" cy="15" r="6.2" fill="${fill}"/><path d="M7.5 32c1.8-6.5 7.4-8.6 12.5-8.6S30.700 25.500 32.500 32A18 18 0 0 1 7.500 32z" fill="${fill}"/></svg>`;
  const ICON = {
    president: person('#f2c94c', '#f2c94c'),
    vp: person('#fff', '#023051', '#fff'),
    sc: person('#8b93b3', '#023051', '#8b93b3'),
    sc2: person('#8b93b3', '#8b93b3'),
    vp2: person('#fff', '#fff'),
    plus: '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="#f7c600"/><path d="M20 10v20M10 20h20" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>',
    plusBig: '<svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="36" fill="#f7c600"/><path d="M36 17v38M17 36h38" stroke="#2e3a8c" stroke-width="9" stroke-linecap="round"/></svg>',
    ex: '<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="30" fill="#fff"/><rect x="25.500" y="10" width="9" height="25" rx="4.500" fill="#023051"/><circle cx="30" cy="46" r="5.500" fill="#023051"/></svg>',
    dl: '<svg viewBox="0 0 48 48" fill="none" stroke="#023051" stroke-width="5.500" stroke-linecap="round" stroke-linejoin="round"><path d="M24 5v26M12 20l12 12 12-12"/><path d="M5 31v6a4 4 0 0 0 4 4h30a4 4 0 0 0 4-4v-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="#2e3a8c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.500 6h17M9 6V3.500h6V6"/><path d="M5.500 6l1 14.500h11l1-14.500"/><path d="M10 10v7M14 10v7"/></svg>',
    pin: '<svg viewBox="0 0 32 32"><g transform="rotate(45 16 16)" fill="#efcd4c"><path d="M11.500 3h9l-1.500 9 4.500 4.500v2h-15v-2L13 12z"/><rect x="15" y="18" width="2" height="11" rx="1"/></g></svg>',
    redTrash: '<svg viewBox="0 0 62 62"><defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff4a4a"/><stop offset="1" stop-color="#d4001f"/></linearGradient></defs><circle cx="31" cy="31" r="31" fill="url(#rg)"/><g fill="none" stroke="#fff" stroke-width="3.200" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21h30M25 21v-5h12v5"/><path d="M19 21l2 24h20l2-24"/><path d="M26 28v12M31 28v12M36 28v12"/></g></svg>',
  };

  // ------------------------------------------------------------ state
  const S = {
    token: sessionStorage.getItem('jpia_token') || '',
    role: sessionStorage.getItem('jpia_role') || '',
    name: sessionStorage.getItem('jpia_name') || '',
    albums: [], deletedAlbums: [], albumId: (location.hash || '').slice(1) || null,
    photos: [], deletedPhotos: [], version: 0, q: '',
    view: 'main', editing: false, upl: '', loginRole: null,
  };
  const isEditor = () => !!S.role;

  // ------------------------------------------------------------ plumbing
  let toastT;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'on' + (err ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), err ? 5500 : 3200);
  }
  async function api(method, url, body) {
    let r;
    try {
      r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (_) { throw new Error('No connection. Please check your internet and try again.'); }
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && S.token) { signOut(true); throw new Error(j.error || 'Your session ended. Please sign in again.'); }
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
    return j;
  }
  const act = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, true); } };

  function fit() { document.documentElement.style.setProperty('--z', Math.max(0.36, Math.min(innerWidth / 910, 1.3))); }
  addEventListener('resize', fit); fit();

  // ------------------------------------------------------------ data
  async function load(force) {
    if (force) S.version = 0;
    const q = new URLSearchParams({ v: S.version, album: S.albumId || '', auth: S.role || '' });
    const d = await api('GET', '/api/data?' + q);
    if (d.unchanged) return;
    if (d.authInvalid) { signOut(true); return; }
    S.version = d.version; S.albums = d.albums; S.albumId = d.albumId; S.photos = d.photos;
    S.deletedAlbums = d.deletedAlbums || []; S.deletedPhotos = d.deletedPhotos || [];
    renderAll();
  }
  const reload = () => act(() => load(true));

  // ------------------------------------------------------------ render: main
  function renderHeader() {
    document.querySelectorAll('.role').forEach((b) => b.classList.toggle('on', b.dataset.role === S.role));
    $('.r-president i').innerHTML = ICON.president; $('.r-vp i').innerHTML = ICON.vp; $('.r-sc i').innerHTML = ICON.sc;
    $('#plus').innerHTML = ICON.plus; $('#hist').innerHTML = ICON.ex;
    $('#plus').hidden = !(S.role === 'president' || S.role === 'vp');
    $('#hist').hidden = !isEditor();
    $('#signas').title = isEditor() ? `Signed in as ${S.name} — click to sign out` : '';
  }

  function renderSide() {
    if (S.editing) return;
    const side = $('#side'); side.textContent = '';
    const q = S.q.trim().toLowerCase();
    S.albums.filter((a) => !q || a.name.toLowerCase().includes(q)).forEach((a) => {
      const b = h('button', { class: 'alb' + (a.id === S.albumId ? ' sel' : ''), title: a.name, onclick: () => selectAlbum(a.id), ondblclick: () => isEditor() && renameAlbum(b, a) }, h('span', {}, a.name));
      side.append(b);
    });
    if (isEditor()) {
      const add = h('button', { class: 'alb add', title: 'Add album', onclick: () => newAlbum(add) }, '+');
      side.append(add);
    }
  }

  function inlineEdit(host, value, onDone, className) {
    S.editing = true;
    const input = h('input', { value, maxlength: 60, 'aria-label': 'Album name' });
    host.textContent = ''; host.append(input); input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true; S.editing = false;
      const v = input.value.trim();
      if (save && v && v !== value) await act(() => onDone(v));
      renderSide(); renderTools();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    host.onclick = null;
  }
  function newAlbum(btn) {
    inlineEdit(btn, '', async (name) => {
      const r = await api('POST', '/api/albums', { name });
      S.albumId = r.id; history.replaceState(null, '', '#' + r.id); await load(true);
    });
    btn.querySelector('input').placeholder = 'Album name';
  }
  function renameAlbum(btn, a) {
    inlineEdit(btn, a.name, async (name) => { await api('PATCH', '/api/albums/' + a.id, { name }); await load(true); });
  }

  function renderTools() {
    if (S.editing && $('#tools input')) return;
    const t = $('#tools'); t.textContent = '';
    const cur = S.albums.find((a) => a.id === S.albumId);
    const nm = cur ? cur.name : '';
    const ttl = h('div', { class: 'ttl' + (isEditor() && cur ? ' edit' : ''), title: isEditor() ? nm + ' — click to rename' : nm, style: nm.length > 9 ? `font-size:${Math.max(15, Math.floor(300 / nm.length))}px` : false }, h('span', {}, nm));
    if (isEditor() && cur) ttl.addEventListener('click', () => { if (!S.editing) inlineEdit(ttl, cur.name, async (name) => { await api('PATCH', '/api/albums/' + cur.id, { name }); await load(true); }); });
    t.append(ttl);
    if (isEditor()) {
      t.append(
        h('button', { class: 'tbtn up', disabled: !cur || !!S.upl, onclick: () => $('#file').click() }, S.upl || 'UPLOAD PHOTO'),
        h('button', { class: 'tbtn del', disabled: !cur, onclick: deleteAlbum }, 'DELETE ALBUM'),
        h('button', { class: 'tbtn res', onclick: openRestore }, 'RESTORE')
      );
    }
  }

  function renderGrid() {
    const g = $('#grid'); g.textContent = '';
    for (const p of S.photos) {
      const card = h('div', { class: 'card' });
      const img = h('img', { class: 'ph', src: p.thumb, alt: p.name, loading: 'lazy', draggable: 'false' });
      img.addEventListener('error', () => { img.remove(); card.prepend(h('div', { class: 'lbl' }, 'Photo')); });
      card.append(img);
      if (p.pinned || isEditor()) {
        const pin = h('button', { class: 'pin' + (isEditor() ? ' can' : '') + (p.pinned ? '' : ' off'), html: ICON.pin, title: p.pinned ? 'Pinned' : (isEditor() ? 'Pin photo' : ''), tabindex: isEditor() ? 0 : -1 });
        if (isEditor()) pin.addEventListener('click', () => act(async () => { await api('POST', `/api/photos/${p.id}/pin`, { pinned: !p.pinned }); await load(true); }));
        else pin.disabled = true;
        card.append(pin);
      }
      card.append(h('a', { class: 'dl', href: p.download, html: ICON.dl, title: 'Download photo', download: '', rel: 'noopener', 'aria-label': 'Download photo' }));
      if (isEditor()) {
        card.append(h('button', { class: 'del', html: ICON.trash, title: 'Delete photo', 'aria-label': 'Delete photo', onclick: () => act(async () => { await api('DELETE', '/api/photos/' + p.id); await load(true); toast('Photo deleted. Use RESTORE to bring it back.'); }) }));
      }
      g.append(card);
    }
  }
  function renderAll() { renderHeader(); renderSide(); renderTools(); renderGrid(); }

  function selectAlbum(id) {
    if (id === S.albumId) return;
    S.albumId = id; history.replaceState(null, '', '#' + id);
    S.photos = []; renderSide(); renderTools(); renderGrid();
    reload();
  }

  // ------------------------------------------------------------ editor actions
  async function deleteAlbum() {
    const cur = S.albums.find((a) => a.id === S.albumId); if (!cur) return;
    if (!confirm(`Delete the album "${cur.name}"? You can bring it back with RESTORE.`)) return;
    await act(async () => { await api('DELETE', '/api/albums/' + cur.id); S.albumId = null; history.replaceState(null, '', location.pathname); await load(true); toast('Album deleted. Use RESTORE to bring it back.'); });
  }

  function openRestore() {
    const list = $('#restoreList'); list.textContent = '';
    const row = (label, thumb, restoreUrl, purgeUrl, warn) => {
      const r = h('div', { class: 'rrow' });
      r.append(
        h('button', { class: 'rbtn', title: 'Restore', onclick: () => doRestore(restoreUrl, label.startsWith('Album') ? 'Album restored.' : 'Photo restored.') }, thumb ? h('img', { src: thumb, alt: '' }) : null, h('span', {}, label)),
        h('button', { class: 'purge', title: 'Delete forever', 'aria-label': 'Delete forever', onclick: () => doPurge(purgeUrl, warn) }, h('img', { src: 'clean.png', alt: '' }))
      );
      return r;
    };
    const items = [];
    S.deletedAlbums.forEach((a) => items.push(row('Album: ' + a.name, null, '/api/albums/' + a.id + '/restore', '/api/albums/' + a.id + '/purge', `Delete the album "${a.name}" and ALL its photos forever? This cannot be undone.`)));
    S.deletedPhotos.forEach((p) => items.push(row('Photo: ' + p.name, p.thumb, '/api/photos/' + p.id + '/restore', '/api/photos/' + p.id + '/purge', `Delete "${p.name}" forever? This frees the storage and cannot be undone.`)));
    if (!items.length) list.append(h('div', { class: 'none' }, 'Nothing to restore here.'));
    items.forEach((i) => list.append(i));
    $('#restoreAll').hidden = !items.length;
    $('#restorePop').classList.add('on');
  }
  async function purgeAll() {
    const al = S.deletedAlbums, ph = S.deletedPhotos;
    if (!al.length && !ph.length) return;
    const parts = [];
    if (ph.length) parts.push(ph.length + (ph.length === 1 ? ' photo' : ' photos'));
    if (al.length) parts.push(al.length + (al.length === 1 ? ' album (with all its photos)' : ' albums (with all their photos)'));
    if (!confirm(`Delete EVERYTHING in RESTORE forever?\n\n${parts.join(' and ')}\n\nThis frees the storage and cannot be undone.`)) return;
    await act(async () => {
      const r = await api('POST', '/api/trash/purge', { albums: al.map((x) => x.id), photos: ph.map((x) => x.id) });
      await load(true);
      toast(`Deleted forever: ${r.photos} ${r.photos === 1 ? 'photo' : 'photos'}${r.albums ? ` and ${r.albums} ${r.albums === 1 ? 'album' : 'albums'}` : ''}.`);
    });
    openRestore();
  }
  async function doPurge(url, warn) {
    if (!confirm(warn)) return;
    await act(async () => { await api('DELETE', url); await load(true); toast('Deleted forever.'); });
    openRestore();
  }
  async function doRestore(url, msg) {
    $('#restorePop').classList.remove('on');
    await act(async () => { await api('POST', url); await load(true); toast(msg); });
  }

  // ------------------------------------------------------------ uploads (direct to Cloudinary, with retries)
  async function prepare(file, max) {
    if (!(/^image\//.test(file.type) || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(file.name))) throw new Error('is not a supported image.');
    const limit = max * 0.95;
    if (file.size <= limit) return file;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (_) { throw new Error(`is too large (max ${Math.floor(max / 1048576)} MB).`); }
    let scale = Math.min(1, 6000 / Math.max(bmp.width, bmp.height)), q = 0.9;
    for (let i = 0; i < 8; i++) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= limit) return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
      scale *= 0.8; q = Math.max(0.72, q - 0.04);
    }
    throw new Error('is too large to upload.');
  }
  function xhrUpload(sign, file, onp) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', sign.uploadUrl); x.timeout = 10 * 60e3;
      x.upload.onprogress = (e) => e.lengthComputable && onp(e.loaded / e.total);
      x.onload = () => {
        let j = {}; try { j = JSON.parse(x.responseText); } catch (_) {}
        if (x.status >= 200 && x.status < 300 && j.public_id) return resolve(j);
        const err = new Error((j.error && j.error.message) || `upload failed (${x.status})`); err.retry = x.status >= 500 || x.status === 429; reject(err);
      };
      const net = () => { const e = new Error('network error during upload.'); e.retry = true; reject(e); };
      x.onerror = net; x.ontimeout = net;
      const fd = new FormData(); Object.entries(sign.fields).forEach(([k, v]) => fd.append(k, v)); fd.append('file', file);
      x.send(fd);
    });
  }
  async function uploadFiles(files) {
    const albumId = S.albumId; if (!albumId || !files.length) return;
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const tag = files.length > 1 ? ` ${i + 1}/${files.length}` : '';
      const set = (t) => { S.upl = t; renderTools(); };
      try {
        set('PREPARING' + tag);
        let sign = await api('POST', `/api/albums/${albumId}/sign`);
        const file = await prepare(files[i], sign.maxBytes);
        let res;
        for (let attempt = 0; ; attempt++) {
          try { res = await xhrUpload(sign, file, (f) => set(`UPLOADING ${Math.round(f * 100)}%${tag}`)); break; }
          catch (e) { if (!e.retry || attempt >= 3) throw e; set('RETRYING' + tag); await new Promise((r) => setTimeout(r, 800 * 2 ** attempt)); sign = await api('POST', `/api/albums/${albumId}/sign`); }
        }
        set('SAVING' + tag);
        await api('POST', `/api/albums/${albumId}/photos`, { publicId: res.public_id, name: files[i].name });
        ok++;
      } catch (e) { toast(`${files[i].name} ${/^(is|upload|network|No connection|Your|Please)/i.test(e.message) ? e.message : 'could not be uploaded: ' + e.message}`, true); }
    }
    S.upl = ''; await act(() => load(true)); renderTools();
    if (ok) toast(ok === 1 ? 'Photo uploaded.' : `${ok} photos uploaded.`);
  }

  // ------------------------------------------------------------ sign in / out
  function openLogin(role) {
    S.loginRole = role; const i = $('#keyIn'); i.value = ''; i.classList.remove('bad');
    $('#keyPop').classList.add('on'); setTimeout(() => i.focus(), 30);
  }
  async function doLogin() {
    const i = $('#keyIn'), key = i.value; if (!key) return;
    try {
      const r = await api('POST', '/api/login', { role: S.loginRole, key });
      S.token = r.token; S.role = r.role; S.name = r.name;
      sessionStorage.setItem('jpia_token', S.token); sessionStorage.setItem('jpia_role', S.role); sessionStorage.setItem('jpia_name', S.name);
      $('#keyPop').classList.remove('on'); S.version = 0;
      await load(true); toast(`Signed in — ${r.name}`);
    } catch (e) {
      i.classList.remove('bad'); void i.offsetWidth; i.classList.add('bad'); i.select();
      if (/many/i.test(e.message)) toast(e.message, true);
    }
  }
  function signOut(expired) {
    S.token = ''; S.role = ''; S.name = ''; S.version = 0; S.editing = false;
    ['jpia_token', 'jpia_role', 'jpia_name'].forEach((k) => sessionStorage.removeItem(k));
    closePages(); renderAll(); load(true).catch(() => {});
    if (expired) toast('Signed out. Please sign in again if you need to edit.');
  }

  // ------------------------------------------------------------ access key page
  function closePages() { S.view = 'main'; $('#keysPage').classList.remove('on'); $('#histPage').classList.remove('on'); }
  async function openKeys() {
    await act(async () => {
      const k = await api('GET', '/api/keys');
      S.view = 'keys'; renderKeys(k); $('#keysPage').classList.add('on'); scrollTo(0, 0);
    });
  }
  function renderKeys(k) {
    const body = $('#keysBody'); body.textContent = '';
    const refresh = async () => { try { renderKeys(await api('GET', '/api/keys')); } catch (e) { toast(e.message, true); } };

    const editableRow = (role, e, canEdit, canDelete) => {
      const name = h('input', { value: e.name, maxlength: 60, disabled: !canEdit, 'aria-label': 'Name', placeholder: 'NAME' });
      const key = h('input', { value: e.key == null ? '••••••••' : e.key, maxlength: 64, disabled: !canEdit || e.key == null, 'aria-label': 'Access key', autocomplete: 'off', spellcheck: 'false' });
      const commit = (field, input, orig) => input.addEventListener('change', async () => {
        const v = input.value.trim(); if (v === orig) return;
        try {
          const r = await api('PATCH', `/api/keys/${role}/${e.id}`, { [field]: v });
          if (r.token) { S.token = r.token; sessionStorage.setItem('jpia_token', r.token); }
          if (field === 'name' && e.id === 'president') { S.name = v; }
          toast('Saved.');
        } catch (err) { input.value = orig; toast(err.message, true); }
        refresh();
      });
      if (canEdit) { commit('name', name, e.name); if (e.key != null) commit('key', key, e.key); }
      const del = canDelete
        ? h('button', { class: 'tr-del', html: ICON.redTrash, title: 'Delete access key', 'aria-label': 'Delete access key', onclick: () => confirm(`Delete the access key of ${e.name}? They will be signed out.`) && act(async () => { await api('DELETE', `/api/keys/${role}/${e.id}`); toast('Access key deleted.'); await refresh(); }) })
        : h('span');
      return h('div', { class: 'tr' }, h('span', {}, name), h('span', {}, key), role === 'president' ? null : h('span', {}, del));
    };
    const addRow = (role, enabled) => {
      const name = h('input', { placeholder: 'ADD NAME', maxlength: 60, disabled: !enabled, 'aria-label': 'Add name' });
      const key = h('input', { placeholder: 'ADD ACCESS KEY', maxlength: 64, disabled: !enabled, 'aria-label': 'Add access key', autocomplete: 'off', spellcheck: 'false' });
      const go = () => {
        if (!enabled) return;
        if (!name.value.trim() || !key.value.trim()) return toast('Type a name and an access key first.', true);
        act(async () => { await api('POST', '/api/keys', { role, name: name.value, key: key.value }); toast('Access key added.'); await refresh(); });
      };
      key.addEventListener('keydown', (ev) => ev.key === 'Enter' && go());
      name.addEventListener('keydown', (ev) => ev.key === 'Enter' && key.focus());
      return h('div', { class: 'tr addr' }, h('span', {}, name), h('span', {}, key), h('span', {}, h('button', { class: 'tr-add', onclick: go, 'aria-label': 'Add access key', disabled: !enabled })));
    };
    const section = (cls, label, icon, rows) => h('div', { class: 'sec ' + cls }, h('div', { class: 'who', html: icon }), h('h3', {}, label), h('div', { class: 'tbl' }, rows));

    body.append(
      section('p', 'JPIA President', ICON.president, [editableRow('president', k.president, k.canPresident, false)]),
      section('v', 'JPIA VP', ICON.vp2.replace('stroke="#fff"', 'stroke="#fff"'), [...k.vp.map((e) => editableRow('vp', e, k.canVp, k.canVp)), addRow('vp', k.canVp)]),
      section('s', 'JPIA SC', ICON.sc2, [...k.sc.map((e) => editableRow('sc', e, k.canSc, k.canSc)), addRow('sc', k.canSc)])
    );
  }

  // ------------------------------------------------------------ history page
  async function openHistory() {
    await act(async () => {
      const d = await api('GET', '/api/history');
      const used = Math.max(0, Math.min(100, d.usage.percent || 0));
      $('#used').style.flexBasis = used + '%';
      $('#storage').title = `${(d.usage.usedBytes / 1048576).toFixed(1)} MB used (${used.toFixed(1)}%)`;
      const box = $('#changes'); box.textContent = '';
      if (!d.history.length) box.append(h('div', { class: 'ch none' }, 'No changes yet.'));
      d.history.forEach((c) => box.append(h('div', { class: 'ch', title: `${new Date(c.at).toLocaleString()}${c.detail ? ' — ' + c.detail : ''}` }, h('div', {}, c.who), h('div', {}, c.text))));
      S.view = 'history'; $('#histPage').classList.add('on'); scrollTo(0, 0);
    });
  }

  // ------------------------------------------------------------ wiring (transparent hotspots over the baseline icons)
  document.querySelectorAll('.role').forEach((b) => b.addEventListener('click', (e) => { if (e.target.closest('#plus')) return; if (b.dataset.role !== S.role) openLogin(b.dataset.role); }));
  $('#plus').addEventListener('click', (e) => { e.stopPropagation(); openKeys(); });
  $('#hist').addEventListener('click', openHistory);
  $('#keysClose').innerHTML = ICON.plusBig; $('#keysClose').addEventListener('click', closePages);
  $('#histClose').innerHTML = ICON.ex; $('#histClose').addEventListener('click', closePages);
  $('#keysReturn').addEventListener('click', closePages); $('#histReturn').addEventListener('click', closePages);
  $('#restoreReturn').addEventListener('click', () => $('#restorePop').classList.remove('on'));
  $('#restoreAll').addEventListener('click', purgeAll);
  $('#signas').addEventListener('click', () => { if (isEditor() && confirm('Sign out?')) signOut(false); });
  $('#keyIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); if (e.key === 'Escape') $('#keyPop').classList.remove('on'); });
  $('#keyIn').addEventListener('input', () => $('#keyIn').classList.remove('bad'));
  $('#keyPop').addEventListener('mousedown', (e) => { if (e.target.id === 'keyPop') $('#keyPop').classList.remove('on'); });
  $('#restorePop').addEventListener('mousedown', (e) => { if (e.target.id === 'restorePop') $('#restorePop').classList.remove('on'); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#restorePop').classList.remove('on'); if (S.view !== 'main' && !$('#keyPop').classList.contains('on')) closePages(); } });
  $('#q').addEventListener('input', (e) => { S.q = e.target.value; renderSide(); });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const q = S.q.trim().toLowerCase(); const m = S.albums.find((a) => !q || a.name.toLowerCase().includes(q)); if (m) selectAlbum(m.id); } });
  $('#file').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; uploadFiles(f); });

  // keep every open device in sync (several people can use the site at the same time)
  const poll = () => { if (!document.hidden && S.view === 'main' && !S.editing && !S.upl) load().catch(() => {}); };
  setInterval(poll, 7000);
  document.addEventListener('visibilitychange', poll);
  addEventListener('focus', poll);

  renderAll();
  load(true).catch((e) => toast(e.message, true));
})();
