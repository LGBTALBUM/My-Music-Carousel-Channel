const audio = document.getElementById('audio');
const pv = document.getElementById('pv');
const bg = document.getElementById('bg');
const lyricInner = document.getElementById('lyricInner');
const titleEl = document.getElementById('title');
const albumEl = document.getElementById('album');
const yearEl = document.getElementById('year');

let payload;
let queue = [];
let queueIndex = 0;
let bgTimer = null;
let lyrics = [];
let currentTrack = null;
let albumCursor = 0;

const shuffle = array => array
  .map(value => [Math.random(), value])
  .sort((a, b) => a[0] - b[0])
  .map(pair => pair[1]);

async function assetUrl(relPath) {
  return window.mmcc.dataFileUrl(relPath);
}


async function applyAudioOutputDevice(mediaEl) {
  if (!mediaEl || typeof mediaEl.setSinkId !== 'function') return;

  const settings = payload?.config?.settings || {};
  const deviceId = settings.audioOutputDeviceId || 'default';

  try {
    await mediaEl.setSinkId(deviceId || 'default');
  } catch (error) {
    console.warn('Audio output device switch failed:', error);
  }
}

async function applyAudioOutputs() {
  await Promise.all([
    applyAudioOutputDevice(audio),
    applyAudioOutputDevice(pv)
  ]);
}

function setScrollingText(el, text) {
  el.classList.remove('scroll');
  el.innerHTML = '';

  const span = document.createElement('span');
  span.textContent = text || '';
  el.appendChild(span);

  requestAnimationFrame(() => {
    el.classList.toggle('scroll', span.scrollWidth > el.clientWidth + 4);
  });
}

function setLyricStatus(text, className = 'status') {
  lyrics = [];
  lyricInner.className = className;
  lyricInner.textContent = text;
  lyricInner.style.transform = 'translateY(0)';
}

function pickQueue() {
  const tracks = payload.tracks || [];
  const mode = payload.config.settings.playMode || 'song-random';

  if (!tracks.length) return [];
  if (mode === 'single-loop' && currentTrack) return [currentTrack];
  if (mode === 'song-random') return shuffle(tracks);

  if (mode === 'album-random') {
    const groups = Object.values(tracks.reduce((map, track) => {
      (map[track.albumId] ||= []).push(track);
      return map;
    }, {}));
    return shuffle(groups).flatMap(group => shuffle(group));
  }

  if (mode === 'album-loop') {
    const groups = Object.values(tracks.reduce((map, track) => {
      (map[track.albumId] ||= []).push(track);
      return map;
    }, {}));
    albumCursor = albumCursor % groups.length;
    return groups[albumCursor++];
  }

  return tracks;
}

function nextTrack() {
  const mode = payload.config.settings.playMode || 'song-random';

  if (!queue.length || queueIndex >= queue.length || mode === 'single-loop') {
    queue = pickQueue();
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

  const img = imgs[Math.floor(Math.random() * imgs.length)];
  const bgMode = payload.config.settings.bgMode || 'cover';

  bg.style.backgroundSize = bgMode === 'contain' ? 'contain' : 'cover';
  bg.style.backgroundRepeat = 'no-repeat';
  bg.style.backgroundPosition = 'center';
  bg.style.backgroundImage = `url("${await assetUrl(img)}")`;
}

function parseLrc(text) {
  const output = [];

  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    if (!matches.length) continue;

    const lyricText = line.replace(/\[[^\]]+\]/g, '').trim();

    for (const match of matches) {
      const millis = match[3] ? Number(match[3].padEnd(3, '0')) / 1000 : 0;
      output.push({
        time: Number(match[1]) * 60 + Number(match[2]) + millis,
        text: lyricText
      });
    }
  }

  return output.sort((a, b) => a.time - b.time);
}

async function loadLyrics(track) {
  lyrics = [];
  lyricInner.className = '';
  lyricInner.style.transform = 'translateY(0)';

  if (track.PureMusic || track.pureMusic || track.type === 'PureMusic') {
    setLyricStatus('純音樂，請欣賞', 'pure');
    return;
  }

  if (!track.lyricpath) {
    setLyricStatus('未找到歌詞', 'status');
    return;
  }

  try {
    const text = await window.mmcc.readDataText(track.lyricpath);
    lyrics = parseLrc(text);

    if (!lyrics.length) {
      setLyricStatus('歌詞格式無時間軸', 'status');
      return;
    }

    lyricInner.innerHTML = lyrics
      .map((line, index) => `<div class="lyric-line" data-i="${index}">${escapeHtml(line.text || ' ')}</div>`)
      .join('');
  } catch (error) {
    setLyricStatus('歌詞讀取失敗', 'status');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[ch]));
}

function syncLyrics() {
  if (!lyrics.length) return;

  const time = audio.currentTime;
  let active = 0;

  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].time <= time) active = i;
  }

  document.querySelectorAll('.lyric-line').forEach((el, index) => {
    el.classList.toggle('active', index === active);
  });

  const activeLine = document.querySelector(`.lyric-line[data-i="${active}"]`);
  const wrap = document.getElementById('lyrics');

  if (!activeLine || !wrap) return;

  const lineCenter = activeLine.offsetTop + activeLine.offsetHeight / 2;
  const desired = wrap.clientHeight * 0.48 - lineCenter;
  const maxUp = Math.min(0, wrap.clientHeight - lyricInner.scrollHeight - 24);
  const target = Math.max(maxUp, Math.min(0, desired));

  lyricInner.style.transform = `translateY(${target}px)`;
}

function stopMedia() {
  clearInterval(bgTimer);
  bgTimer = null;

  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  pv.pause();
  pv.removeAttribute('src');
  pv.load();
  pv.classList.add('hidden');
  document.body.classList.remove('pv-mode');
}

async function playAudioWithBackground(track) {
  await rotateBg();
  bgTimer = setInterval(() => rotateBg(), 40000);

  await loadLyrics(track);
  await applyAudioOutputs();
  syncLyrics();

  audio.src = await assetUrl(track.musicpath);
  audio.ontimeupdate = syncLyrics;
  audio.onended = startNext;
  audio.onerror = startNext;

  try {
    await audio.play();
  } catch (error) {
    setLyricStatus('音訊播放失敗', 'status');
  }
}

async function playTrack(track) {
  currentTrack = track;
  stopMedia();

  setScrollingText(titleEl, track.title || '歌曲名');
  setScrollingText(albumEl, track.albumTitle || track.album || '收錄專輯');
  setScrollingText(yearEl, track.year || track.albumYear || '年份');

  document.body.style.fontFamily = payload.config.settings.fontFamily || '';

  const canPV = payload.config.settings.enablePV !== false && track.videopath;

  if (canPV) {
    document.body.classList.add('pv-mode');
    pv.src = await assetUrl(track.videopath);
    await applyAudioOutputs();
    pv.classList.remove('hidden');
    pv.onended = startNext;
    pv.onerror = () => playAudioWithBackground(track);

    try {
      await pv.play();
      return;
    } catch (error) {
      document.body.classList.remove('pv-mode');
      pv.classList.add('hidden');
    }
  }

  await playAudioWithBackground(track);
}

function startNext() {
  const track = nextTrack();
  if (track) {
    playTrack(track);
  }
}


window.addEventListener('keydown', async event => {
  if (event.key === 'F11') {
    event.preventDefault();
    await window.mmcc.togglePlayerFullscreen?.();
  } else if (event.key === 'Escape') {
    await window.mmcc.setPlayerFullscreen?.(false);
  }
});

async function init() {
  payload = await window.mmcc.getLibrary();

  if (!payload.tracks.length) {
    setLyricStatus('尚未入庫作品', 'status');
    return;
  }

  startNext();
}

init().catch(error => {
  console.error(error);
  setLyricStatus(`播放器初始化失敗：${error.message}`, 'status');
});
