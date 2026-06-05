const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const yaml = require('js-yaml');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
const DEFAULT_SETTINGS = { fontFamily: 'Noto Sans TC, Microsoft JhengHei, sans-serif', enablePV: true, playMode: 'song-random', bgMode: 'cover' };
const MEDIA_EXT = { audio: ['.mp3','.wav','.flac','.m4a','.aac','.ogg'], video: ['.mp4','.mov','.mkv','.webm'], lyric: ['.lrc'], image: ['.jpg','.jpeg','.png','.webp','.gif'] };

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
  cfg.library.albums = cfg.library.albums || [];
  return cfg;
}

async function writeConfig(cfg) {
  await fs.writeFile(CONFIG_PATH, yaml.dump(cfg, { lineWidth: 120, noRefs: true }), 'utf8');
}

function rel(p) { return path.relative(DATA_DIR, p).replaceAll(path.sep, '/'); }
function absFromData(p) { return p ? path.join(DATA_DIR, p) : ''; }
function publicUrl(p) { return p ? `file://${absFromData(p)}` : ''; }
function ext(file) { return path.extname(file).toLowerCase(); }
function isKind(file, kind) { return MEDIA_EXT[kind].includes(ext(file)); }

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
      tracks.push({ ...track, albumTitle: album.title || album.name || '未分類專輯', albumYear: album.year || track.year || '', albumId: album.id });
    }
  }
  return { config: cfg, tracks, bgImages, dataDir: DATA_DIR };
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1280, height: 840, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
}

function createPlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) { playerWindow.focus(); return; }
  playerWindow = new BrowserWindow({ width: 1920, height: 1080, backgroundColor: '#000', webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  playerWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'player.html'));
}

ipcMain.handle('library:get', getPayload);
ipcMain.handle('settings:save', async (_e, settings) => { const cfg = await readConfig(); cfg.settings = { ...cfg.settings, ...settings }; await writeConfig(cfg); return getPayload(); });
ipcMain.handle('player:launch', () => createPlayerWindow());
ipcMain.handle('dialog:openFolder', async () => { const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

ipcMain.handle('asset:import', async (_e, filePaths) => {
  const cfg = await readConfig();
  const album = cfg.library.albums.find(a => a.id === 'default') || { id: 'default', title: '未分類專輯', year: '', tracks: [] };
  if (!cfg.library.albums.find(a => a.id === 'default')) cfg.library.albums.push(album);
  const imported = [];
  for (const source of filePaths) {
    const name = path.basename(source);
    const e = ext(source);
    let destDir = null;
    if (MEDIA_EXT.audio.includes(e)) destDir = path.join(DATA_DIR, 'music', 'data');
    if (MEDIA_EXT.lyric.includes(e)) destDir = path.join(DATA_DIR, 'music', 'lyrics');
    if (MEDIA_EXT.video.includes(e)) destDir = path.join(DATA_DIR, 'video');
    if (MEDIA_EXT.image.includes(e)) destDir = path.join(DATA_DIR, 'bg-image');
    if (!destDir) continue;
    const safe = `${Date.now()}-${name}`;
    const dest = path.join(destDir, safe);
    await fs.copyFile(source, dest);
    imported.push(rel(dest));
    if (MEDIA_EXT.audio.includes(e)) {
      const base = path.basename(name, e);
      album.tracks.push({ id: uuidv4(), title: base, album: album.title, year: '', PureMusic: false, musicpath: rel(dest), lyricpath: '', videopath: '' });
    }
  }
  await writeConfig(cfg);
  return { imported, payload: await getPayload() };
});

ipcMain.handle('asset:export', async (_e, targetFolder) => {
  const zip = new AdmZip();
  zip.addLocalFolder(DATA_DIR, 'data');
  const out = path.join(targetFolder, `music-carousel-data-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  zip.writeZip(out);
  return out;
});

app.whenReady().then(async () => { await ensureDataTree(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
