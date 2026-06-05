const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const crypto = require('crypto');
const YAML = require('yaml');
const archiver = require('archiver');
const { pathToFileURL } = require('url');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');

const AUDIO_EXT = new Set(['.wav', '.flac', '.aiff', '.aif', '.m4a', '.mp3', '.ogg', '.opus', '.aac']);
const LRC_EXT = new Set(['.lrc']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

const ASSET_DIR_NAMES = new Set([
  'audio', 'audios', 'music', 'musics', 'data',
  'lrc', 'lyric', 'lyrics',
  'video', 'videos', 'pv', 'pvs', 'movie', 'movies',
  'bg', 'bg-image', 'background', 'backgrounds', 'image', 'images', 'img', 'imgs', 'cover', 'covers'
]);

const DEFAULT_SETTINGS = {
  fontFamily: 'Noto Sans TC, Microsoft JhengHei, sans-serif',
  enablePV: true,
  playMode: 'song-random',
  bgMode: 'cover'
};

let mainWindow = null;
let playerWindow = null;

function normalizeRel(p) {
  return String(p || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function normalizeKey(s) {
  return String(s || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase();
}

function makeId(prefix, ...parts) {
  const raw = parts.map(p => String(p || '')).join('|');
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  return `${prefix}-${hash}`;
}

function safeFilename(name) {
  return String(name || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim() || 'untitled';
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
  await fs.mkdir(path.join(DATA_DIR, 'bg-image'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'music', 'data'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'music', 'lyrics'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'video'), { recursive: true });

  if (!(await exists(CONFIG_PATH))) {
    await fs.writeFile(CONFIG_PATH, YAML.stringify({
      version: 2,
      settings: DEFAULT_SETTINGS,
      albums: [],
      tracks: [],
      backgrounds: []
    }), 'utf8');
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fssync.createReadStream(filePath);

  return await new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function normalizeAlbum(album) {
  const title = String(album?.title || album?.name || album?.albumTitle || 'Single').trim() || 'Single';
  const id = String(album?.id || makeId('album', title)).trim();

  return {
    id,
    title,
    artist: String(album?.artist || '').trim(),
    year: String(album?.year || '').trim(),
    description: String(album?.description || album?.note || '').trim()
  };
}

function normalizeTrack(track, albumsById) {
  const title = String(track?.title || track?.name || path.basename(track?.musicpath || '', path.extname(track?.musicpath || '')) || 'Untitled').trim() || 'Untitled';
  const musicpath = normalizeRel(track?.musicpath || track?.audio || track?.path || '');
  const albumTitle = String(track?.albumTitle || track?.album || 'Single').trim() || 'Single';
  const albumId = String(track?.albumId || makeId('album', albumTitle));

  if (!albumsById.has(albumId)) {
    albumsById.set(albumId, normalizeAlbum({
      id: albumId,
      title: albumTitle,
      artist: track?.artist || '',
      year: track?.year || ''
    }));
  }

  return {
    id: String(track?.id || makeId('track', albumId, title, musicpath)),
    title,
    artist: String(track?.artist || '').trim(),
    albumId,
    albumTitle,
    year: String(track?.year || '').trim(),
    musicpath,
    lyricpath: normalizeRel(track?.lyricpath || track?.lrc || ''),
    videopath: normalizeRel(track?.videopath || track?.pv || track?.video || ''),
    PureMusic: Boolean(track?.PureMusic ?? track?.pureMusic ?? !normalizeRel(track?.lyricpath || track?.lrc || '')),
    hashes: track?.hashes && typeof track.hashes === 'object' ? track.hashes : {},
    sourceFiles: track?.sourceFiles && typeof track.sourceFiles === 'object' ? track.sourceFiles : {},
    importedAt: String(track?.importedAt || ''),
    updatedAt: String(track?.updatedAt || '')
  };
}

function normalizeBackground(bg) {
  if (typeof bg === 'string') {
    return { path: normalizeRel(bg), hash: '', importedAt: '' };
  }

  return {
    path: normalizeRel(bg?.path || bg?.file || ''),
    hash: String(bg?.hash || ''),
    importedAt: String(bg?.importedAt || '')
  };
}

function normalizeConfig(raw) {
  const albumsById = new Map();
  const rawAlbums = Array.isArray(raw?.albums) ? raw.albums : [];

  for (const item of rawAlbums) {
    const album = normalizeAlbum(item);
    albumsById.set(album.id, album);
  }

  const rawTracks = Array.isArray(raw?.tracks)
    ? raw.tracks
    : Array.isArray(raw?.songs)
      ? raw.songs
      : Array.isArray(raw?.works)
        ? raw.works
        : [];

  const tracks = [];
  const seenTrackKeys = new Set();

  for (const item of rawTracks) {
    const track = normalizeTrack(item, albumsById);
    const key = `${track.albumId}::${normalizeKey(track.title)}`;

    if (seenTrackKeys.has(key)) continue;
    seenTrackKeys.add(key);
    tracks.push(track);
  }

  const rawBackgrounds = Array.isArray(raw?.backgrounds)
    ? raw.backgrounds
    : Array.isArray(raw?.bgImages)
      ? raw.bgImages
      : [];

  const backgrounds = [];
  const seenBg = new Set();

  for (const item of rawBackgrounds) {
    const bg = normalizeBackground(item);
    if (!bg.path || seenBg.has(bg.path)) continue;
    seenBg.add(bg.path);
    backgrounds.push(bg);
  }

  return {
    version: 2,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(raw?.settings || {})
    },
    albums: Array.from(albumsById.values()),
    tracks,
    backgrounds
  };
}

async function readConfigRaw() {
  await ensureDataDirs();

  try {
    const text = await fs.readFile(CONFIG_PATH, 'utf8');
    return YAML.parse(text) || {};
  } catch (error) {
    return {};
  }
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

  let album = config.albums.find(item => normalizeKey(item.title) === key);
  if (!album) {
    album = normalizeAlbum({ title });
    config.albums.push(album);
  }

  return album;
}

function findTrackByAlbumAndTitle(config, albumId, title) {
  const key = normalizeKey(title);
  return config.tracks.find(track => track.albumId === albumId && normalizeKey(track.title) === key);
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (AUDIO_EXT.has(ext)) return 'audio';
  if (LRC_EXT.has(ext)) return 'lrc';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'unknown';
}

async function listFilesDeep(root) {
  const out = [];

  async function walk(current) {
    const st = await fs.stat(current);

    if (st.isDirectory()) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        await walk(path.join(current, ent.name));
      }
      return;
    }

    if (st.isFile()) out.push(current);
  }

  await walk(root);
  return out;
}

async function collectInputFiles(inputPaths) {
  const files = [];
  const skipped = [];

  const resolved = [];

  for (const rawPath of inputPaths || []) {
    if (!rawPath) continue;

    const inputPath = path.resolve(String(rawPath));
    if (!(await exists(inputPath))) {
      skipped.push(`不存在：${inputPath}`);
      continue;
    }

    const st = await fs.stat(inputPath);
    resolved.push({ inputPath, isDirectory: st.isDirectory(), isFile: st.isFile() });
  }

  const selectedDirectories = resolved.filter(item => item.isDirectory).length;

  for (const item of resolved) {
    if (item.isFile) {
      files.push({
        filePath: item.inputPath,
        albumTitle: path.basename(path.dirname(item.inputPath)) || 'Single',
        sourceRoot: path.dirname(item.inputPath)
      });
      continue;
    }

    if (!item.isDirectory) continue;

    const root = item.inputPath;
    const rootName = path.basename(root) || 'Single';
    const entries = await fs.readdir(root, { withFileTypes: true });
    const childDirs = entries.filter(ent => ent.isDirectory() && !ent.name.startsWith('.'));
    const directMedia = entries.some(ent => ent.isFile() && classify(path.join(root, ent.name)) !== 'unknown');
    const childDirNames = childDirs.map(ent => normalizeKey(ent.name));
    const assetContainer = childDirNames.length > 0 && childDirNames.every(name => ASSET_DIR_NAMES.has(name));

    const splitByFirstChild =
      selectedDirectories === 1 &&
      !directMedia &&
      childDirs.length >= 2 &&
      !assetContainer;

    const deepFiles = await listFilesDeep(root);

    for (const filePath of deepFiles) {
      const rel = path.relative(root, filePath);
      const parts = rel.split(path.sep).filter(Boolean);
      const first = parts[0] || '';
      const albumTitle = splitByFirstChild && parts.length > 1 && !ASSET_DIR_NAMES.has(normalizeKey(first))
        ? first
        : rootName;

      files.push({ filePath, albumTitle, sourceRoot: root });
    }
  }

  return { files, skipped };
}

async function findExistingByHash(dir, hash) {
  if (!hash || !(await exists(dir))) return '';

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;

    const filePath = path.join(dir, ent.name);
    try {
      const existingHash = await hashFile(filePath);
      if (existingHash === hash) return filePath;
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

function choosePreferred(list, type, log, groupLabel) {
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
    log.warnings.push(`${groupLabel}：同名 ${type} 檔超過 1 個，已選擇 ${path.basename(sorted[0].filePath)}，其餘略過`);
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
    log.skippedFiles.push(`${track.title}：${spec.label} 重複，略過 ${path.basename(candidate.filePath)}`);
    return false;
  }

  track[spec.pathKey] = copied.rel;
  track.hashes[spec.hashKey] = copied.hash;
  track.sourceFiles[spec.sourceKey] = path.basename(candidate.filePath);
  track.updatedAt = new Date().toISOString();

  if (kind === 'lyric') track.PureMusic = false;

  log.updatedTracks.push(`${track.albumTitle || ''} / ${track.title}：已掛載/更新 ${spec.label}`);
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
    const existsInConfig = config.backgrounds.some(bg => bg.hash === copied.hash || bg.path === copied.rel);

    if (!existsInConfig) {
      config.backgrounds.push({
        path: copied.rel,
        hash: copied.hash,
        importedAt: new Date().toISOString()
      });
      log.backgrounds.push(`${copied.copied ? '新增' : '引用既有'}背景圖：${copied.filename}`);
    } else {
      log.skippedFiles.push(`背景圖重複，略過 ${path.basename(img.filePath)}`);
    }
  }

  for (const group of groups.values()) {
    const album = getAlbum(config, group.albumTitle);
    const groupLabel = `${album.title} / ${group.title}`;

    const audio = choosePreferred(group.audio, 'audio', log, groupLabel);
    const lrc = choosePreferred(group.lrc, 'lrc', log, groupLabel);
    const video = choosePreferred(group.video, 'video', log, groupLabel);

    const existingTrack = findTrackByAlbumAndTitle(config, album.id, group.title);

    if (!audio) {
      if (existingTrack) {
        await attachOptionalAsset(existingTrack, 'lyric', lrc, log);
        await attachOptionalAsset(existingTrack, 'video', video, log);
      } else {
        const suffix = [
          group.lrc.length ? `${group.lrc.length} 個 LRC` : '',
          group.video.length ? `${group.video.length} 個 PV` : ''
        ].filter(Boolean).join(' + ');
        log.warnings.push(`${groupLabel}：找到 ${suffix || '非音訊資產'}，但沒有同名音訊，未建立作品`);
      }
      continue;
    }

    const copiedAudio = await copyAsset(audio.filePath, path.join('music', 'data'));

    if (existingTrack) {
      existingTrack.hashes ||= {};
      existingTrack.sourceFiles ||= {};

      if (existingTrack.hashes.music === copiedAudio.hash || existingTrack.musicpath === copiedAudio.rel) {
        log.skippedTracks.push(`同名作品已存在，不重複匯入：${groupLabel}`);
      } else {
        log.skippedTracks.push(`同名作品已存在但音訊內容不同，已保留既有作品、不覆蓋：${groupLabel}`);
      }

      await attachOptionalAsset(existingTrack, 'lyric', lrc, log);
      await attachOptionalAsset(existingTrack, 'video', video, log);

      existingTrack.albumTitle = album.title;
      existingTrack.year = existingTrack.year || album.year || '';
      existingTrack.artist = existingTrack.artist || album.artist || '';
      existingTrack.PureMusic = !existingTrack.lyricpath;
      existingTrack.updatedAt = new Date().toISOString();
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
    log.addedTracks.push(groupLabel);
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
    .filter(entry => entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase()))
    .map(entry => normalizeRel(path.join('bg-image', entry.name)));
}

async function getLibrary() {
  const config = await loadConfig();

  const diskBgs = await listDiskBackgrounds();
  const bgSet = new Set(config.backgrounds.map(bg => bg.path));

  for (const bg of diskBgs) {
    if (!bgSet.has(bg)) {
      config.backgrounds.push({ path: bg, hash: '', importedAt: '' });
    }
  }

  const albumsById = Object.fromEntries(config.albums.map(album => [album.id, album]));
  const tracks = config.tracks.map(track => {
    const album = albumsById[track.albumId] || {};
    return {
      ...track,
      albumTitle: album.title || track.albumTitle || 'Single',
      artist: track.artist || album.artist || '',
      year: track.year || album.year || ''
    };
  });

  return {
    dataDir: DATA_DIR,
    config,
    albums: config.albums,
    tracks,
    bgImages: config.backgrounds.map(bg => bg.path)
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

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '選擇 data.zip 匯出位置',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };

  const zipPath = path.join(result.filePaths[0], 'data.zip');

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

function ensureUniqueAlbumTitle(config, title, selfId = '') {
  const key = normalizeKey(title);
  const duplicate = config.albums.find(album => album.id !== selfId && normalizeKey(album.title) === key);

  if (duplicate) {
    throw new Error(`專輯名稱已存在：${title}`);
  }
}

async function createAlbum(patch) {
  const config = await loadConfig();
  const title = String(patch?.title || '').trim();

  if (!title) return { ok: false, error: '專輯名稱不能為空' };

  try {
    ensureUniqueAlbumTitle(config, title);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const album = normalizeAlbum({
    title,
    artist: patch?.artist || '',
    year: patch?.year || '',
    description: patch?.description || ''
  });

  config.albums.push(album);
  await saveConfig(config);

  return { ok: true, album };
}

async function updateAlbum({ albumId, patch }) {
  const config = await loadConfig();
  const album = config.albums.find(item => item.id === albumId);

  if (!album) return { ok: false, error: 'Album not found' };

  const nextTitle = String(patch?.title || album.title || 'Single').trim() || 'Single';

  try {
    ensureUniqueAlbumTitle(config, nextTitle, album.id);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  album.title = nextTitle;
  album.artist = String(patch?.artist || '').trim();
  album.year = String(patch?.year || '').trim();
  album.description = String(patch?.description || '').trim();

  for (const track of config.tracks.filter(item => item.albumId === album.id)) {
    track.albumTitle = album.title;
    if (!track.artist) track.artist = album.artist;
    if (!track.year) track.year = album.year;
    track.updatedAt = new Date().toISOString();
  }

  await saveConfig(config);
  return { ok: true, album };
}

async function updateAlbums(patches) {
  const config = await loadConfig();
  const input = Array.isArray(patches) ? patches : [];

  const ids = new Set(config.albums.map(album => album.id));
  const titles = new Map();

  for (const patch of input) {
    if (!ids.has(patch.id)) continue;

    const title = String(patch.title || 'Single').trim() || 'Single';
    const key = normalizeKey(title);

    if (titles.has(key)) {
      return { ok: false, error: `專輯名稱重複：${title}` };
    }

    titles.set(key, patch.id);
  }

  for (const album of config.albums) {
    const patch = input.find(item => item.id === album.id);
    if (!patch) continue;

    album.title = String(patch.title || album.title || 'Single').trim() || 'Single';
    album.artist = String(patch.artist || '').trim();
    album.year = String(patch.year || '').trim();
    album.description = String(patch.description || '').trim();

    for (const track of config.tracks.filter(item => item.albumId === album.id)) {
      track.albumTitle = album.title;
      if (!track.artist) track.artist = album.artist;
      if (!track.year) track.year = album.year;
      track.updatedAt = new Date().toISOString();
    }
  }

  await saveConfig(config);
  return { ok: true, albums: config.albums };
}

async function deleteAlbum(albumId) {
  const config = await loadConfig();
  const album = config.albums.find(item => item.id === albumId);

  if (!album) return { ok: false, error: 'Album not found' };

  const trackCount = config.tracks.filter(track => track.albumId === albumId).length;
  if (trackCount > 0) {
    return { ok: false, error: `這張專輯仍有 ${trackCount} 首作品，不能刪除` };
  }

  config.albums = config.albums.filter(item => item.id !== albumId);
  await saveConfig(config);

  return { ok: true };
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
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '選擇要入庫的資產',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'Media and lyrics', extensions: [...AUDIO_EXT, ...LRC_EXT, ...VIDEO_EXT, ...IMAGE_EXT].map(ext => ext.slice(1)) },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  return importAssets(result.filePaths);
});

ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings));

ipcMain.handle('album:create', (_event, patch) => createAlbum(patch));
ipcMain.handle('album:update', (_event, payload) => updateAlbum(payload));
ipcMain.handle('album:updateMany', (_event, patches) => updateAlbums(patches));
ipcMain.handle('album:delete', (_event, albumId) => deleteAlbum(albumId));

ipcMain.handle('data:exportZip', exportDataZip);

ipcMain.handle('player:launch', () => {
  openPlayerWindow();
  return { ok: true };
});

ipcMain.handle('data:fileUrl', (_event, relPath) => pathToFileURL(assertInsideDataDir(relPath)).href);
ipcMain.handle('data:readText', async (_event, relPath) => fs.readFile(assertInsideDataDir(relPath), 'utf8'));
