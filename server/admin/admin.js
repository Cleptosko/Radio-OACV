/* ============================================================
   RADIO OACV — panneau d'administration (côté navigateur)
   Aucun secret ici : le jeton anti-CSRF est fourni par le serveur
   et ne donne accès à rien sans la session signée.
   ============================================================ */
'use strict';

const $ = id => document.getElementById(id);

const state = {
  user: null,
  csrf: '',
  perms: [],
  status: null,
  tab: null,
  announcements: [],
  recorder: null,
  blob: null,
  durationMs: 0,
};

/* état du vumètre (hors de state : il contient des objets du navigateur) */
const meterState = { raf: 0, analyser: null, data: null, ac: null };

/* ------------------------------------------------------------
   Appels au serveur
   ------------------------------------------------------------ */
async function api(path, { method = 'GET', body = null, form = null } = {}){
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body != null){ opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (form){ opt.body = form; }
  if (method !== 'GET' && method !== 'HEAD') opt.headers['X-CSRF-Token'] = state.csrf;

  const r = await fetch(path, opt);
  const ct = r.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) data = await r.json().catch(() => ({}));
  else data = { error: await r.text().catch(() => '') };
  if (!r.ok){
    const err = new Error(data.error || ('erreur ' + r.status));
    err.status = r.status;
    throw err;
  }
  return data;
}

function say(el, msg, kind = ''){
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

const can = perm => state.user && (state.user.role === 'owner' || state.perms.includes(perm));

function fmtDuration(ms){
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function fmtDate(iso){
  if (!iso) return '—';
  const tz = (state.status && state.status.fuseau) || undefined;
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  } catch { return new Date(iso).toLocaleString('fr-FR'); }
}
function fmtSize(bytes){
  if (!bytes) return '';
  return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' Mo' : Math.round(bytes / 1024) + ' Ko';
}

/* petit constructeur d'éléments, sans innerHTML (aucune injection possible) */
function el(tag, attrs = {}, ...children){
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)){
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

/* ------------------------------------------------------------
   Démarrage
   ------------------------------------------------------------ */
async function boot(){
  try {
    const me = await api('/api/me');
    state.csrf = me.csrf;
    if (!me.user) return showGate();
    state.user = me.user;
    state.perms = me.permissions || [];
    return showApp();
  } catch (e){
    showGate(e.message);
  }
}

function showGate(message){
  $('app').hidden = true;
  $('gate').hidden = false;
  if (message) {
    $('login-error').textContent = message;
    $('login-error').hidden = false;
  }
}

async function showApp(){
  $('gate').hidden = true;
  $('app').hidden = false;
  $('who-name').textContent = state.user.name;
  $('who-role').textContent = state.user.role === 'owner' ? 'propriétaire' : 'collaborateur';
  $('my-perms').textContent = state.perms.join(', ') || 'aucune';

  for (const tab of document.querySelectorAll('.tab')){
    const perm = { annonces: 'announcements', programmation: 'schedule', musique: 'library', pubs: 'ads', reglages: null }[tab.dataset.tab];
    const allowed = perm ? can(perm) : true;
    tab.hidden = !allowed;
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }
  const first = [...document.querySelectorAll('.tab')].find(t => !t.hidden);
  selectTab(first ? first.dataset.tab : 'reglages');

  await refreshStatus();
  $('tz-label').textContent = (state.status && state.status.fuseau) || '';
  startEvents();
  buildDays();
  await refreshAnnouncements();
  buildTargets();
  if (can('schedule')) await refreshSchedules();
  if (can('library')) await loadLibrary('music');
  if (can('ads')) await loadLibrary('ads');
  initRecorder();
}

function selectTab(name){
  state.tab = name;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('on', tab.dataset.tab === name);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== 'panel-' + name;
  if (name === 'programmation' && can('schedule')) refreshSchedules();
}

/* ------------------------------------------------------------
   Connexion / déconnexion
   ------------------------------------------------------------ */
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('login-submit');
  $('login-error').hidden = true;
  btn.disabled = true;
  btn.textContent = 'Connexion…';
  try {
    await api('/api/login', { method: 'POST', body: { email: $('login-email').value, password: $('login-password').value } });
    $('login-password').value = '';
    await boot();
  } catch (err){
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
    $('login-password').value = '';
    $('login-password').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Se connecter';
  }
});

$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignoré */ }
  location.reload();
});

/* ------------------------------------------------------------
   État du serveur (rafraîchi en direct)
   ------------------------------------------------------------ */
function renderStatus(s){
  state.status = s;
  $('clock').textContent = s.heureLocale;
  const st = $('stream-state');
  st.textContent = s.diffusion.fluxPret ? 'Flux : en direct' : 'Flux : en préparation';
  st.classList.toggle('ok', !!s.diffusion.fluxPret);
  const tz = s.fuseau;

  $('lib-counts').textContent = s.banque ? `${s.banque.music.enabled} musiques actives sur ${s.banque.music.total}` : '—';
  $('ads-counts').textContent = s.banque ? `${s.banque.ads.enabled} publicités actives sur ${s.banque.ads.total}` : '—';
  $('ann-usage').textContent = s.annonces ? `${s.annonces.count} annonce(s) — ${fmtSize(s.annonces.bytes)}` : '';

  const kv = $('state-kv');
  kv.textContent = '';
  const rows = [
    ['Heure locale', s.heureLocale],
    ['Fuseau', tz],
    ['Flux audio', s.diffusion.fluxPret ? 'en direct' : 'non démarré — ' + s.diffusion.raison],
    ['Point de montage', s.diffusion.montee],
    ['Adresse publique', s.diffusion.adressePublique || 'à définir (STREAM_PUBLIC_URL)'],
    ['Musiques', s.banque ? `${s.banque.music.enabled} / ${s.banque.music.total}` : '—'],
    ['Publicités', s.banque ? `${s.banque.ads.enabled} / ${s.banque.ads.total}` : '—'],
    ['Annonces enregistrées', s.annonces ? String(s.annonces.count) : '—'],
    ['File d\'insertion', String((s.file || []).length)],
    ['Moteur', s.moteur.version],
  ];
  for (const [k, v] of rows) kv.append(el('dt', { text: k }), el('dd', { text: v }));

  if (state.tab === 'programmation') renderQueue(s.file || []);
}

async function refreshStatus(){
  try { renderStatus(await api('/api/status')); } catch (e){ if (e.status === 401) showGate('session expirée'); }
}

function startEvents(){
  const src = new EventSource('/api/events');
  src.addEventListener('message', ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'status') renderStatus(msg.data);
    } catch { /* ignoré */ }
  });
  src.addEventListener('error', () => {
    /* le flux se reconnecte tout seul ; on vérifie juste la session */
    if (src.readyState === EventSource.CLOSED) refreshStatus();
  });
}

/* ------------------------------------------------------------
   Enregistreur micro
   ------------------------------------------------------------ */
function initRecorder(){
  const canvas = $('rec-meter');
  const ctx = canvas.getContext('2d');

  const drawIdle = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(150,140,220,.25)';
    ctx.fillRect(0, canvas.height / 2, canvas.width, 1);
  };
  drawIdle();

  $('rec-start').addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia){
      return say($('rec-status'), 'Ce navigateur ne donne pas accès au microphone.', 'err');
    }
    say($('rec-status'), 'demande d\'accès au microphone…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      state.recorder = { rec, stream, chunks: [], startedAt: Date.now(), mime: mime || rec.mimeType || 'audio/webm' };
      rec.ondataavailable = e => { if (e.data && e.data.size) state.recorder.chunks.push(e.data); };
      rec.onstop = () => finishRecording();
      rec.start(250);

      $('rec-start').hidden = true;
      $('rec-stop').hidden = false;
      $('rec-reset').hidden = true;
      $('rec-preview').hidden = true;
      $('ann-upload').disabled = true;
      say($('rec-status'), 'enregistrement en cours…', 'ok');
      tickTime();
      startMeter(stream, ctx, canvas, meterState);
    } catch (e){
      say($('rec-status'), 'micro refusé ou indisponible : ' + e.message, 'err');
    }
  });

  $('rec-stop').addEventListener('click', () => {
    if (state.recorder) state.recorder.rec.stop();
  });

  $('rec-reset').addEventListener('click', () => {
    state.blob = null;
    state.durationMs = 0;
    $('ann-upload').disabled = true;
    $('rec-preview').hidden = true;
    $('rec-start').hidden = false;
    $('rec-stop').hidden = true;
    $('rec-reset').hidden = true;
    $('rec-time').textContent = '00:00';
    drawIdle();
    say($('rec-status'), '');
  });

  $('ann-upload').addEventListener('click', uploadRecording);
}

function pickMime(){
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of candidates){
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c; } catch { /* suivant */ }
  }
  return '';
}

let tickTimer = 0;
function tickTime(){
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!state.recorder) return;
    const ms = Date.now() - state.recorder.startedAt;
    $('rec-time').textContent = fmtDuration(ms);
    if (ms > 55 * 60 * 1000){                       // sécurité : 55 minutes maximum
      $('rec-stop').click();
    }
  }, 200);
}

function startMeter(stream, ctx, canvas, meter){
  stopMeter(meter);
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    meter.ac = ac;
    meter.analyser = analyser;
    meter.data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      meter.raf = requestAnimationFrame(loop);
      analyser.getByteTimeDomainData(meter.data);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(9,7,20,0)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const mid = canvas.height / 2;
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#7d6cf0';
      for (let i = 0; i < meter.data.length; i++){
        const x = (i / (meter.data.length - 1)) * canvas.width;
        const v = (meter.data[i] - 128) / 128;
        const y = mid + v * (canvas.height / 2 - 4);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    loop();
  } catch { /* le niveau n'est qu'un confort */ }
}

function stopMeter(meter){
  if (meter.raf) cancelAnimationFrame(meter.raf);
  meter.raf = 0;
  try { meter.ac && meter.ac.close(); } catch { /* ignoré */ }
  meter.analyser = null;
}

async function finishRecording(){
  const rec = state.recorder;
  if (!rec) return;
  const durationMs = Date.now() - rec.startedAt;
  clearInterval(tickTimer);
  try { rec.rec.stream.getTracks().forEach(t => t.stop()); } catch { /* ignoré */ }
  stopMeter(meterState);

  const type = (rec.chunks[0] && rec.chunks[0].type) || rec.mime || 'audio/webm';
  state.blob = new Blob(rec.chunks, { type });
  state.durationMs = durationMs;
  state.recorder = null;

  if (!state.blob.size){
    return say($('rec-status'), 'rien n\'a été enregistré, réessayez.', 'err');
  }

  const url = URL.createObjectURL(state.blob);
  $('rec-audio').src = url;
  $('rec-preview').hidden = false;
  $('rec-start').hidden = false;
  $('rec-stop').hidden = true;
  $('rec-reset').hidden = false;
  $('ann-upload').disabled = false;
  $('rec-time').textContent = fmtDuration(durationMs);
  say($('rec-status'), `enregistrement prêt (${fmtDuration(durationMs)}, ${fmtSize(state.blob.size)}) — écoutez puis validez.`, 'ok');
  if (!$('ann-title').value) $('ann-title').focus();
}

async function uploadRecording(){
  if (!state.blob) return;
  const btn = $('ann-upload');
  btn.disabled = true;
  say($('rec-status'), 'envoi vers la radio…');

  const form = new FormData();
  const ext = (state.blob.type.includes('ogg') ? 'ogg' : state.blob.type.includes('mp4') ? 'm4a' : state.blob.type.includes('mpeg') ? 'mp3' : 'webm');
  form.append('audio', state.blob, 'annonce.' + ext);
  form.append('title', $('ann-title').value || 'Annonce sans titre');
  form.append('mime', state.blob.type || 'audio/webm');
  form.append('durationMs', String(state.durationMs));
  form.append('source', 'micro');

  try {
    const res = await api('/api/announcements', { method: 'POST', form });
    /* on recharge la liste et on remet le formulaire à zéro AVANT d'afficher
       la confirmation : sinon « Recommencer » efface le message aussitôt */
    await refreshAnnouncements();
    buildTargets(res.item.id);
    $('ann-title').value = '';
    $('rec-reset').click();
    say($('rec-status'), 'annonce envoyée à la radio : « ' + res.item.title + ' » — vous pouvez la programmer.', 'ok');
  } catch (e){
    say($('rec-status'), 'envoi impossible : ' + e.message, 'err');
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------
   Annonces enregistrées
   ------------------------------------------------------------ */
async function refreshAnnouncements(){
  let data;
  try { data = await api('/api/announcements'); }
  catch (e){ if (e.status !== 401) say($('rec-status'), e.message, 'err'); return; }
  state.announcements = data.items;
  $('ann-usage').textContent = `${data.usage.count} annonce(s) enregistrée(s) — ${fmtSize(data.usage.bytes)} (maximum ${Math.round(data.maxBytes / 1048576)} Mo par fichier)`;

  const list = $('ann-list');
  list.textContent = '';
  if (!data.items.length){
    list.append(el('li', { class: 'empty', text: 'Aucune annonce pour l\'instant.' }));
    return;
  }
  for (const a of data.items){
    const audio = el('audio', { controls: '', preload: 'none', src: a.audioUrl, class: 'ann-audio' });
    audio.style.display = 'none';
    const play = el('button', { class: 'btn ghost small', text: '▶ Écouter', onclick: () => {
      const showing = audio.style.display !== 'none';
      document.querySelectorAll('.ann-audio').forEach(x => { x.pause(); x.style.display = 'none'; });
      if (!showing){ audio.style.display = 'block'; audio.play().catch(() => {}); }
    } });
    const program = can('schedule')
      ? el('button', { class: 'btn small', text: '📅 Programmer', onclick: () => {
          selectTab('programmation');
          buildTargets(a.id);
          $('sch-title').value = a.title;
          $('sch-title').focus();
        } })
      : null;
    const del = el('button', { class: 'btn ghost small', text: '🗑', title: 'Supprimer', onclick: async () => {
      if (!confirm('Supprimer définitivement « ' + a.title + ' » ?')) return;
      try { await api('/api/announcements/' + encodeURIComponent(a.id), { method: 'DELETE' }); await refreshAnnouncements(); buildTargets(); }
      catch (e){ alert(e.message); }
    } });

    list.append(el('li', {},
      el('div', { class: 'meta' },
        el('strong', { text: a.title }),
        el('small', { text: `${a.durationMs ? fmtDuration(a.durationMs) : ''} ${fmtSize(a.bytes)} · ${fmtDate(a.createdAt)} · ${a.createdBy}` }),
        audio,
      ),
      el('div', { class: 'acts' }, play, program, del),
    ));
  }
}

/* ------------------------------------------------------------
   Programmation
   ------------------------------------------------------------ */
const DAY_LABELS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

function buildDays(){
  const wrap = $('sch-days');
  wrap.textContent = '';
  DAY_LABELS.forEach((label, i) => {
    wrap.append(el('label', {},
      el('input', { type: 'checkbox', value: String(i + 1), 'data-day': String(i + 1) }),
      el('span', { text: label }),
    ));
  });
}

function buildTargets(selectId){
  const sel = $('sch-target');
  const previous = selectId || sel.value;
  sel.textContent = '';
  if (can('announcements')){
    const group = el('optgroup', { label: 'Annonces enregistrées' });
    for (const a of state.announcements) group.append(el('option', { value: 'ann:' + a.id, text: a.title }));
    if (!state.announcements.length) group.append(el('option', { value: '', text: '— aucune annonce enregistrée —', disabled: '' }));
    sel.append(group);
  }
  sel.append(el('optgroup', { label: 'Éléments de l\'antenne' },
    el('option', { value: 'asset:jingle', text: 'Jingle Radio OACV' }),
    el('option', { value: 'asset:puboacv', text: 'Publicité OACV (maison)' }),
  ));
  if (previous) sel.value = previous;
}

function currentMode(){
  const checked = document.querySelector('input[name=mode]:checked');
  return checked ? checked.value : 'now';
}

function syncModeFields(){
  const mode = currentMode();
  $('when-once').hidden = mode !== 'once';
  $('when-time').hidden = !(mode === 'daily' || mode === 'weekly');
  $('when-days').hidden = mode !== 'weekly';
}

for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', syncModeFields);
syncModeFields();

$('sch-create').addEventListener('click', async () => {
  const value = $('sch-target').value;
  if (!value) return say($('sch-status'), 'enregistrez d\'abord une annonce.', 'err');

  const body = {
    title: $('sch-title').value || null,
    mode: currentMode(),
    time: $('sch-time').value,
    at: $('sch-at').value,
    days: [...document.querySelectorAll('#sch-days input:checked')].map(i => Number(i.value)),
  };
  if (value.startsWith('ann:')) body.announcementId = value.slice(4);
  else body.asset = value.slice(6);

  if (body.mode === 'once' && !body.at) return say($('sch-status'), 'choisissez une date et une heure.', 'err');
  if (body.mode === 'weekly' && !body.days.length) return say($('sch-status'), 'choisissez au moins un jour.', 'err');

  try {
    const res = await api('/api/schedules', { method: 'POST', body });
    say($('sch-status'), 'ajouté : ' + res.item.human, 'ok');
    $('sch-title').value = '';
    await refreshSchedules();
    buildTargets();
  } catch (e){
    say($('sch-status'), e.message, 'err');
  }
});

async function refreshSchedules(){
  let data;
  try { data = await api('/api/schedules'); }
  catch (e){ if (e.status !== 401) say($('sch-status'), e.message, 'err'); return; }

  const list = $('sch-list');
  list.textContent = '';
  if (!data.items.length){
    list.append(el('li', { class: 'empty', text: 'Rien de programmé.' }));
  } else {
    for (const s of data.items){
      const enabled = !!s.enabled;
      const toggle = el('button', {
        class: 'btn ghost small', text: enabled ? '⏸ Pause' : '▶ Activer',
        onclick: async () => {
          try { await api('/api/schedules/' + encodeURIComponent(s.id), { method: 'PATCH', body: { enabled: !enabled } }); await refreshSchedules(); }
          catch (e){ alert(e.message); }
        },
      });
      const del = el('button', { class: 'btn ghost small', text: '🗑', onclick: async () => {
        if (!confirm('Supprimer « ' + s.title + ' » ?')) return;
        try { await api('/api/schedules/' + encodeURIComponent(s.id), { method: 'DELETE' }); await refreshSchedules(); }
        catch (e){ alert(e.message); }
      } });
      list.append(el('li', {},
        el('div', { class: 'meta' },
          el('strong', { text: s.title }),
          el('small', { text: s.human + (s.nextRunLabel ? ' · prochain : ' + s.nextRunLabel : '') }),
        ),
        el('div', { class: 'acts' },
          el('span', { class: 'tag' + (enabled ? '' : ' off'), text: enabled ? 'active' : 'en pause' }),
          toggle, del,
        ),
      ));
    }
  }
  renderQueue(data.queue || []);
}

function renderQueue(items){
  const list = $('queue-list');
  if (!list) return;
  list.textContent = '';
  if (!items.length){
    list.append(el('li', { class: 'empty', text: 'File vide.' }));
    return;
  }
  for (const q of items){
    list.append(el('li', {},
      el('div', { class: 'meta' },
        el('strong', { text: q.label }),
        el('small', { text: (q.insert === 'after_music' ? 'à la fin de la musique' : 'prochaine coupure') + ' · demandé par ' + q.requestedBy }),
      ),
      el('div', { class: 'acts' },
        el('span', { class: 'tag', text: q.status === 'playing' ? 'à l\'antenne' : 'en attente' }),
        el('button', { class: 'btn ghost small', text: '✕', title: 'Retirer', onclick: async () => {
          try { await api('/api/queue/' + encodeURIComponent(q.id) + '/cancel', { method: 'POST' }); await refreshSchedules(); }
          catch (e){ alert(e.message); }
        } }),
      ),
    ));
  }
}

/* ------------------------------------------------------------
   Banque : musiques et publicités
   ------------------------------------------------------------ */
async function loadLibrary(kind, { refresh = false, query = '' } = {}){
  const isAds = kind === 'ads';
  const statusEl = $(isAds ? 'ads-status' : 'lib-status');
  const listEl = $(isAds ? 'ads-list' : 'lib-list');
  const btn = $(isAds ? 'ads-refresh' : 'lib-refresh');

  if (refresh){
    btn.disabled = true;
    say(statusEl, 'mise à jour depuis YouTube… (cela peut prendre une dizaine de secondes)');
    try {
      const res = await api(`/api/library/${kind}/refresh`, { method: 'POST' });
      say(statusEl, res.count + ' titres chargés.', 'ok');
    } catch (e){
      say(statusEl, 'échec : ' + e.message, 'err');
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
  }

  let data;
  try { data = await api(`/api/library/${kind}?limit=2000`); }
  catch (e){ say(statusEl, e.message, 'err'); return; }

  if (isAds){
    $('set-jingle').checked = !!data.settings.jingleEnabled;
    $('set-puboacv').checked = !!data.settings.puboacvEnabled;
    $('set-weight').value = data.settings.puboacvWeight;
  }

  const q = (query || '').trim().toLowerCase();
  const items = q ? data.items.filter(v => (v.title + ' ' + v.author).toLowerCase().includes(q)) : data.items;
  $(isAds ? 'ads-counts' : 'lib-counts').textContent =
    `${data.counts.enabled} actifs sur ${data.counts.total}` + (data.cachedAt ? ` · liste du ${fmtDate(data.cachedAt)}` : ' · liste jamais chargée') + (q ? ` · ${items.length} résultat(s)` : '');

  listEl.textContent = '';
  if (!items.length){
    listEl.append(el('li', { class: 'empty', text: data.counts.total ? 'Aucun résultat.' : 'Liste vide : cliquez sur « Mettre à jour ».' }));
    return;
  }

  for (const v of items.slice(0, 400)){
    const toggle = el('button', {
      class: 'btn ghost small', text: v.enabled ? 'Désactiver' : 'Activer',
      onclick: async () => {
        try {
          await api(`/api/library/${kind}`, { method: 'PATCH', body: { id: v.id, enabled: !v.enabled } });
          v.enabled = !v.enabled;
          loadLibrary(kind, { query: $(isAds ? 'ads-search' : 'lib-search').value });
        } catch (e){ alert(e.message); }
      },
    });
    const remove = v.source === 'manuel'
      ? el('button', { class: 'btn ghost small', text: '🗑', title: 'Retirer', onclick: async () => {
          if (!confirm('Retirer « ' + (v.title || v.id) + ' » ?')) return;
          try { await api(`/api/library/${kind}/${encodeURIComponent(v.id)}`, { method: 'DELETE' }); loadLibrary(kind); }
          catch (e){ alert(e.message); }
        } })
      : null;

    listEl.append(el('li', {},
      v.thumb ? el('img', { src: v.thumb, alt: '', loading: 'lazy' }) : null,
      el('div', { class: 'meta' },
        el('strong', { text: v.title || v.id }),
        el('small', { text: [v.author, v.duration ? fmtDuration(v.duration * 1000) : '', v.local ? 'fichier local' : 'YouTube'].filter(Boolean).join(' · ') }),
      ),
      el('div', { class: 'acts' },
        el('span', { class: 'tag' + (v.enabled ? '' : ' off') + (v.local ? ' local' : ''), text: v.enabled ? 'actif' : 'désactivé' }),
        toggle, remove,
      ),
    ));
  }
}

for (const kind of ['music', 'ads']){
  const isAds = kind === 'ads';
  const search = $(isAds ? 'ads-search' : 'lib-search');
  let debounce = 0;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadLibrary(kind, { query: search.value }), 200);
  });
  $(isAds ? 'ads-refresh' : 'lib-refresh').addEventListener('click', () => loadLibrary(kind, { refresh: true, query: search.value }));
}

$('lib-add-btn').addEventListener('click', async () => {
  const url = $('lib-add').value.trim();
  if (!url) return;
  try {
    const res = await api('/api/library/music/add', { method: 'POST', body: { url } });
    say($('lib-status'), 'ajouté : ' + (res.item.title || res.item.id), 'ok');
    $('lib-add').value = '';
    loadLibrary('music');
  } catch (e){
    say($('lib-status'), e.message, 'err');
  }
});

$('set-save').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'PATCH', body: {
      jingleEnabled: $('set-jingle').checked,
      puboacvEnabled: $('set-puboacv').checked,
      puboacvWeight: Number($('set-weight').value),
    } });
    say($('ads-status'), 'réglages enregistrés.', 'ok');
    loadLibrary('ads');
  } catch (e){
    say($('ads-status'), e.message, 'err');
  }
});

/* ------------------------------------------------------------ */
boot();
setInterval(() => { if (state.user) refreshStatus(); }, 20000);
