const audio = document.getElementById('audio');
const pv = document.getElementById('pv');
const bg = document.getElementById('bg');
const lyricInner = document.getElementById('lyricInner');
const titleEl = document.getElementById('title');
const albumEl = document.getElementById('album');
const yearEl = document.getElementById('year');
let payload, queue = [], queueIndex = 0, bgTimer = null, lyrics = [], currentTrack = null, albumCursor = 0;

const shuffle = a => a.map(v=>[Math.random(),v]).sort((x,y)=>x[0]-y[0]).map(x=>x[1]);
const url = p => p ? `file://${payload.dataDir.replaceAll('\\','/')}/${p}` : '';

function pickQueue(){
  const tracks = payload.tracks;
  const mode = payload.config.settings.playMode || 'song-random';
  if (!tracks.length) return [];
  if (mode === 'song-random') return shuffle(tracks);
  if (mode === 'album-random') {
    const groups = Object.values(tracks.reduce((m,t)=>((m[t.albumId] ||= []).push(t),m),{}));
    return shuffle(groups).flatMap(g=>shuffle(g));
  }
  if (mode === 'album-loop') {
    const groups = Object.values(tracks.reduce((m,t)=>((m[t.albumId] ||= []).push(t),m),{}));
    albumCursor = albumCursor % groups.length;
    return groups[albumCursor++];
  }
  return tracks;
}
function nextTrack(){
  if (!queue.length || queueIndex >= queue.length || payload.config.settings.playMode === 'single-loop') { queue = pickQueue(); queueIndex = 0; }
  return queue[queueIndex++];
}
function rotateBg(){
  const imgs = payload.bgImages || [];
  if (!imgs.length) { bg.style.backgroundImage = ''; return; }
  const img = imgs[Math.floor(Math.random()*imgs.length)];
  bg.style.backgroundSize = payload.config.settings.bgMode === 'contain' ? 'contain' : 'cover';
  bg.style.backgroundRepeat = 'no-repeat';
  bg.style.backgroundImage = `url("${url(img)}")`;
}
function parseLrc(text){
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/);
    if (!m) continue;
    out.push({ time: Number(m[1])*60 + Number(m[2]) + Number(`0.${m[3]||0}`), text: m[4].trim() });
  }
  return out.sort((a,b)=>a.time-b.time);
}
async function loadLyrics(track){
  lyrics = [];
  if (track.PureMusic || track.pureMusic || track.type === 'PureMusic') { lyricInner.textContent = '純音樂，請欣賞'; return; }
  if (!track.lyricpath) { lyricInner.textContent = '未找到歌詞'; return; }
  try { const text = await fetch(url(track.lyricpath)).then(r=>r.text()); lyrics = parseLrc(text); lyricInner.innerHTML = lyrics.map((l,i)=>`<div class="lyric-line" data-i="${i}">${l.text || ' '}</div>`).join(''); }
  catch { lyricInner.textContent = '歌詞讀取失敗'; }
}
function syncLyrics(){
  if (!lyrics.length) return;
  const t = audio.currentTime;
  let active = 0;
  for (let i=0;i<lyrics.length;i++) if (lyrics[i].time <= t) active = i;
  document.querySelectorAll('.lyric-line').forEach((el,i)=>el.classList.toggle('active',i===active));
  lyricInner.style.transform = `translateY(${Math.max(0, 260 - active * 92)}px)`;
}
async function playTrack(track){
  currentTrack = track;
  titleEl.textContent = track.title || '歌曲名';
  albumEl.textContent = track.albumTitle || track.album || '收錄專輯';
  yearEl.textContent = track.year || track.albumYear || '年份';
  document.body.style.fontFamily = payload.config.settings.fontFamily;
  clearInterval(bgTimer); bgTimer = null;
  audio.pause(); pv.pause(); pv.classList.add('hidden');
  const canPV = payload.config.settings.enablePV !== false && track.videopath;
  if (canPV) { pv.src = url(track.videopath); pv.classList.remove('hidden'); pv.onended = startNext; await pv.play().catch(startNext); return; }
  rotateBg(); bgTimer = setInterval(rotateBg, 40000);
  await loadLyrics(track);
  audio.src = url(track.musicpath); audio.ontimeupdate = syncLyrics; audio.onended = startNext; await audio.play().catch(()=>{});
}
function startNext(){ const track = nextTrack(); if (track) playTrack(track); }
async function init(){
  payload = await window.mmcc.getLibrary();
  if (!payload.tracks.length) { lyricInner.textContent = '尚未入庫作品'; return; }
  startNext();
}
init();
