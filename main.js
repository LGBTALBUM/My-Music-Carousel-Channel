const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const yaml = require('js-yaml');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
const DEFAULT_SETTINGS = {
  fontFamily: 'Noto Sans TC, Microsoft JhengHei, sans-serif',
  enablePV: true,
  playMode: 'song-random',
  bgMode: 'cover'
};
const MEDIA_EXT = {
  audio: ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'],
  video: ['.mp4', '.mov', '.mkv', '.webm'],
  lyric: ['.lrc'],
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif']
};

let mainWindow;
let playerWindow;

async function ensureDataTree() {
  await fs.mkdir(path.join(DATA_DIR, 'music', 'data'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'music', 'lyrics'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'video'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'bg-image'), { recursive: true });
  if (!fss.existsSync(CONFIG_PATH)) {
    await writeConfig({ settings: DEFAULT_SETTINGS, library: { albums: [] } });
  }
}

async function readConfig() {
  await ensureDataTree();
  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  const cfg = yaml.load(raw) || {};
  cfg.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
  cfg.library = cfg.library || { albums: [] };
  cfg.library.albums = Array.isArray(cfg.library.albums) ? cfg.library.albums : [];
  return cfg;
}

async function writeConfig(cfg) {
  await fs.writeFile(CONFIG_PATH, yaml.dump(cfg, { lineWidth: 120, noRefs: true, sortKeys: false }), 'utf8');
}

function rel(p) {
  return path.relative(DATA_DIR, p).replaceAll(path.sep, '/');
}

function absFromData(p) {
  return p ? path.join(DATA_DIR, p) : '';
}

function publicUrl(p) {
  return p ? `file://${absFromData(p)}` : '';
}

function ext(file) {
  return path.extname(file).toLowerCase();
}

function baseName(file) {
  return path.basename(file, ext(file));
}

function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\-_()[\]【】（）「」『』]/g, '');
}

function isKind(file, kind) {
  return MEDIA_EXT[kind].includes(ext(file));
}

function classify(file) {
  if (isKind(file, 'audio')) return 'audio';
  if (isKind(file, 'video')) return 'video';
  if (isKind(file, 'lyric')) return 'lyric';
  if (isKind(file, 'image')) return 'image';
  return null;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function safeFileName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

async function uniqueDest(destDir, originalName) {
  const clean = safeFileName(originalName) || `asset${Date.now()}`;
  const parsed = path.parse(clean);
  let candidate = path.join(destDir, clean);
  let i = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(destDir, `${parsed.name}-${i}${parsed.ext}`);
    i += 1;
  }
  return candidate;
}

function inferAlbumFromFolder(sourcePath) {
  const folderName = path.basename(sourcePath);
  const yearMatch = folderName.match(/(?:19|20)\d{2}/);
  const year = yearMatch ? yearMatch[0] : '';
  const title = folderName.replace(/(?:19|20)\d{2}/, '').replace(/[\-_()[\]【】（）]/g, ' ').replace(/\s+/g, ' ').trim() || '未分類專輯';
  return { title, year };
}

async function collectFiles(inputPaths) {
  const files = [];
  const ignored = [];

  async function walk(p, rootAlbum = null) {
    let st;
    try {
      st = await fs.stat(p);
    } catch {
      ignored.push({ path: p, reason: '路徑不存在或無法讀取' });
      return;
    }

    if (st.isDirectory()) {
      const albumHint = rootAlbum || inferAlbumFromFolder(p);
      const children = await fs.readdir(p);
      for (const child of children) await walk(path.join(p, child), albumHint);
      return;
    }

    if (!st.isFile()) return;
    const kind = classify(p);
    if (!kind) {
      ignored.push({ path: p, reason: '不是支援的音訊 / LRC / PV / 圖片格式' });
      return;
    }
    files.push({ path: p, kind, albumHint: rootAlbum || { title: '未分類專輯', year: '' } });
  }

  for (const p of inputPaths || []) await walk(p);
  return { files, ignored };
}

async function copyAsset(source, kind) {
  const destMap = {
    audio: path.join(DATA_DIR, 'music', 'data'),
    lyric: path.join(DATA_DIR, 'music', 'lyrics'),
    video: path.join(DATA_DIR, 'video'),
    image: path.join(DATA_DIR, 'bg-image')
  };
  const destDir = destMap[kind];
  await fs.mkdir(destDir, { recursive: true });
  const dest = await uniqueDest(destDir, path.basename(source));
  await fs.copyFile(source, dest);
  return rel(dest);
}

function findOrCreateAlbum(cfg, title, year = '') {
  const existing = cfg.library.albums.find(a => normalizeKey(a.title || a.name) === normalizeKey(title) && String(a.year || '') === String(year || ''));
  if (existing) {
    existing.tracks = Array.isArray(existing.tracks) ? existing.tracks : [];
    return existing;
  }
  const album = { id: uuidv4(), title: title || '未分類專輯', year: year || '', tracks: [] };
  cfg.library.albums.push(album);
  return album;
}

function findTrackByBase(cfg, key) {
  for (const album of cfg.library.albums) {
    for (const track of album.tracks || []) {
      const musicBase = track.musicpath ? normalizeKey(baseName(track.musicpath)) : '';
      const titleBase = normalizeKey(track.title || '');
      if (musicBase === key || titleBase === key) return track;
    }
  }
  return null;
}

async function listFiles(dir, kind) {
  if (!fss.existsSync(dir)) return [];
  const names = await fs.readdir(dir);
  return names.filter(n => isKind(n, kind)).map(n => rel(path.join(dir, n)));
}

async function getPayload() {
  const cfg = await readConfig();
  const bgImages = await listFiles(path.join(DATA_DIR, 'bg-image'), 'image');
  const tracks = [];
  for (const album of cfg.library.albums) {
    for (const track of album.tracks || []) {
      tracks.push({
        ...track,
        albumTitle: album.title || album.name || '未分類專輯',
        albumYear: album.year || track.year || '',
        albumId: album.id
      });
    }
  }
  return { config: cfg, tracks, bgImages, dataDir: DATA_DIR };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
}

function createPlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.focus();
    return;
  }
  playerWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    backgroundColor: '#000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  playerWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'player.html'));
}

ipcMain.handle('library:get', getPayload);
ipcMain.handle('settings:save', async (_e, settings) => {
  const cfg = await readConfig();
  cfg.settings = { ...cfg.settings, ...settings };
  await writeConfig(cfg);
  return getPayload();
});
ipcMain.handle('player:launch', () => createPlayerWindow());
ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:openAssets', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '選擇要入庫的檔案或資料夾',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'Music Carousel Assets', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'lrc', 'mp4', 'mov', 'mkv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

ipcMain.handle('asset:import', async (_e, inputPaths) => {
  const cfg = await readConfig();
  const { files, ignored } = await collectFiles(inputPaths);
  const imported = [];
  const copiedByKey = new Map();

  for (const item of files) {
    const copied = await copyAsset(item.path, item.kind);
    const key = normalizeKey(baseName(item.path));
    if (!copiedByKey.has(key)) copiedByKey.set(key, { base: baseName(item.path), albumHint: item.albumHint });
    copiedByKey.get(key)[item.kind] = copied;
    copiedByKey.get(key).albumHint = item.albumHint || copiedByKey.get(key).albumHint;
    imported.push({ source: item.path, target: copied, kind: item.kind });
  }

  let createdTracks = 0;
  let updatedTracks = 0;

  for (const [key, group] of copiedByKey.entries()) {
    if (group.image && !group.audio && !group.lyric && !group.video) continue;

    let track = findTrackByBase(cfg, key);
    if (!track && group.audio) {
      const album = findOrCreateAlbum(cfg, group.albumHint?.title || '未分類專輯', group.albumHint?.year || '');
      track = {
        id: uuidv4(),
        title: group.base,
        album: album.title,
        year: group.albumHint?.year || '',
        PureMusic: !group.lyric,
        musicpath: group.audio,
        lyricpath: group.lyric || '',
        videopath: group.video || ''
      };
      album.tracks.push(track);
      createdTracks += 1;
      continue;
    }

    if (track) {
      if (group.audio) track.musicpath = group.audio;
      if (group.lyric) {
        track.lyricpath = group.lyric;
        track.PureMusic = false;
      }
      if (group.video) track.videopath = group.video;
      updatedTracks += 1;
    }
  }

  await writeConfig(cfg);
  return { imported, ignored, createdTracks, updatedTracks, payload: await getPayload() };
});

ipcMain.handle('asset:export', async (_e, targetFolder) => {
  const zip = new AdmZip();
  zip.addLocalFolder(DATA_DIR, 'data');
  const out = path.join(targetFolder, `music-carousel-data-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  zip.writeZip(out);
  return out;
});

app.whenReady().then(async () => {
  await ensureDataTree();
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
