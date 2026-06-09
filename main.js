const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fssync = require('fs');
const crypto = require('crypto');
const YAML = require('yaml');
const archiver = require('archiver');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const ROOT_DIR = __dirname;
const ROOT_FALLBACK_DATA_DIR = process.platform === 'win32'
  ? path.join(path.parse(process.cwd()).root || 'C:\\', 'MMCCDB', 'DATA')
  : path.join(path.parse(os.homedir()).root || '/', 'MMCCDB', 'DATA');

let DATA_DIR = process.env.MMCC_DATA_DIR || ROOT_FALLBACK_DATA_DIR;
let CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
let LOCAL_STATE_PATH = '';
let dataRootFallbackNotice = '';

function refreshConfigPath() {
  CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
}

const AUDIO_EXT = new Set(['.wav', '.flac', '.aiff', '.aif', '.aifc', '.m4a', '.mp3', '.ogg', '.opus', '.aac']);
const AIFF_EXT = new Set(['.aiff', '.aif', '.aifc']);
const LRC_EXT = new Set(['.lrc']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);
const VIDEO_TRANSCODE_EXT = new Set(['.mov', '.mkv', '.avi']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const DEFAULT_IMPORT_ALBUM_TITLE = '未分類';

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
  bgMode: 'cover',
  ffmpegPath: '',
  transcodeGpuMode: 'auto',
  playbackGpu: true
,
  audioOutputDeviceId: 'default',
  audioOutputDeviceLabel: '',
  playerFullscreenWin: false};

let mainWindow = null;
let playerWindow = null;

// Chromium playback already uses platform GPU paths where possible.
// These switches make Electron less conservative on GPU acceleration.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

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


async function initDataRoot() {
  LOCAL_STATE_PATH = path.join(app.getPath('userData'), 'mmcc.local.json');

  let saved = '';
  try {
    const raw = JSON.parse(await fs.readFile(LOCAL_STATE_PATH, 'utf8'));
    saved = String(raw?.dataDir || '').trim();
  } catch {}

  DATA_DIR = path.resolve(process.env.MMCC_DATA_DIR || saved || ROOT_FALLBACK_DATA_DIR);
  refreshConfigPath();
}

async function saveLocalDataRoot(dataDir) {
  LOCAL_STATE_PATH ||= path.join(app.getPath('userData'), 'mmcc.local.json');
  await fs.mkdir(path.dirname(LOCAL_STATE_PATH), { recursive: true });
  await fs.writeFile(LOCAL_STATE_PATH, JSON.stringify({ dataDir }, null, 2), 'utf8');
}

async function useDataRoot(dataDir, persist = true) {
  const next = path.resolve(String(dataDir || '').trim());
  if (!next) throw new Error('DATA 路徑不能為空');

  DATA_DIR = next;
  refreshConfigPath();
  dataRootFallbackNotice = '';
  await ensureDataDirs(false);

  if (persist) await saveLocalDataRoot(DATA_DIR);
  return getDataRootInfo();
}

async function resetDataRoot() {
  DATA_DIR = ROOT_FALLBACK_DATA_DIR;
  refreshConfigPath();
  dataRootFallbackNotice = '';
  await ensureDataDirs(false);
  await saveLocalDataRoot(DATA_DIR);
  return getDataRootInfo();
}

function getDataRootInfo() {
  return {
    dataDir: DATA_DIR,
    dataRoot: DATA_DIR,
    configPath: CONFIG_PATH,
    defaultDataDir: ROOT_FALLBACK_DATA_DIR,
    fallbackNotice: dataRootFallbackNotice
  };
}

async function chooseDataRoot() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '選擇 MMCC DATA 位置',
    defaultPath: DATA_DIR,
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };

  try {
    const info = await useDataRoot(result.filePaths[0], true);
    return { ok: true, ...info };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function ensureDataDirs(allowFallback = true) {
  async function createAtCurrentRoot() {
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
        backgrounds: [],
        resourceIndex: {
          version: 1,
          updatedAt: new Date().toISOString(),
          counts: { lyrics: 0, videos: 0, boundLyrics: 0, boundVideos: 0, standaloneLyrics: 0, standaloneVideos: 0 },
          lyrics: [],
          videos: []
        },
        resourceCounts: { lyrics: 0, videos: 0, boundLyrics: 0, boundVideos: 0, standaloneLyrics: 0, standaloneVideos: 0 }
      }), 'utf8');
    }
  }

  try {
    await createAtCurrentRoot();
  } catch (error) {
    const wasDefault = path.resolve(DATA_DIR) === path.resolve(ROOT_FALLBACK_DATA_DIR);
    if (!allowFallback || !wasDefault) throw error;

    const fallback = path.join(os.homedir(), 'MMCCDB', 'DATA');
    dataRootFallbackNotice = `預設 DATA 路徑 ${ROOT_FALLBACK_DATA_DIR} 無法寫入，已暫時改用 ${fallback}。可在播放設定裡重新選擇路徑。原始錯誤：${error.message}`;
    DATA_DIR = fallback;
    refreshConfigPath();
    await createAtCurrentRoot();
    await saveLocalDataRoot(DATA_DIR).catch(() => {});
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


function getFfmpegCommand(config = {}) {
  const configured = String(config?.settings?.ffmpegPath || '').trim();
  if (configured) return configured;

  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'bin', exe) : '',
    app.isPackaged ? path.join(process.resourcesPath, 'resources', 'bin', exe) : '',
    path.join(ROOT_DIR, 'resources', 'bin', exe)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fssync.existsSync(candidate)) return candidate;
  }

  return 'ffmpeg';
}

async function runFfmpeg(config, args) {
  const command = getFfmpegCommand(config);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', error => {
      if (error.code === 'ENOENT') {
        reject(new Error(`找不到 FFmpeg：${command}。請先安裝 FFmpeg，或在播放設定裡填入 ffmpeg 執行檔路徑。`));
        return;
      }
      reject(error);
    });

    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg 轉換失敗，退出碼 ${code}。${stderr.split('\n').slice(-8).join('\n')}`));
      }
    });
  });
}


async function runFfmpegCapture(config, args) {
  const command = getFfmpegCommand(config);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', error => reject(error));
    child.on('close', code => {
      if (code === 0) resolve(stdout + '\n' + stderr);
      else reject(new Error(stderr || `FFmpeg exited with code ${code}`));
    });
  });
}

const encoderCache = new Map();

async function getFfmpegEncoders(config) {
  const command = getFfmpegCommand(config);
  if (encoderCache.has(command)) return encoderCache.get(command);

  let output = '';
  try {
    output = await runFfmpegCapture(config, ['-hide_banner', '-encoders']);
  } catch {
    output = '';
  }

  encoderCache.set(command, output);
  return output;
}

async function hasEncoder(config, encoder) {
  const encoders = await getFfmpegEncoders(config);
  return new RegExp(`\\b${encoder}\\b`).test(encoders);
}

async function resolveVideoEncoder(config) {
  const mode = String(config?.settings?.transcodeGpuMode || 'auto');

  if (mode === 'off' || mode === 'software') return 'software';
  if (mode === 'videotoolbox') return await hasEncoder(config, 'h264_videotoolbox') ? 'videotoolbox' : 'software';
  if (mode === 'nvenc') return await hasEncoder(config, 'h264_nvenc') ? 'nvenc' : 'software';
  if (mode === 'qsv') return await hasEncoder(config, 'h264_qsv') ? 'qsv' : 'software';
  if (mode === 'amf') return await hasEncoder(config, 'h264_amf') ? 'amf' : 'software';

  if (process.platform === 'darwin' && await hasEncoder(config, 'h264_videotoolbox')) return 'videotoolbox';
  if (await hasEncoder(config, 'h264_nvenc')) return 'nvenc';
  if (await hasEncoder(config, 'h264_qsv')) return 'qsv';
  if (await hasEncoder(config, 'h264_amf')) return 'amf';
  return 'software';
}

async function buildVideoTranscodeArgs(filePath, output, config, log) {
  const encoder = await resolveVideoEncoder(config);
  const commonBeforeOutput = ['-map_metadata', '0', '-pix_fmt', 'yuv420p'];
  const audioArgs = ['-c:a', 'aac', '-b:a', '192k'];
  const finish = ['-movflags', '+faststart', output];

  if (encoder === 'videotoolbox') {
    log?.warnings?.push('GPU 轉碼：使用 macOS VideoToolbox。');
    return ['-y', '-hwaccel', 'videotoolbox', '-i', filePath, ...commonBeforeOutput, '-c:v', 'h264_videotoolbox', '-b:v', '12000k', ...audioArgs, ...finish];
  }

  if (encoder === 'nvenc') {
    log?.warnings?.push('GPU 轉碼：使用 NVIDIA NVENC / CUDA。');
    return ['-y', '-hwaccel', 'cuda', '-i', filePath, ...commonBeforeOutput, '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '19', '-b:v', '0', ...audioArgs, ...finish];
  }

  if (encoder === 'qsv') {
    log?.warnings?.push('GPU 轉碼：使用 Intel Quick Sync / QSV。');
    return ['-y', '-hwaccel', 'qsv', '-i', filePath, ...commonBeforeOutput, '-c:v', 'h264_qsv', '-global_quality', '18', ...audioArgs, ...finish];
  }

  if (encoder === 'amf') {
    log?.warnings?.push('GPU 轉碼：使用 AMD AMF。');
    return ['-y', '-i', filePath, ...commonBeforeOutput, '-c:v', 'h264_amf', '-quality', 'quality', '-qp_i', '18', '-qp_p', '18', ...audioArgs, ...finish];
  }

  if (String(config?.settings?.transcodeGpuMode || 'auto') !== 'off') {
    log?.warnings?.push('未偵測到可用 GPU H.264 編碼器，改用 libx264 軟體轉碼。');
  }

  return ['-y', '-i', filePath, ...commonBeforeOutput, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', ...audioArgs, ...finish];
}

async function transcodeAsset(filePath, targetSubdir, outputExt, config, log, label, buildArgs) {
  const sourceHash = await hashFile(filePath);
  const targetDir = path.join(DATA_DIR, targetSubdir);
  await fs.mkdir(targetDir, { recursive: true });

  const sourceName = safeFilename(path.basename(filePath, path.extname(filePath)));
  const dest = path.join(targetDir, `${sourceName}-${sourceHash.slice(0, 8)}${outputExt}`);

  if (await exists(dest)) {
    return {
      rel: normalizeRel(path.relative(DATA_DIR, dest)),
      hash: sourceHash,
      copied: false,
      duplicateFile: true,
      transcoded: true,
      filename: path.basename(dest)
    };
  }

  const temp = `${dest}.tmp-${process.pid}${outputExt}`;

  try {
    await runFfmpeg(config, await buildArgs(temp));
    await fs.rename(temp, dest);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }

  log?.warnings?.push(`${label} 已轉換為可播放格式：${path.basename(filePath)} → ${path.basename(dest)}`);

  return {
    rel: normalizeRel(path.relative(DATA_DIR, dest)),
    hash: sourceHash,
    copied: true,
    duplicateFile: false,
    transcoded: true,
    filename: path.basename(dest)
  };
}

async function storePlayableAsset(filePath, targetSubdir, assetType, config, log, label) {
  const ext = path.extname(filePath).toLowerCase();

  if (assetType === 'audio' && AIFF_EXT.has(ext)) {
    return transcodeAsset(filePath, targetSubdir, '.wav', config, log, label || '音訊', output => [
      '-y',
      '-i', filePath,
      '-vn',
      '-map_metadata', '0',
      '-c:a', 'pcm_s16le',
      output
    ]);
  }

  if (assetType === 'video' && VIDEO_TRANSCODE_EXT.has(ext)) {
    return transcodeAsset(filePath, targetSubdir, '.mp4', config, log, label || 'PV', output => buildVideoTranscodeArgs(filePath, output, config, log));
  }

  return copyAsset(filePath, targetSubdir);
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

function normalizeResourceRecord(item, kind) {
  const rel = normalizeRel(typeof item === 'string' ? item : (item?.path || item?.file || item?.rel || ''));
  if (!rel) return null;

  const ext = path.extname(rel).toLowerCase();
  if (kind === 'lyric' && ext && !LRC_EXT.has(ext)) return null;
  if (kind === 'video' && ext && !VIDEO_EXT.has(ext)) return null;

  const filename = path.basename(rel);
  return {
    path: rel,
    filename: String((typeof item === 'object' && item?.filename) || filename),
    stem: String((typeof item === 'object' && item?.stem) || path.basename(filename, path.extname(filename))),
    hash: String((typeof item === 'object' && item?.hash) || ''),
    exists: typeof item === 'object' && typeof item.exists === 'boolean' ? item.exists : undefined,
    importedAt: String((typeof item === 'object' && item?.importedAt) || ''),
    updatedAt: String((typeof item === 'object' && item?.updatedAt) || '')
  };
}

function normalizeResourceRecordList(items, kind) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const record = normalizeResourceRecord(item, kind);
    if (!record || seen.has(record.path)) continue;
    seen.add(record.path);
    out.push(record);
  }

  return out;
}

function mergeResourceRecord(current, incoming) {
  const merged = { ...(current || {}), ...(incoming || {}) };
  merged.path = normalizeRel(merged.path || current?.path || incoming?.path || '');
  merged.filename = String(merged.filename || path.basename(merged.path));
  merged.stem = String(merged.stem || path.basename(merged.filename, path.extname(merged.filename)));
  merged.hash = String(merged.hash || current?.hash || incoming?.hash || '');
  merged.importedAt = String(merged.importedAt || current?.importedAt || incoming?.importedAt || '');
  merged.updatedAt = String(merged.updatedAt || current?.updatedAt || incoming?.updatedAt || '');
  if (typeof merged.exists !== 'boolean') delete merged.exists;
  return merged;
}

function buildResourceCounts(config, lyrics, videos) {
  const lyricPaths = new Set((lyrics || []).map(item => normalizeRel(item.path)).filter(Boolean));
  const videoPaths = new Set((videos || []).map(item => normalizeRel(item.path)).filter(Boolean));
  const boundLyricPaths = new Set();
  const boundVideoPaths = new Set();

  for (const track of config.tracks || []) {
    const lyric = normalizeRel(track.lyricpath || '');
    const video = normalizeRel(track.videopath || '');
    if (lyric) boundLyricPaths.add(lyric);
    if (video) boundVideoPaths.add(video);
  }

  return {
    lyrics: lyricPaths.size,
    videos: videoPaths.size,
    boundLyrics: boundLyricPaths.size,
    boundVideos: boundVideoPaths.size,
    standaloneLyrics: Math.max(0, lyricPaths.size - boundLyricPaths.size),
    standaloneVideos: Math.max(0, videoPaths.size - boundVideoPaths.size)
  };
}

function rebuildResourceIndex(config, options = {}) {
  const now = options.now || new Date().toISOString();
  const rawIndex = config.resourceIndex || {};
  const lyricMap = new Map();
  const videoMap = new Map();

  for (const record of normalizeResourceRecordList(rawIndex.lyrics, 'lyric')) {
    lyricMap.set(record.path, record);
  }

  for (const record of normalizeResourceRecordList(rawIndex.videos, 'video')) {
    videoMap.set(record.path, record);
  }

  for (const track of config.tracks || []) {
    const lyric = normalizeRel(track.lyricpath || '');
    if (lyric) {
      const incoming = normalizeResourceRecord({
        path: lyric,
        hash: track.hashes?.lyric || '',
        filename: track.sourceFiles?.lyric || path.basename(lyric),
        updatedAt: track.updatedAt || '',
        importedAt: track.importedAt || ''
      }, 'lyric');
      lyricMap.set(lyric, mergeResourceRecord(lyricMap.get(lyric), incoming));
    }

    const video = normalizeRel(track.videopath || '');
    if (video) {
      const incoming = normalizeResourceRecord({
        path: video,
        hash: track.hashes?.video || '',
        filename: track.sourceFiles?.video || path.basename(video),
        updatedAt: track.updatedAt || '',
        importedAt: track.importedAt || ''
      }, 'video');
      videoMap.set(video, mergeResourceRecord(videoMap.get(video), incoming));
    }
  }

  const lyrics = Array.from(lyricMap.values()).sort((a, b) => a.path.localeCompare(b.path, 'zh-Hant'));
  const videos = Array.from(videoMap.values()).sort((a, b) => a.path.localeCompare(b.path, 'zh-Hant'));
  const counts = buildResourceCounts(config, lyrics, videos);

  config.resourceIndex = {
    version: 1,
    updatedAt: rawIndex.updatedAt || now,
    counts,
    lyrics,
    videos
  };
  config.resourceCounts = counts;

  return config;
}

function addResourceIndexEntry(config, kind, relPath, meta = {}) {
  if (!config.resourceIndex) {
    config.resourceIndex = { version: 1, updatedAt: '', counts: {}, lyrics: [], videos: [] };
  }

  const listName = kind === 'video' || kind === 'videos' ? 'videos' : 'lyrics';
  const recordKind = listName === 'videos' ? 'video' : 'lyric';
  const record = normalizeResourceRecord({ path: relPath, ...meta }, recordKind);
  if (!record) return null;

  const list = normalizeResourceRecordList(config.resourceIndex[listName], recordKind);
  const index = list.findIndex(item => item.path === record.path);
  if (index >= 0) list[index] = mergeResourceRecord(list[index], record);
  else list.push(record);

  config.resourceIndex[listName] = list;
  config.resourceIndex.updatedAt = new Date().toISOString();
  rebuildResourceIndex(config, { now: config.resourceIndex.updatedAt });
  return record;
}

function removeResourceIndexEntry(config, relPath) {
  const rel = normalizeRel(relPath);
  if (!rel) return;

  if (!config.resourceIndex) return;
  config.resourceIndex.lyrics = normalizeResourceRecordList(config.resourceIndex.lyrics, 'lyric').filter(item => item.path !== rel);
  config.resourceIndex.videos = normalizeResourceRecordList(config.resourceIndex.videos, 'video').filter(item => item.path !== rel);
  config.resourceIndex.updatedAt = new Date().toISOString();
  rebuildResourceIndex(config, { now: config.resourceIndex.updatedAt });
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

  const normalized = {
    version: 2,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(raw?.settings || {})
    },
    albums: Array.from(albumsById.values()),
    tracks,
    backgrounds,
    resourceIndex: {
      version: 1,
      updatedAt: String(raw?.resourceIndex?.updatedAt || ''),
      counts: raw?.resourceIndex?.counts || raw?.resourceCounts || {},
      lyrics: normalizeResourceRecordList(raw?.resourceIndex?.lyrics || raw?.lyricsIndex || [], 'lyric'),
      videos: normalizeResourceRecordList(raw?.resourceIndex?.videos || raw?.videosIndex || [], 'video')
    },
    resourceCounts: raw?.resourceCounts || raw?.resourceIndex?.counts || {}
  };

  return rebuildResourceIndex(normalized, { now: normalized.resourceIndex.updatedAt || new Date().toISOString() });
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
  const normalized = rebuildResourceIndex(normalizeConfig(config), { now: new Date().toISOString() });
  normalized.resourceIndex.updatedAt = new Date().toISOString();
  normalized.resourceCounts = normalized.resourceIndex.counts;
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
        albumTitle: DEFAULT_IMPORT_ALBUM_TITLE,
        sourceRoot: path.dirname(item.inputPath)
      });
      continue;
    }

    if (!item.isDirectory) continue;

    const root = item.inputPath;
    const rootName = DEFAULT_IMPORT_ALBUM_TITLE;
    const entries = await fs.readdir(root, { withFileTypes: true });
    const childDirs = entries.filter(ent => ent.isDirectory() && !ent.name.startsWith('.'));
    const directMedia = entries.some(ent => ent.isFile() && classify(path.join(root, ent.name)) !== 'unknown');
    const childDirNames = childDirs.map(ent => normalizeKey(ent.name));
    const assetContainer = childDirNames.length > 0 && childDirNames.every(name => ASSET_DIR_NAMES.has(name));

    const splitByFirstChild = false;

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


function filenameForDesiredTitle(filePath, desiredTitle, forcedExt = '') {
  const sourceExt = path.extname(filePath).toLowerCase();
  const ext = forcedExt || sourceExt;
  const sourceStem = path.basename(filePath, path.extname(filePath));
  const stem = safeFilename(String(desiredTitle || sourceStem).trim() || sourceStem);
  return `${stem}${ext}`;
}

async function copyAssetNamed(filePath, targetSubdir, desiredTitle = '', forcedExt = '') {
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

  const desiredName = safeFilename(filenameForDesiredTitle(filePath, desiredTitle, forcedExt));
  const ext = path.extname(desiredName);
  const stem = path.basename(desiredName, ext);
  let dest = path.join(targetDir, desiredName);

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

async function transcodeAssetNamed(filePath, targetSubdir, outputExt, config, log, label, desiredTitle, buildArgs) {
  const sourceHash = await hashFile(filePath);
  const targetDir = path.join(DATA_DIR, targetSubdir);
  await fs.mkdir(targetDir, { recursive: true });

  const sourceName = path.basename(filePath, path.extname(filePath));
  const stem = safeFilename(String(desiredTitle || sourceName).trim() || sourceName);
  let dest = path.join(targetDir, `${stem}${outputExt}`);

  if (await exists(dest)) {
    dest = path.join(targetDir, `${stem}-${sourceHash.slice(0, 8)}${outputExt}`);
    if (await exists(dest)) {
      return {
        rel: normalizeRel(path.relative(DATA_DIR, dest)),
        hash: sourceHash,
        copied: false,
        duplicateFile: true,
        transcoded: true,
        filename: path.basename(dest)
      };
    }
  }

  const temp = `${dest}.tmp-${process.pid}${outputExt}`;

  try {
    await runFfmpeg(config, await buildArgs(temp));
    await fs.rename(temp, dest);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }

  log?.warnings?.push(`${label} 已轉換為可播放格式：${path.basename(filePath)} → ${path.basename(dest)}`);

  return {
    rel: normalizeRel(path.relative(DATA_DIR, dest)),
    hash: sourceHash,
    copied: true,
    duplicateFile: false,
    transcoded: true,
    filename: path.basename(dest)
  };
}

async function storePlayableAssetNamed(filePath, targetSubdir, assetType, config, log, label, desiredTitle = '') {
  const ext = path.extname(filePath).toLowerCase();

  if (assetType === 'audio' && AIFF_EXT.has(ext)) {
    return transcodeAssetNamed(filePath, targetSubdir, '.wav', config, log, label || '音訊', desiredTitle, output => [
      '-y',
      '-i', filePath,
      '-vn',
      '-map_metadata', '0',
      '-c:a', 'pcm_s16le',
      output
    ]);
  }

  if (assetType === 'video' && VIDEO_TRANSCODE_EXT.has(ext)) {
    return transcodeAssetNamed(filePath, targetSubdir, '.mp4', config, log, label || 'PV', desiredTitle, output => buildVideoTranscodeArgs(filePath, output, config, log));
  }

  return copyAssetNamed(filePath, targetSubdir, desiredTitle);
}

function choosePreferred(list, type, log, groupLabel) {
  if (!list.length) return null;

  const priority = type === 'audio'
    ? ['.wav', '.flac', '.aiff', '.aif', '.aifc', '.m4a', '.mp3', '.ogg', '.opus', '.aac']
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

  let copied;
  try {
    copied = await storePlayableAsset(candidate.filePath, spec.subdir, kind === 'video' ? 'video' : 'lyric', await loadConfig(), log, spec.label);
  } catch (error) {
    log.warnings.push(`${track.title}：${spec.label} 轉換/入庫失敗：${error.message}`);
    return false;
  }

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


function manualKindLabel(kind) {
  return ({ audio: '音訊', lrc: 'LRC', video: 'PV', image: 'BG' })[kind] || kind;
}

function normalizeManualKind(kind, sourcePath = '') {
  const k = String(kind || '').trim();
  if (['audio', 'lrc', 'video', 'image'].includes(k)) return k;
  return classify(sourcePath);
}

function getManualTargetAlbum(config, albumId, albumTitle) {
  const id = String(albumId || '').trim();
  if (id) {
    const album = config.albums.find(item => item.id === id);
    if (album) return album;
  }

  const title = String(albumTitle || DEFAULT_IMPORT_ALBUM_TITLE).trim() || DEFAULT_IMPORT_ALBUM_TITLE;
  return getAlbum(config, title);
}

async function stageManualImport(inputPaths) {
  const { files, skipped } = await collectInputFiles(inputPaths || []);
  const items = [];

  for (const item of files) {
    const kind = classify(item.filePath);
    if (kind === 'unknown') {
      skipped.push(`不支援的檔案：${path.basename(item.filePath)}`);
      continue;
    }

    const ext = path.extname(item.filePath).toLowerCase();
    const stem = path.basename(item.filePath, path.extname(item.filePath));
    items.push({
      id: makeId('stage', item.filePath, String(items.length)),
      sourcePath: item.filePath,
      filename: path.basename(item.filePath),
      stem,
      ext,
      kind,
      title: stem,
      size: (await fs.stat(item.filePath).catch(() => ({ size: 0 }))).size || 0
    });
  }

  return { ok: true, items, skipped };
}

async function chooseManualImport() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '選擇要手動入庫的資產',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'Media and lyrics', extensions: [...AUDIO_EXT, ...LRC_EXT, ...VIDEO_EXT, ...IMAGE_EXT].map(ext => ext.slice(1)) },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  return stageManualImport(result.filePaths);
}

async function importManualAssets(payload = {}) {
  await ensureDataDirs();

  const config = await loadConfig();
  const items = Array.isArray(payload.items) ? payload.items : [];
  const album = getManualTargetAlbum(config, payload.albumId, payload.albumTitle);
  const log = {
    addedTracks: [],
    updatedTracks: [],
    skippedTracks: [],
    skippedFiles: [],
    warnings: [],
    backgrounds: []
  };

  for (const rawItem of items) {
    const sourcePath = path.resolve(String(rawItem.sourcePath || ''));
    if (!sourcePath || !(await exists(sourcePath))) {
      log.skippedFiles.push(`來源不存在：${sourcePath}`);
      continue;
    }

    const kind = normalizeManualKind(rawItem.kind, sourcePath);
    if (kind === 'unknown') {
      log.skippedFiles.push(`不支援的檔案：${path.basename(sourcePath)}`);
      continue;
    }

    const title = String(rawItem.title || path.basename(sourcePath, path.extname(sourcePath))).trim() || path.basename(sourcePath, path.extname(sourcePath));
    const groupLabel = `${album.title} / ${title}`;

    try {
      if (kind === 'image') {
        const copied = await copyAssetNamed(sourcePath, 'bg-image', title);
        const existsInConfig = config.backgrounds.some(bg => bg.hash === copied.hash || bg.path === copied.rel);
        if (!existsInConfig) {
          config.backgrounds.push({ path: copied.rel, hash: copied.hash, importedAt: new Date().toISOString() });
          log.backgrounds.push(`${copied.copied ? '新增' : '引用既有'}背景圖：${copied.filename}`);
        } else {
          log.skippedFiles.push(`背景圖重複，略過：${copied.filename}`);
        }
        continue;
      }

      if (kind === 'audio') {
        const copied = await storePlayableAssetNamed(sourcePath, path.join('music', 'data'), 'audio', config, log, '音訊', title);
        const existing = findTrackByAlbumAndTitle(config, album.id, title);
        if (existing) {
          log.skippedTracks.push(`目標專輯已有同名歌曲，未覆蓋音訊：${groupLabel}`);
          continue;
        }

        const track = {
          id: makeId('track', album.id, title, copied.hash),
          title,
          artist: album.artist || '',
          albumId: album.id,
          albumTitle: album.title,
          year: album.year || '',
          musicpath: copied.rel,
          lyricpath: '',
          videopath: '',
          PureMusic: true,
          hashes: { music: copied.hash },
          sourceFiles: { music: path.basename(sourcePath) },
          importedAt: new Date().toISOString(),
          updatedAt: ''
        };
        config.tracks.push(track);
        log.addedTracks.push(groupLabel);
        continue;
      }

      if (kind === 'lrc') {
        const copied = await copyAssetNamed(sourcePath, path.join('music', 'lyrics'), title, '.lrc');
        const track = findTrackByAlbumAndTitle(config, album.id, title);
        addResourceIndexEntry(config, 'lyric', copied.rel, { hash: copied.hash, filename: copied.filename, importedAt: new Date().toISOString(), exists: true });
        if (track) {
          track.lyricpath = copied.rel;
          track.PureMusic = false;
          track.hashes ||= {};
          track.sourceFiles ||= {};
          track.hashes.lyric = copied.hash;
          track.sourceFiles.lyric = path.basename(sourcePath);
          track.updatedAt = new Date().toISOString();
          log.updatedTracks.push(`${groupLabel}：已綁定 LRC ${copied.filename}`);
        } else {
          log.updatedTracks.push(`${groupLabel}：已作為獨立 LRC 入庫，稍後可在「綁定管理」綁定歌曲：${copied.filename}`);
        }
        continue;
      }

      if (kind === 'video') {
        const copied = await storePlayableAssetNamed(sourcePath, 'video', 'video', config, log, 'PV', title);
        const track = findTrackByAlbumAndTitle(config, album.id, title);
        addResourceIndexEntry(config, 'video', copied.rel, { hash: copied.hash, filename: copied.filename, importedAt: new Date().toISOString(), exists: true });
        if (track) {
          track.videopath = copied.rel;
          track.hashes ||= {};
          track.sourceFiles ||= {};
          track.hashes.video = copied.hash;
          track.sourceFiles.video = path.basename(sourcePath);
          track.updatedAt = new Date().toISOString();
          log.updatedTracks.push(`${groupLabel}：已綁定 PV ${copied.filename}`);
        } else {
          log.updatedTracks.push(`${groupLabel}：已作為獨立 PV 入庫，稍後可在「綁定管理」綁定歌曲：${copied.filename}`);
        }
      }
    } catch (error) {
      log.warnings.push(`${manualKindLabel(kind)} 入庫失敗：${path.basename(sourcePath)}：${error.message}`);
    }
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
        if (group.video.length) {
          for (const pvCandidate of group.video) {
            try {
              const copiedPv = await storePlayableAsset(pvCandidate.filePath, 'video', 'video', config, log, 'PV');
              log.updatedTracks.push(`${groupLabel}：已作為獨立 PV 入庫，稍後可在「綁定管理」綁定歌曲：${copiedPv.filename}`);
            } catch (error) {
              log.warnings.push(`${groupLabel}：PV 轉換/入庫失敗：${error.message}`);
            }
          }
        }

        if (group.lrc.length) {
          log.warnings.push(`${groupLabel}：找到 ${group.lrc.length} 個 LRC，但沒有同名音訊，未建立作品`);
        }

        if (!group.video.length && !group.lrc.length) {
          log.warnings.push(`${groupLabel}：沒有可建立作品的音訊檔`);
        }
      }
      continue;
    }

    let copiedAudio;
    try {
      copiedAudio = await storePlayableAsset(audio.filePath, path.join('music', 'data'), 'audio', config, log, '音訊');
    } catch (error) {
      log.warnings.push(`${groupLabel}：音訊轉換/入庫失敗：${error.message}`);
      continue;
    }

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
    dataRoot: DATA_DIR,
    config,
    albums: config.albums,
    tracks,
    bgImages: config.backgrounds.map(bg => bg.path),
    resourceCounts: config.resourceCounts || config.resourceIndex?.counts || { lyrics: 0, videos: 0 },
    lazyResources: true,
    resourceHints: {
      videos: 'call pvs:list when PV binding table is opened',
      lyrics: 'call lrcs:list when LRC binding table is opened',
      dataFiles: 'call data:listFiles when delete manager is opened'
    }
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



async function listVideoLibrary(configInput = null, options = {}) {
  const config = configInput || await loadConfig();
  const scanDisk = Boolean(options.scanDisk);
  const syncYaml = Boolean(options.syncYaml);
  const usedByPath = new Map();

  for (const track of config.tracks || []) {
    const rel = normalizeRel(track.videopath || '');
    if (!rel) continue;
    if (!usedByPath.has(rel)) usedByPath.set(rel, []);
    usedByPath.get(rel).push({ id: track.id, title: track.title, albumId: track.albumId, albumTitle: track.albumTitle });
  }

  const byPath = new Map();

  function upsertVideoRecord(record) {
    const normalized = normalizeResourceRecord(record, 'video');
    if (!normalized) return;
    const current = byPath.get(normalized.path) || {};
    byPath.set(normalized.path, {
      ...mergeResourceRecord(current, normalized),
      usedBy: usedByPath.get(normalized.path) || current.usedBy || []
    });
  }

  // YAML first: use resourceIndex.videos saved in config.yaml before any disk scan.
  for (const record of config.resourceIndex?.videos || []) upsertVideoRecord(record);

  // Always include currently bound PV references from tracks, even if resourceIndex was produced by an older version.
  for (const rel of usedByPath.keys()) upsertVideoRecord({ path: rel });

  if (scanDisk || byPath.size === 0) {
    const videoDir = path.join(DATA_DIR, 'video');
    if (await exists(videoDir)) {
      const all = await listFilesDeep(videoDir).catch(() => []);
      for (const filePath of all) {
        if (!VIDEO_EXT.has(path.extname(filePath).toLowerCase())) continue;
        const rel = normalizeRel(path.relative(DATA_DIR, filePath));
        const stat = await fs.stat(filePath).catch(() => null);
        upsertVideoRecord({ path: rel, exists: true, updatedAt: stat ? stat.mtime.toISOString() : '' });
      }
    }
  }

  const videos = Array.from(byPath.values()).map(item => ({
    path: item.path,
    filename: item.filename || path.basename(item.path),
    stem: item.stem || path.basename(item.path, path.extname(item.path)),
    hash: item.hash || '',
    exists: item.exists,
    importedAt: item.importedAt || '',
    updatedAt: item.updatedAt || '',
    usedBy: usedByPath.get(item.path) || []
  })).sort((a, b) => a.filename.localeCompare(b.filename, 'zh-Hant'));

  if (syncYaml) {
    config.resourceIndex ||= { version: 1, updatedAt: '', counts: {}, lyrics: [], videos: [] };
    config.resourceIndex.videos = videos.map(({ usedBy, ...item }) => item);
    await saveConfig(config);
  }

  return videos;
}

async function listLyricLibrary(configInput = null, options = {}) {
  const config = configInput || await loadConfig();
  const scanDisk = Boolean(options.scanDisk);
  const syncYaml = Boolean(options.syncYaml);
  const usedByPath = new Map();

  for (const track of config.tracks || []) {
    const rel = normalizeRel(track.lyricpath || '');
    if (!rel) continue;
    if (!usedByPath.has(rel)) usedByPath.set(rel, []);
    usedByPath.get(rel).push({ id: track.id, title: track.title, albumId: track.albumId, albumTitle: track.albumTitle });
  }

  const byPath = new Map();

  function upsertLyricRecord(record) {
    const normalized = normalizeResourceRecord(record, 'lyric');
    if (!normalized) return;
    const current = byPath.get(normalized.path) || {};
    byPath.set(normalized.path, {
      ...mergeResourceRecord(current, normalized),
      usedBy: usedByPath.get(normalized.path) || current.usedBy || []
    });
  }

  // YAML first: use resourceIndex.lyrics saved in config.yaml before any disk scan.
  for (const record of config.resourceIndex?.lyrics || []) upsertLyricRecord(record);

  // Always include currently bound LRC references from tracks, even if resourceIndex was produced by an older version.
  for (const rel of usedByPath.keys()) upsertLyricRecord({ path: rel });

  if (scanDisk || byPath.size === 0) {
    const lyricDir = path.join(DATA_DIR, 'music', 'lyrics');
    if (await exists(lyricDir)) {
      const all = await listFilesDeep(lyricDir).catch(() => []);
      for (const filePath of all) {
        if (!LRC_EXT.has(path.extname(filePath).toLowerCase())) continue;
        const rel = normalizeRel(path.relative(DATA_DIR, filePath));
        const stat = await fs.stat(filePath).catch(() => null);
        upsertLyricRecord({ path: rel, exists: true, updatedAt: stat ? stat.mtime.toISOString() : '' });
      }
    }
  }

  const lyrics = Array.from(byPath.values()).map(item => ({
    path: item.path,
    filename: item.filename || path.basename(item.path),
    stem: item.stem || path.basename(item.path, path.extname(item.path)),
    hash: item.hash || '',
    exists: item.exists,
    importedAt: item.importAt || item.importedAt || '',
    updatedAt: item.updatedAt || '',
    usedBy: usedByPath.get(item.path) || []
  })).sort((a, b) => a.filename.localeCompare(b.filename, 'zh-Hant'));

  if (syncYaml) {
    config.resourceIndex ||= { version: 1, updatedAt: '', counts: {}, lyrics: [], videos: [] };
    config.resourceIndex.lyrics = lyrics.map(({ usedBy, ...item }) => item);
    await saveConfig(config);
  }

  return lyrics;
}

async function refreshResourceIndex() {
  const config = await loadConfig();
  await listLyricLibrary(config, { scanDisk: true, syncYaml: true });
  const refreshed = await loadConfig();
  await listVideoLibrary(refreshed, { scanDisk: true, syncYaml: true });
  const finalConfig = await loadConfig();
  return { ok: true, resourceCounts: finalConfig.resourceCounts || finalConfig.resourceIndex?.counts || {}, resourceIndex: finalConfig.resourceIndex };
}


function fileCategory(relPath) {
  const rel = normalizeRel(relPath);
  const ext = path.extname(rel).toLowerCase();

  if (rel.startsWith('music/data/')) return 'song';
  if (rel.startsWith('music/lyrics/')) return 'lrc';
  if (rel.startsWith('video/')) return 'pv';
  if (rel.startsWith('bg-image/')) return 'bg';
  if (AUDIO_EXT.has(ext)) return 'song';
  if (LRC_EXT.has(ext)) return 'lrc';
  if (VIDEO_EXT.has(ext)) return 'pv';
  if (IMAGE_EXT.has(ext)) return 'bg';
  return 'other';
}

function addUsage(map, relPath, usage) {
  const rel = normalizeRel(relPath);
  if (!rel) return;
  if (!map.has(rel)) map.set(rel, []);
  map.get(rel).push(usage);
}

function buildUsageMap(config) {
  const map = new Map();

  for (const track of config.tracks || []) {
    addUsage(map, track.musicpath, { type: 'song', id: track.id, title: track.title, albumId: track.albumId });
    addUsage(map, track.lyricpath, { type: 'lrc', id: track.id, title: track.title, albumId: track.albumId });
    addUsage(map, track.videopath, { type: 'pv', id: track.id, title: track.title, albumId: track.albumId });
  }

  for (const bg of config.backgrounds || []) {
    addUsage(map, bg.path, { type: 'bg', title: path.basename(bg.path || '') });
  }

  return map;
}

async function listDataFiles(configInput = null) {
  const config = configInput || await loadConfig();
  await ensureDataDirs();

  const files = await listFilesDeep(DATA_DIR).catch(() => []);
  const usageMap = buildUsageMap(config);
  const out = [];

  for (const filePath of files) {
    const rel = normalizeRel(path.relative(DATA_DIR, filePath));
    if (!rel || rel === 'config.yaml') continue;

    const stat = await fs.stat(filePath).catch(() => null);
    out.push({
      path: rel,
      filename: path.basename(filePath),
      category: fileCategory(rel),
      size: stat ? stat.size : 0,
      mtime: stat ? stat.mtime.toISOString() : '',
      usedBy: usageMap.get(rel) || []
    });
  }

  return out.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hant'));
}

async function importLrcLibrary(inputPaths) {
  await ensureDataDirs();
  const config = await loadConfig();

  const { files, skipped } = await collectInputFiles(inputPaths || []);
  const log = {
    added: [],
    skipped: [...skipped],
    warnings: []
  };

  for (const item of files) {
    if (classify(item.filePath) !== 'lrc') {
      log.skipped.push(`非 LRC 檔案，略過：${path.basename(item.filePath)}`);
      continue;
    }

    try {
      const copied = await copyAsset(item.filePath, path.join('music', 'lyrics'));
      addResourceIndexEntry(config, 'lyric', copied.rel, { hash: copied.hash, filename: copied.filename, importedAt: new Date().toISOString(), exists: true });
      if (copied.duplicateFile) {
        log.skipped.push(`LRC 已存在，略過複製：${copied.filename}`);
      } else {
        log.added.push(`新增 LRC：${copied.filename}`);
      }
    } catch (error) {
      log.warnings.push(`LRC 入庫失敗：${path.basename(item.filePath)}：${error.message}`);
    }
  }

  await saveConfig(config);
  return { ok: true, log, lyrics: await listLyricLibrary() };
}

async function chooseAndImportLrcs() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '選擇要入庫的 LRC 檔案或資料夾',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'LRC lyrics', extensions: ['lrc'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  return importLrcLibrary(result.filePaths);
}

async function importPvLibrary(inputPaths) {
  await ensureDataDirs();
  const config = await loadConfig();

  const { files, skipped } = await collectInputFiles(inputPaths || []);
  const log = {
    added: [],
    skipped: [...skipped],
    warnings: []
  };

  for (const item of files) {
    if (classify(item.filePath) !== 'video') {
      log.skipped.push(`非 PV 檔案，略過：${path.basename(item.filePath)}`);
      continue;
    }

    let copied;
    try {
      copied = await storePlayableAsset(item.filePath, 'video', 'video', config, log, 'PV');
    } catch (error) {
      log.warnings.push(`PV 轉換/入庫失敗：${path.basename(item.filePath)}：${error.message}`);
      continue;
    }

    addResourceIndexEntry(config, 'video', copied.rel, { hash: copied.hash, filename: copied.filename, importedAt: new Date().toISOString(), exists: true });
    if (copied.duplicateFile) {
      log.skipped.push(`PV 已存在，略過複製：${copied.filename}`);
    } else {
      log.added.push(`新增 PV：${copied.filename}`);
    }
  }

  await saveConfig(config);
  return { ok: true, log, videos: await listVideoLibrary() };
}

async function chooseAndImportPvs() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '選擇要入庫的 PV 檔案或資料夾',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [
      { name: 'PV / Video', extensions: [...VIDEO_EXT].map(ext => ext.slice(1)) },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  return importPvLibrary(result.filePaths);
}

async function bindTracksToAlbum({ trackIds, albumId }) {
  const config = await loadConfig();
  const ids = Array.isArray(trackIds) ? trackIds : [];
  const album = config.albums.find(item => item.id === albumId);

  if (!album) return { ok: false, error: 'Album not found' };
  if (!ids.length) return { ok: false, error: '沒有選擇歌曲' };

  let updated = 0;
  const skipped = [];
  const now = new Date().toISOString();
  const selectedIds = new Set(ids);
  const occupiedTitleKeys = new Map();

  for (const track of config.tracks) {
    if (track.albumId !== album.id) continue;
    if (selectedIds.has(track.id)) continue;
    occupiedTitleKeys.set(normalizeKey(track.title), track);
  }

  for (const track of config.tracks) {
    if (!selectedIds.has(track.id)) continue;

    const key = normalizeKey(track.title);
    const duplicate = occupiedTitleKeys.get(key);
    if (duplicate && duplicate.id !== track.id) {
      skipped.push(`${track.title}：目標專輯已有同名歌曲，已跳過`);
      continue;
    }

    track.albumId = album.id;
    track.albumTitle = album.title;
    if (!track.artist) track.artist = album.artist || '';
    if (!track.year) track.year = album.year || '';
    track.updatedAt = now;
    occupiedTitleKeys.set(key, track);
    updated++;
  }

  await saveConfig(config);
  return { ok: true, updated, skipped };
}

async function bindPvToTrack({ trackId, videoPath }) {
  const config = await loadConfig();
  const track = config.tracks.find(item => item.id === trackId);
  const rel = normalizeRel(videoPath || '');

  if (!track) return { ok: false, error: 'Track not found' };
  if (!rel) return { ok: false, error: '沒有選擇 PV' };

  const abs = assertInsideDataDir(rel);
  if (!(await exists(abs))) return { ok: false, error: `PV 檔案不存在：${rel}` };
  if (!VIDEO_EXT.has(path.extname(abs).toLowerCase())) return { ok: false, error: '選擇的檔案不是支援的 PV 格式' };

  addResourceIndexEntry(config, 'video', rel, { hash: await hashFile(abs).catch(() => ''), filename: path.basename(abs), exists: true, updatedAt: new Date().toISOString() });
  track.videopath = rel;
  track.hashes ||= {};
  track.sourceFiles ||= {};
  track.hashes.video = await hashFile(abs).catch(() => '');
  track.sourceFiles.video = path.basename(abs);
  track.updatedAt = new Date().toISOString();

  await saveConfig(config);
  return { ok: true, track };
}

async function unbindPvFromTrack(trackId) {
  const config = await loadConfig();
  const track = config.tracks.find(item => item.id === trackId);

  if (!track) return { ok: false, error: 'Track not found' };

  track.videopath = '';
  if (track.hashes) delete track.hashes.video;
  if (track.sourceFiles) delete track.sourceFiles.video;
  track.updatedAt = new Date().toISOString();

  await saveConfig(config);
  return { ok: true, track };
}


async function bindLrcToTrack({ trackId, lyricPath }) {
  const config = await loadConfig();
  const track = config.tracks.find(item => item.id === trackId);
  const rel = normalizeRel(lyricPath || '');

  if (!track) return { ok: false, error: 'Track not found' };
  if (!rel) return { ok: false, error: '沒有選擇 LRC' };

  const abs = assertInsideDataDir(rel);
  if (!(await exists(abs))) return { ok: false, error: `LRC 檔案不存在：${rel}` };
  if (!LRC_EXT.has(path.extname(abs).toLowerCase())) return { ok: false, error: '選擇的檔案不是 LRC' };

  addResourceIndexEntry(config, 'lyric', rel, { hash: await hashFile(abs).catch(() => ''), filename: path.basename(abs), exists: true, updatedAt: new Date().toISOString() });
  track.lyricpath = rel;
  track.PureMusic = false;
  track.hashes ||= {};
  track.sourceFiles ||= {};
  track.hashes.lyric = await hashFile(abs).catch(() => '');
  track.sourceFiles.lyric = path.basename(abs);
  track.updatedAt = new Date().toISOString();

  await saveConfig(config);
  return { ok: true, track };
}

async function unbindLrcFromTrack(trackId) {
  const config = await loadConfig();
  const track = config.tracks.find(item => item.id === trackId);

  if (!track) return { ok: false, error: 'Track not found' };

  track.lyricpath = '';
  track.PureMusic = true;
  if (track.hashes) delete track.hashes.lyric;
  if (track.sourceFiles) delete track.sourceFiles.lyric;
  track.updatedAt = new Date().toISOString();

  await saveConfig(config);
  return { ok: true, track };
}

async function autoBindLrcsByName() {
  const config = await loadConfig();
  const lyrics = await listLyricLibrary(config);
  const availableLyrics = lyrics.filter(lyric => lyric.usedBy.length === 0);

  const tracksByTitle = new Map();
  for (const track of config.tracks) {
    const key = normalizeKey(track.title);
    if (!tracksByTitle.has(key)) tracksByTitle.set(key, []);
    tracksByTitle.get(key).push(track);
  }

  const lyricsByStem = new Map();
  for (const lyric of availableLyrics) {
    const key = normalizeKey(lyric.stem);
    if (!lyricsByStem.has(key)) lyricsByStem.set(key, []);
    lyricsByStem.get(key).push(lyric);
  }

  const log = { bound: [], skipped: [], warnings: [] };
  let updated = 0;

  for (const [key, tracks] of tracksByTitle.entries()) {
    const candidates = lyricsByStem.get(key) || [];
    if (!candidates.length) continue;

    if (tracks.length !== 1) {
      log.warnings.push(`歌曲名重複，無法自動判斷：${tracks.map(track => track.title).join(', ')}`);
      continue;
    }

    if (candidates.length !== 1) {
      log.warnings.push(`LRC 同名檔超過 1 個，無法自動判斷：${candidates.map(lyric => lyric.filename).join(', ')}`);
      continue;
    }

    const track = tracks[0];
    if (track.lyricpath) {
      log.skipped.push(`已經有 LRC，略過：${track.title}`);
      continue;
    }

    const lyric = candidates[0];
    const abs = assertInsideDataDir(lyric.path);

    addResourceIndexEntry(config, 'lyric', lyric.path, { hash: lyric.hash || '', filename: lyric.filename, exists: lyric.exists, updatedAt: new Date().toISOString() });
    track.lyricpath = lyric.path;
    track.PureMusic = false;
    track.hashes ||= {};
    track.sourceFiles ||= {};
    track.hashes.lyric = await hashFile(abs).catch(() => lyric.hash || '');
    track.sourceFiles.lyric = lyric.filename;
    track.updatedAt = new Date().toISOString();
    updated++;

    log.bound.push(`${track.title} ⇐ ${lyric.filename}`);
  }

  await saveConfig(config);
  return { ok: true, updated, log };
}

async function autoBindPvsByName() {
  const config = await loadConfig();
  const videos = await listVideoLibrary(config);
  const availableVideos = videos.filter(video => video.usedBy.length === 0);

  const tracksByTitle = new Map();
  for (const track of config.tracks) {
    const key = normalizeKey(track.title);
    if (!tracksByTitle.has(key)) tracksByTitle.set(key, []);
    tracksByTitle.get(key).push(track);
  }

  const videosByStem = new Map();
  for (const video of availableVideos) {
    const key = normalizeKey(video.stem);
    if (!videosByStem.has(key)) videosByStem.set(key, []);
    videosByStem.get(key).push(video);
  }

  const log = { bound: [], skipped: [], warnings: [] };
  let updated = 0;

  for (const [key, tracks] of tracksByTitle.entries()) {
    const candidates = videosByStem.get(key) || [];
    if (!candidates.length) continue;

    if (tracks.length !== 1) {
      log.warnings.push(`歌曲名重複，無法自動判斷：${tracks.map(track => track.title).join(', ')}`);
      continue;
    }

    if (candidates.length !== 1) {
      log.warnings.push(`PV 同名檔超過 1 個，無法自動判斷：${candidates.map(video => video.filename).join(', ')}`);
      continue;
    }

    const track = tracks[0];
    if (track.videopath) {
      log.skipped.push(`已經有 PV，略過：${track.title}`);
      continue;
    }

    const video = candidates[0];
    const abs = assertInsideDataDir(video.path);

    addResourceIndexEntry(config, 'video', video.path, { hash: video.hash || '', filename: video.filename, exists: video.exists, updatedAt: new Date().toISOString() });
    track.videopath = video.path;
    track.hashes ||= {};
    track.sourceFiles ||= {};
    track.hashes.video = await hashFile(abs).catch(() => video.hash || '');
    track.sourceFiles.video = video.filename;
    track.updatedAt = new Date().toISOString();
    updated++;

    log.bound.push(`${track.title} ⇐ ${video.filename}`);
  }

  await saveConfig(config);
  return { ok: true, updated, log };
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



function configPathIsReferenced(config, relPath) {
  const rel = normalizeRel(relPath);
  if (!rel) return false;

  if ((config.backgrounds || []).some(bg => normalizeRel(bg.path) === rel)) return true;

  return (config.tracks || []).some(track =>
    normalizeRel(track.musicpath) === rel ||
    normalizeRel(track.lyricpath) === rel ||
    normalizeRel(track.videopath) === rel
  );
}

async function removePhysicalIfUnreferenced(relPath, config, log) {
  const rel = normalizeRel(relPath);
  if (!rel || rel === 'config.yaml') return false;

  if (configPathIsReferenced(config, rel)) {
    log?.skipped?.push(`${rel} 仍被其他項目引用，未刪除實體檔案`);
    return false;
  }

  const abs = assertInsideDataDir(rel);
  if (!(await exists(abs))) return false;

  await fs.rm(abs, { force: true });
  log?.deletedFiles?.push(rel);
  return true;
}

async function deleteTrack(payload) {
  const trackId = typeof payload === 'string' ? payload : payload?.trackId;
  const deleteFiles = typeof payload === 'object' && payload?.deleteFiles === true;
  const config = await loadConfig();
  const track = config.tracks.find(item => item.id === trackId);

  if (!track) return { ok: false, error: 'Track not found' };

  const fileRefs = [track.musicpath, track.lyricpath, track.videopath].map(normalizeRel).filter(Boolean);
  config.tracks = config.tracks.filter(item => item.id !== trackId);

  const log = {
    removedTracks: [`${track.title} · ${track.albumTitle || ''}`],
    deletedFiles: [],
    skipped: [],
    cleared: []
  };

  if (deleteFiles) {
    for (const rel of fileRefs) {
      await removePhysicalIfUnreferenced(rel, config, log);
    }
  }

  await saveConfig(config);
  return { ok: true, log };
}

async function deleteDataFile(payload) {
  const rel = normalizeRel(typeof payload === 'string' ? payload : payload?.path);
  if (!rel) return { ok: false, error: '沒有指定檔案' };
  if (rel === 'config.yaml') return { ok: false, error: '不能從這裡刪除 config.yaml' };

  const abs = assertInsideDataDir(rel);
  if (!(await exists(abs))) return { ok: false, error: `檔案不存在：${rel}` };

  const st = await fs.stat(abs);
  if (!st.isFile()) return { ok: false, error: '目前只允許刪除檔案，不刪除資料夾' };

  const config = await loadConfig();
  const log = { removedTracks: [], deletedFiles: [], skipped: [], cleared: [] };

  const beforeTracks = config.tracks.length;
  const removedTracks = [];
  config.tracks = config.tracks.filter(track => {
    if (normalizeRel(track.musicpath) === rel) {
      removedTracks.push(`${track.title} · ${track.albumTitle || ''}`);
      return false;
    }
    return true;
  });
  if (removedTracks.length) log.removedTracks.push(...removedTracks);

  for (const track of config.tracks) {
    if (normalizeRel(track.lyricpath) === rel) {
      track.lyricpath = '';
      track.PureMusic = true;
      if (track.hashes) delete track.hashes.lyric;
      if (track.sourceFiles) delete track.sourceFiles.lyric;
      track.updatedAt = new Date().toISOString();
      log.cleared.push(`已清除 LRC 綁定：${track.title}`);
    }

    if (normalizeRel(track.videopath) === rel) {
      track.videopath = '';
      if (track.hashes) delete track.hashes.video;
      if (track.sourceFiles) delete track.sourceFiles.video;
      track.updatedAt = new Date().toISOString();
      log.cleared.push(`已清除 PV 綁定：${track.title}`);
    }
  }

  removeResourceIndexEntry(config, rel);

  const oldBg = config.backgrounds.length;
  config.backgrounds = config.backgrounds.filter(bg => normalizeRel(bg.path) !== rel);
  if (config.backgrounds.length !== oldBg) log.cleared.push(`已移除背景圖記錄：${rel}`);

  await fs.rm(abs, { force: true });
  log.deletedFiles.push(rel);

  await saveConfig(config);
  return { ok: true, log, removedTrackCount: beforeTracks - config.tracks.length };
}

async function convertExistingMedia() {
  const config = await loadConfig();
  const log = { converted: [], skipped: [], warnings: [] };
  const now = new Date().toISOString();

  for (const track of config.tracks) {
    const musicRel = normalizeRel(track.musicpath || '');
    if (musicRel && AIFF_EXT.has(path.extname(musicRel).toLowerCase())) {
      try {
        const musicAbs = assertInsideDataDir(musicRel);
        const converted = await storePlayableAsset(musicAbs, path.join('music', 'data'), 'audio', config, log, '音訊');
        track.musicpath = converted.rel;
        track.hashes ||= {};
        track.hashes.music = converted.hash;
        track.sourceFiles ||= {};
        track.sourceFiles.music = path.basename(converted.rel);
        track.updatedAt = now;
        log.converted.push(`${track.title}：AIFF/AIFC → WAV`);
      } catch (error) {
        log.warnings.push(`${track.title}：音訊轉換失敗：${error.message}`);
      }
    }

    const videoRel = normalizeRel(track.videopath || '');
    if (videoRel && VIDEO_TRANSCODE_EXT.has(path.extname(videoRel).toLowerCase())) {
      try {
        const videoAbs = assertInsideDataDir(videoRel);
        const converted = await storePlayableAsset(videoAbs, 'video', 'video', config, log, 'PV');
        track.videopath = converted.rel;
        track.hashes ||= {};
        track.hashes.video = converted.hash;
        track.sourceFiles ||= {};
        track.sourceFiles.video = path.basename(converted.rel);
        track.updatedAt = now;
        log.converted.push(`${track.title}：PV → H.264 MP4`);
      } catch (error) {
        log.warnings.push(`${track.title}：PV 轉換失敗：${error.message}`);
      }
    }
  }

  const videoDir = path.join(DATA_DIR, 'video');
  const videos = (await exists(videoDir)) ? await listFilesDeep(videoDir).catch(() => []) : [];
  for (const filePath of videos) {
    if (!VIDEO_TRANSCODE_EXT.has(path.extname(filePath).toLowerCase())) continue;
    const rel = normalizeRel(path.relative(DATA_DIR, filePath));
    if (config.tracks.some(track => normalizeRel(track.videopath || '') === rel)) continue;

    try {
      const converted = await storePlayableAsset(filePath, 'video', 'video', config, log, 'PV');
      addResourceIndexEntry(config, 'video', converted.rel, { hash: converted.hash, filename: converted.filename, exists: true, updatedAt: new Date().toISOString() });
      log.converted.push(`獨立 PV：${path.basename(filePath)} → ${converted.filename}`);
    } catch (error) {
      log.warnings.push(`獨立 PV 轉換失敗：${path.basename(filePath)}：${error.message}`);
    }
  }

  await saveConfig(config);
  return { ok: true, log };
}

async function saveSettings(settings) {
  const config = await loadConfig();

  config.settings = {
    ...DEFAULT_SETTINGS,
    ...config.settings,
    fontFamily: settings?.fontFamily || DEFAULT_SETTINGS.fontFamily,
    enablePV: settings?.enablePV !== false,
    playMode: settings?.playMode || 'song-random',
    bgMode: settings?.bgMode || 'cover',
    ffmpegPath: String(settings?.ffmpegPath || '').trim(),
    transcodeGpuMode: String(settings?.transcodeGpuMode || 'auto'),
    playbackGpu: settings?.playbackGpu !== false,
    audioOutputDeviceId: String(settings?.audioOutputDeviceId || 'default'),
    audioOutputDeviceLabel: String(settings?.audioOutputDeviceLabel || '').trim(),
    playerFullscreenWin: settings?.playerFullscreenWin === true
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

async function openPlayerWindow() {
  const config = await loadConfig().catch(() => ({ settings: DEFAULT_SETTINGS }));
  const settings = { ...DEFAULT_SETTINGS, ...(config?.settings || {}) };
  const shouldFullscreen = process.platform === 'win32' && settings.playerFullscreenWin === true;

  if (playerWindow && !playerWindow.isDestroyed()) {
    if (process.platform === 'win32') playerWindow.setFullScreen(shouldFullscreen);
    playerWindow.focus();
    return;
  }

  playerWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    fullscreen: shouldFullscreen,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  playerWindow.on('closed', () => {
    playerWindow = null;
  });

  playerWindow.loadFile(path.join(ROOT_DIR, 'src', 'renderer', 'player.html'));
}

app.whenReady().then(async () => {
  await initDataRoot();
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
ipcMain.handle('assets:stageManualImport', async (_event, paths) => stageManualImport(paths));
ipcMain.handle('assets:chooseManualImport', chooseManualImport);
ipcMain.handle('assets:importManual', async (_event, payload) => importManualAssets(payload));

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
ipcMain.handle('data:getRoot', async () => ({ ok: true, ...getDataRootInfo() }));
ipcMain.handle('data:chooseRoot', chooseDataRoot);
ipcMain.handle('data:setRoot', async (_event, dataDir) => {
  try {
    const info = await useDataRoot(dataDir, true);
    return { ok: true, ...info };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('data:resetRoot', async () => {
  try {
    const info = await resetDataRoot();
    return { ok: true, ...info };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('player:launch', async () => {
  await openPlayerWindow();
  return { ok: true };
});

ipcMain.handle('player:setFullscreen', (event, enabled) => {
  const win = BrowserWindow.fromWebContents(event.sender) || playerWindow;
  if (!win || win.isDestroyed()) return { ok: false, error: 'Player window not found' };
  win.setFullScreen(Boolean(enabled));
  return { ok: true, fullscreen: win.isFullScreen() };
});

ipcMain.handle('player:toggleFullscreen', event => {
  const win = BrowserWindow.fromWebContents(event.sender) || playerWindow;
  if (!win || win.isDestroyed()) return { ok: false, error: 'Player window not found' };
  win.setFullScreen(!win.isFullScreen());
  return { ok: true, fullscreen: win.isFullScreen() };
});

ipcMain.handle('data:fileUrl', (_event, relPath) => pathToFileURL(assertInsideDataDir(relPath)).href);
ipcMain.handle('data:readText', async (_event, relPath) => fs.readFile(assertInsideDataDir(relPath), 'utf8'));

ipcMain.handle('pvs:list', async () => ({ ok: true, videos: await listVideoLibrary() }));
ipcMain.handle('pvs:import', async (_event, paths) => importPvLibrary(paths));
ipcMain.handle('pvs:chooseAndImport', chooseAndImportPvs);
ipcMain.handle('pvs:autoBind', autoBindPvsByName);
ipcMain.handle('media:convertExisting', convertExistingMedia);

ipcMain.handle('track:bindAlbum', (_event, payload) => bindTracksToAlbum(payload));
ipcMain.handle('track:bindPv', (_event, payload) => bindPvToTrack(payload));
ipcMain.handle('track:unbindPv', (_event, trackId) => unbindPvFromTrack(trackId));
ipcMain.handle('lrcs:list', async () => ({ ok: true, lyrics: await listLyricLibrary() }));
ipcMain.handle('lrcs:import', async (_event, paths) => importLrcLibrary(paths));
ipcMain.handle('lrcs:chooseAndImport', chooseAndImportLrcs);
ipcMain.handle('lrcs:autoBind', autoBindLrcsByName);

ipcMain.handle('track:bindLrc', (_event, payload) => bindLrcToTrack(payload));
ipcMain.handle('track:unbindLrc', (_event, trackId) => unbindLrcFromTrack(trackId));
ipcMain.handle('track:delete', (_event, payload) => deleteTrack(payload));
ipcMain.handle('data:listFiles', async () => ({ ok: true, files: await listDataFiles() }));
ipcMain.handle('data:deleteFile', (_event, payload) => deleteDataFile(payload));
ipcMain.handle('resources:refreshIndex', refreshResourceIndex);

