const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const YAML = require('yaml');
const archiver = require('archiver');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');

const DATA_SUBDIRS = [
  'bg-image',
  path.join('music', 'data'),
  path.join('music', 'lyrics'),
  'video'
];

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.aif']);
const LRC_EXT = new Set(['.lrc']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

const DEFAULT_SETTINGS = {
  fontFamily: 'Noto Sans TC, Microsoft JhengHei, sans-serif',
  enablePV: true,
  playMode: 'song-random',
  bgMode: 'cover'
};

let mainWindow;
let playerWindow;

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^data\//, '');
}

function safeFilename(name) {
  return String(name || 'asset')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'asset';
}

function normalizeKey(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\[\]【】()（）{}_\-—–.,，。!！?？:：;；'"“”‘’]/g, '');
}

function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

function makeId(prefix, ...parts) {
  return `${prefix}-${shortHash(parts.join('::') || `${Date.now()}-${Math.random()}`)}`;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDataDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const sub of DATA_SUBDIRS) {
    await fs.mkdir(path.join(DATA_DIR, sub), { recursive: true });
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fssync.createReadStream(filePath);
    stream.on('data', chunk => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

async function readConfigRaw() {
  await ensureDataDirs();
  if (!(await exists(CONFIG_PATH))) {
    return {};
  }
  try {
    const text = await fs.readFile(CONFIG_PATH, 'utf8');
    return YAML.parse(text) || {};
  } catch (err) {
    const backup = path.join(DATA_DIR, `config.corrupt-${Date.now()}.yaml`);
    await fs.copyFile(CONFIG_PATH, backup).catch(() => {});
    return {};
  }
}

function normalizeAlbum(album) {
  const title = String(album?.title || album?.name || album?.albumTitle || 'Single').trim() || 'Single';
  return {
    id: String(album?.id || makeId('album', title)).trim(),
    title,
    artist: String(album?.artist || '').trim(),
    year: String(album?.year || '').trim(),
    description: String(album?.description || album?.note || '').trim()
  };
}

function normalizeTrack(track, albumsById) {
  const title = String(track?.title || track?.name || path.parse(track?.musicpath || track?.musicPath || track?.audio || '').name || 'Untitled').trim();
  const albumTitle = String(track?.albumTitle || track?.album || 'Single').trim() || 'Single';
  const albumId = String(track?.albumId || makeId('album', albumTitle));
  if (!albumsById.has(albumId)) {
    albumsById.set(albumId, normalizeAlbum({ id: albumId, title: albumTitle, artist: track?.artist || '', year: track?.year || '' }));
  }
  const musicpath = normalizeRel(track?.musicpath || track?.musicPath || track?.audio || '');
  const lyricpath = normalizeRel(track?.lyricpath || track?.lyricPath || track?.lrc || '');
  const videopath = normalizeRel(track?.videopath || track?.videoPath || track?.pv || track?.video || '');
  const pure = typeof track?.PureMusic === 'boolean'
    ? track.PureMusic
    : typeof track?.pureMusic === 'boolean'
      ? track.pureMusic
      : !lyricpath;

  return {
    id: String(track?.id || makeId('track', albumId, title, musicpath)),
    title,
    artist: String(track?.artist || '').trim(),
    albumId,
    albumTitle,
    year: String(track?.year || '').trim(),
    musicpath,
    lyricpath,
    videopath,
    PureMusic: pure,
    hashes: track?.hashes || {},
    sourceFiles: track?.sourceFiles || {},
    importedAt: track?.importedAt || new Date().toISOString(),
    updatedAt: track?.updatedAt || ''
  };
}

function normalizeConfig(raw = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  settings.enablePV = settings.enablePV !== false;
  settings.playMode = settings.playMode || 'song-random';
  settings.bgMode = settings.bgMode || settings.backgroundMode || 'cover';

  const albumsById = new Map();
  const rawAlbums = Array.isArray(raw.albums) ? raw.albums : [];
  for (const a of rawAlbums) {
    const album = normalizeAlbum(a);
    albumsById.set(album.id, album);
  }

  const rawTracks = Array.isArray(raw.tracks)
    ? raw.tracks
    : Array.isArray(raw.works)
      ? raw.works
      : Array.isArray(raw.songs)
        ? raw.songs
        : [];

  const tracks = [];
  const seenTrackIds = new Set();
  for (const t of rawTracks) {
    const track = normalizeTrack(t, albumsById);
    if (!track.musicpath) continue;
    while (seenTrackIds.has(track.id)) {
      track.id = makeId('track', track.id, Date.now(), Math.random());
    }
    seenTrackIds.add(track.id);
    tracks.push(track);
  }

  const backgrounds = [];
  const seenBg = new Set();
  const rawBackgrounds = Array.isArray(raw.backgrounds) ? raw.backgrounds : [];
  for (const b of rawBackgrounds) {
    const item = typeof b === 'string' ? { path: b } : b;
    const rel = normalizeRel(item.path || item.bg || item.file || '');
    if (!rel || seenBg.has(rel)) continue;
    backgrounds.push({ path: rel, hash: item.hash || '', importedAt: item.importedAt || '' });
    seenBg.add(rel);
  }

  return {
    version: 2,
    settings,
    albums: Array.from(albumsById.values()),
    tracks,
    backgrounds
  };
}

async function loadConfig() {
  return normalizeConfig(await readConfigRaw());
}

async function saveConfig(config) {
  await ensureDataDirs();
  const normalized = normalizeConfig(config);
  await fs.writeFile(CONFIG_PATH, YAML.stringify(normalized), 'utf8');
  return normalized;
}

function getAlbum(config, albumTitle) {
  const title = String(albumTitle || 'Single').trim() || 'Single';
  const key = normalizeKey(title);
  let album = config.albums.find(a => normalizeKey(a.title) === key);
  if (!album) {
    album = normalizeAlbum({ title });
    config.albums.push(album);
  }
  return album;
}

function findTrackByAlbumAndTitle(config, albumId, title) {
  const key = normalizeKey(title);
  return config.tracks.find(t => t.albumId === albumId && normalizeKey(t.title) === key);
}

async function listFilesRecursive(inputPath, albumTitle, out) {
  const st = await fs.stat(inputPath);
  if (st.isDirectory()) {
    const entries = await fs.readdir(inputPath, { withFileTypes: true });
    for (const ent of entries) {
      await listFilesRecursive(path.join(inputPath, ent.name), albumTitle, out);
    }
  } else if (st.isFile()) {
    out.push({ filePath: inputPath, albumTitle });
  }
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (LRC_EXT.has(ext)) return 'lrc';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'unknown';
}

async function collectInputFiles(inputPaths) {
  const files = [];
  const skipped = [];
  for (const rawPath of inputPaths || []) {
    if (!rawPath) continue;
    const inputPath = path.resolve(String(rawPath));
    if (!(await exists(inputPath))) {
      skipped.push(`不存在：${inputPath}`);
      continue;
    }
    const st = await fs.stat(inputPath);
    if (st.isDirectory()) {
      await listFilesRecursive(inputPath, path.basename(inputPath), files);
    } else if (st.isFile()) {
      await listFilesRecursive(inputPath, path.basename(path.dirname(inputPath)) || 'Single', files);
    }
  }
  return { files, skipped };
}

async function findExistingByHash(dir, hash) {
  if (!hash || !(await exists(dir))) return '';
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const p = path.join(dir, ent.name);
    try {
      const h = await hashFile(p);
      if (h === hash) return p;
    } catch {}
  }
  return '';
}

async function copyAsset(filePath, targetSubdir) {
  const hash = await hashFile(filePath);
  const targetDir = path.join(DATA_DIR, targetSubdir);
  await fs.mkdir(targetDir, { recursive: true });

  const existingSameHash = await findExistingByHash(targetDir, hash);
  if (existingSameHash) {
    return {
      rel: normalizeRel(path.relative(DATA_DIR, existingSameHash)),
      hash,
      copied: false,
      duplicateFile: true,
      filename: path.basename(existingSameHash)
    };
  }

  const originalName = safeFilename(path.basename(filePath));
  const ext = path.extname(originalName);
  const stem = path.basename(originalName, ext);
  let dest = path.join(targetDir, originalName);

  if (await exists(dest)) {
    const existingHash = await hashFile(dest).catch(() => '');
    if (existingHash === hash) {
      return {
        rel: normalizeRel(path.relative(DATA_DIR, dest)),
        hash,
        copied: false,
        duplicateFile: true,
        filename: path.basename(dest)
      };
    }
    dest = path.join(targetDir, `${stem}-${hash.slice(0, 8)}${ext}`);
  }

  await fs.copyFile(filePath, dest);
  return {
    rel: normalizeRel(path.relative(DATA_DIR, dest)),
    hash,
    copied: true,
    duplicateFile: false,
    filename: path.basename(dest)
  };
}

function choosePreferred(list, type, log) {
  if (!list.length) return null;
  const priority = type === 'audio'
    ? ['.wav', '.flac', '.aiff', '.aif', '.m4a', '.mp3', '.ogg', '.opus', '.aac']
    : type === 'video'
      ? ['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']
      : ['.lrc'];

  const sorted = [...list].sort((a, b) => {
    const ai = priority.indexOf(path.extname(a.filePath).toLowerCase());
    const bi = priority.indexOf(path.extname(b.filePath).toLowerCase());
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  if (sorted.length > 1) {
    log.warnings.push(`同名 ${type} 檔超過 1 個，已選擇：${path.basename(sorted[0].filePath)}`);
  }
  return sorted[0];
}

async function attachOptionalAsset(track, kind, candidate, log) {
  if (!candidate) return false;

  const spec = kind === 'lyric'
    ? { subdir: path.join('music', 'lyrics'), pathKey: 'lyricpath', hashKey: 'lyric', sourceKey: 'lyric', label: 'LRC' }
    : { subdir: 'video', pathKey: 'videopath', hashKey: 'video', sourceKey: 'video', label: 'PV' };

  const copied = await copyAsset(candidate.filePath, spec.subdir);
  track.hashes ||= {};
  track.sourceFiles ||= {};

  if (track.hashes[spec.hashKey] === copied.hash || track[spec.pathKey] === copied.rel) {
    log.skippedFiles.push(`${spec.label} 重複，略過：${path.basename(candidate.filePath)}`);
    return false;
  }

  track[spec.pathKey] = copied.rel;
  track.hashes[spec.hashKey] = copied.hash;
  track.sourceFiles[spec.sourceKey] = path.basename(candidate.filePath);
  track.updatedAt = new Date().toISOString();

  if (kind === 'lyric') track.PureMusic = false;
  log.updatedTracks.push(`${track.title}：已掛載/更新 ${spec.label}`);
  return true;
}

async function importAssets(inputPaths) {
  await ensureDataDirs();
  const config = await loadConfig();
  const log = {
    addedTracks: [],
    updatedTracks: [],
    skippedTracks: [],
    skippedFiles: [],
    warnings: [],
    backgrounds: []
  };

  const { files, skipped } = await collectInputFiles(inputPaths);
  log.skippedFiles.push(...skipped);

  const groups = new Map();
  const images = [];

  for (const item of files) {
    const type = classify(item.filePath);
    if (type === 'unknown') {
      log.skippedFiles.push(`不支援的檔案：${path.basename(item.filePath)}`);
      continue;
    }

    if (type === 'image') {
      images.push(item);
      continue;
    }

    const stem = path.basename(item.filePath, path.extname(item.filePath));
    const key = `${normalizeKey(item.albumTitle)}::${normalizeKey(stem)}`;
    if (!groups.has(key)) {
      groups.set(key, { albumTitle: item.albumTitle, title: stem, audio: [], lrc: [], video: [] });
    }
    groups.get(key)[type].push(item);
  }

  for (const img of images) {
    const copied = await copyAsset(img.filePath, 'bg-image');
    const existsInConfig = config.backgrounds.some(b => b.hash === copied.hash || b.path === copied.rel);
    if (!existsInConfig) {
      config.backgrounds.push({ path: copied.rel, hash: copied.hash, importedAt: new Date().toISOString() });
      log.backgrounds.push(`${copied.copied ? '新增' : '引用既有'}背景圖：${copied.filename}`);
    } else {
      log.skippedFiles.push(`背景圖重複，略過：${path.basename(img.filePath)}`);
    }
  }

  for (const group of groups.values()) {
    const album = getAlbum(config, group.albumTitle);
    const audio = choosePreferred(group.audio, 'audio', log);
    const lrc = choosePreferred(group.lrc, 'lrc', log);
    const video = choosePreferred(group.video, 'video', log);
    const existingTrack = findTrackByAlbumAndTitle(config, album.id, group.title);

    if (!audio) {
      if (existingTrack) {
        await attachOptionalAsset(existingTrack, 'lyric', lrc, log);
        await attachOptionalAsset(existingTrack, 'video', video, log);
      } else {
        log.skippedFiles.push(`沒有同名音訊，無法建立作品：${group.title}`);
      }
      continue;
    }

    const copiedAudio = await copyAsset(audio.filePath, path.join('music', 'data'));

    if (existingTrack) {
      existingTrack.hashes ||= {};
      existingTrack.sourceFiles ||= {};

      if (existingTrack.hashes.music === copiedAudio.hash || existingTrack.musicpath === copiedAudio.rel) {
        log.skippedTracks.push(`同名作品已存在，不重複匯入：${album.title} / ${group.title}`);
      } else {
        log.skippedTracks.push(`同名作品已存在但音訊內容不同，已保留既有作品、不覆蓋：${album.title} / ${group.title}`);
      }

      await attachOptionalAsset(existingTrack, 'lyric', lrc, log);
      await attachOptionalAsset(existingTrack, 'video', video, log);
      existingTrack.albumTitle = album.title;
      existingTrack.year = existingTrack.year || album.year || '';
      existingTrack.artist = existingTrack.artist || album.artist || '';
      existingTrack.PureMusic = !existingTrack.lyricpath;
      continue;
    }

    const track = {
      id: makeId('track', album.id, group.title, copiedAudio.hash),
      title: group.title,
      artist: album.artist || '',
      albumId: album.id,
      albumTitle: album.title,
      year: album.year || '',
      musicpath: copiedAudio.rel,
      lyricpath: '',
      videopath: '',
      PureMusic: true,
      hashes: { music: copiedAudio.hash },
      sourceFiles: { music: path.basename(audio.filePath) },
      importedAt: new Date().toISOString(),
      updatedAt: ''
    };

    await attachOptionalAsset(track, 'lyric', lrc, log);
    await attachOptionalAsset(track, 'video', video, log);
    track.PureMusic = !track.lyricpath;

    config.tracks.push(track);
    log.addedTracks.push(`${album.title} / ${track.title}`);
  }

  const saved = await saveConfig(config);
  return {
    ok: true,
    dataDir: DATA_DIR,
    counts: {
      albums: saved.albums.length,
      tracks: saved.tracks.length,
      backgrounds: saved.backgrounds.length
    },
    log
  };
}

async function listDiskBackgrounds() {
  const dir = path.join(DATA_DIR, 'bg-image');
  if (!(await exists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map(e => normalizeRel(path.join('bg-image', e.name)));
}

async function getLibrary() {
  const config = await loadConfig();
  const diskBgs = await listDiskBackgrounds();
  const bgSet = new Set(config.backgrounds.map(b => b.path));
  for (const bg of diskBgs) {
    if (!bgSet.has(bg)) config.backgrounds.push({ path: bg, hash: '', importedAt: '' });
  }

  const albumsById = Object.fromEntries(config.albums.map(a => [a.id, a]));
  const tracks = config.tracks.map(t => {
    const a = albumsById[t.albumId] || {};
    return {
      ...t,
      albumTitle: a.title || t.albumTitle || 'Single',
      artist: t.artist || a.artist || '',
      year: t.year || a.year || ''
    };
  });

  return {
    dataDir: DATA_DIR,
    config,
    albums: config.albums,
    tracks,
    bgImages: config.backgrounds.map(b => b.path)
  };
}

function assertInsideDataDir(relPath) {
  const abs = path.resolve(DATA_DIR, normalizeRel(relPath));
  const base = path.resolve(DATA_DIR);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('Invalid data path');
  }
  return abs;
}

async function exportDataZip() {
  await ensureDataDirs();
  const ret = await dialog.showOpenDialog(mainWindow, {
    title: '選擇 data.zip 匯出位置',
    properties: ['openDirectory', 'createDirectory']
  });
  if (ret.canceled || !ret.filePaths[0]) return { ok: false, canceled: true };

  const zipPath = path.join(ret.filePaths[0], 'data.zip');
  await new Promise((resolve, reject) => {
    const output = fssync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(DATA_DIR, 'data');
    archive.finalize();
  });
  return { ok: true, zipPath };
}

async function updateAlbum({ albumId, patch }) {
  const config = await loadConfig();
  const album = config.albums.find(a => a.id === albumId);
  if (!album) return { ok: false, error: 'Album not found' };

  const nextTitle = String(patch?.title || album.title || 'Single').trim() || 'Single';
  album.title = nextTitle;
  album.artist = String(patch?.artist || '').trim();
  album.year = String(patch?.year || '').trim();
  album.description = String(patch?.description || '').trim();

  for (const track of config.tracks.filter(t => t.albumId === album.id)) {
    track.albumTitle = album.title;
    track.artist = track.artist || album.artist;
    track.year = track.year || album.year;
    track.updatedAt = new Date().toISOString();
  }

  await saveConfig(config);
  return { ok: true, album };
}

async function saveSettings(settings) {
  const config = await loadConfig();
  config.settings = {
    ...DEFAULT_SETTINGS,
    ...config.settings,
    fontFamily: settings?.fontFamily || DEFAULT_SETTINGS.fontFamily,
    enablePV: settings?.enablePV !== false,
    playMode: settings?.playMode || 'song-random',
    bgMode: settings?.bgMode || 'cover'
  };
  await saveConfig(config);
  return { ok: true, settings: config.settings };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 980,
    minHeight: 620,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(ROOT_DIR, 'src', 'renderer', 'index.html'));
}

function openPlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.focus();
    return;
  }
  playerWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  playerWindow.loadFile(path.join(ROOT_DIR, 'src', 'renderer', 'player.html'));
}

app.whenReady().then(async () => {
  await ensureDataDirs();
  createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

ipcMain.handle('library:get', getLibrary);
ipcMain.handle('assets:import', async (_event, paths) => importAssets(paths));
ipcMain.handle('assets:chooseAndImport', async () => {
  const ret = await dialog.showOpenDialog(mainWindow, {
    title: '選擇要入庫的資產',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'Media and lyrics', extensions: [...AUDIO_EXT, ...LRC_EXT, ...VIDEO_EXT, ...IMAGE_EXT].map(x => x.slice(1)) },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (ret.canceled || !ret.filePaths.length) return { ok: false, canceled: true };
  return importAssets(ret.filePaths);
});
ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings));
ipcMain.handle('album:update', (_event, payload) => updateAlbum(payload));
ipcMain.handle('data:exportZip', exportDataZip);
ipcMain.handle('player:launch', () => {
  openPlayerWindow();
  return { ok: true };
});
ipcMain.handle('data:fileUrl', (_event, relPath) => pathToFileURL(assertInsideDataDir(relPath)).href);
ipcMain.handle('data:readText', async (_event, relPath) => fs.readFile(assertInsideDataDir(relPath), 'utf8'));
