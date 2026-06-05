const audio = document.getElementById('audio');
const pv = document.getElementById('pv');
const bg = document.getElementById('bg');
const lyricInner = document.getElementById('lyricInner');
const titleEl = document.getElementById('title');
const albumEl = document.getElementById('album');
const yearEl = document.getElementById('year');

let payload = null;
let queue = [];
let queueIndex = 0;
let bgTimer = null;
let lyrics = [];
let currentTrack = null;
let currentAlbumCursor = 0;

function shuffle(items) {
  return items.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(v => v[1]);
}

async function fileUrl(relPath) {
  return window.mmcc.dataFileUrl(relPath);
}

function setStatus(text, className = 'status') {
  lyrics = [];
  lyricInner.className = className;
  lyricInner.textContent = text;
  lyricInner.style.transform = 'translateY(0)';
}

function setScrollingText(el, text) {
  el.classList.remove('scroll');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text || '';
  el.appendChild(span);

  requestAnimationFrame(() => {
    el.classList.toggle('scroll', span.scrollWidth > el.clientWidth + 8);
  });
}

function groupedByAlbum() {
  const map = new Map();
  for (const track of payload.tracks || []) {
    const key = track.albumId || track.albumTitle || 'Single';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(track);
  }
  return Array.from(map.values());
}

function buildQueue() {
  const tracks = payload.tracks || [];
  const mode = payload.config?.settings?.playMode || 'song-random';
  if (!tracks.length) return [];

  if (mode === 'song-random') return shuffle(tracks);
  if (mode === 'song-loop') return [...tracks];

  const groups = groupedByAlbum();
  if (mode === 'album-random') return shuffle(groups).flatMap(group => group);
  if (mode === 'album-loop') {
    const group = groups[currentAlbumCursor % groups.length] || [];
    currentAlbumCursor += 1;
    return [...group];
  }

  return [...tracks];
}

function nextTrack() {
  const mode = payload.config?.settings?.playMode || 'song-random';
  if (mode === 'single-loop' && currentTrack) return currentTrack;

  if (!queue.length || queueIndex >= queue.length) {
    queue = buildQueue();
    queueIndex = 0;
  }
  return queue[queueIndex++];
}

async function rotateBg() {
  const imgs = payload.bgImages || [];
  if (!imgs.length) {
    bg.style.backgroundImage = '';
    return;
  }

  const rel = imgs[Math.floor(Math.random() * imgs.length)];
  const src = await fileUrl(rel);
  bg.style.backgroundImage = `url("${src}")`;
  bg.style.backgroundSize = (payload.config?.settings?.bgMode || 'cover') === 'contain' ? 'contain' : 'cover';
}

function parseLrc(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!matches.length) continue;
    const lyricText = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
    for (const m of matches) {
      const ms = Number((m[3] || '0').padEnd(3, '0').slice(0, 3)) / 1000;
      out.push({ time: Number(m[1]) * 60 + Number(m[2]) + ms, text: lyricText });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

async function loadLyrics(track) {
  lyrics = [];
  lyricInner.className = '';
  lyricInner.style.transform = 'translateY(0)';

  if (track.PureMusic || track.pureMusic || !track.lyricpath) {
    setStatus('純音樂，請欣賞', 'pure');
    return;
  }

  try {
    const text = await window.mmcc.readDataText(track.lyricpath);
    lyrics = parseLrc(text);
    if (!lyrics.length) {
      setStatus('歌詞格式無時間軸', 'status');
      return;
    }

    lyricInner.innerHTML = lyrics
      .map((line, index) => `<div class="lyric-line" data-i="${index}">${escapeHtml(line.text || ' ')}</div>`)
      .join('');
  } catch (err) {
    setStatus('歌詞讀取失敗', 'status');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function syncLyrics() {
  if (!lyrics.length) return;

  const t = audio.currentTime;
  let active = 0;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].time <= t) active = i;
    else break;
  }

  const lines = document.querySelectorAll('.lyric-line');
  lines.forEach((line, i) => line.classList.toggle('active', i === active));

  const activeLine = lines[active];
  const wrap = document.getElementById('lyrics');
  if (!activeLine || !wrap) return;

  const offset = Math.min(0, wrap.clientHeight * 0.48 - activeLine.offsetTop);
  lyricInner.style.transform = `translateY(${offset}px)`;
}

function stopCurrentMedia() {
  clearInterval(bgTimer);
  bgTimer = null;

  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audio.ontimeupdate = null;
  audio.onended = null;
  audio.onerror = null;

  pv.pause();
  pv.removeAttribute('src');
  pv.load();
  pv.onended = null;
  pv.onerror = null;
  pv.classList.add('hidden');
  document.body.classList.remove('pv-mode');
}

async function playTrack(track) {
  currentTrack = track;
  stopCurrentMedia();

  document.body.style.fontFamily = payload.config?.settings?.fontFamily || '';
  setScrollingText(titleEl, track.title || '歌曲名');
  setScrollingText(albumEl, track.albumTitle || track.album || '收錄專輯');
  setScrollingText(yearEl, track.year || track.albumYear || '年份');

  const enablePV = payload.config?.settings?.enablePV !== false;
  if (enablePV && track.videopath) {
    document.body.classList.add('pv-mode');
    pv.src = await fileUrl(track.videopath);
    pv.classList.remove('hidden');
    pv.onended = startNext;
    pv.onerror = startNext;
    await pv.play().catch(startNext);
    return;
  }

  await rotateBg();
  bgTimer = setInterval(rotateBg, 40000);
  await loadLyrics(track);

  audio.src = await fileUrl(track.musicpath);
  audio.ontimeupdate = syncLyrics;
  audio.onended = startNext;
  audio.onerror = startNext;
  await audio.play().catch(err => {
    setStatus('播放失敗，請檢查音訊路徑', 'status');
    console.error(err);
  });
}

function startNext() {
  const track = nextTrack();
  if (!track) {
    setStatus('尚未入庫作品', 'status');
    return;
  }
  playTrack(track);
}

async function init() {
  payload = await window.mmcc.getLibrary();
  if (!payload.tracks || !payload.tracks.length) {
    setStatus('尚未入庫作品', 'status');
    return;
  }
  startNext();
}

window.addEventListener('DOMContentLoaded', init);
