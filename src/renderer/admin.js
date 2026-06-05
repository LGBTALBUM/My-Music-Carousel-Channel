const $ = s => document.querySelector(s);
const pages = document.querySelectorAll('.page');
let currentSettings = {};

function showPage(id) {
  pages.forEach(p => p.classList.toggle('active', p.id === id));
}

document.querySelectorAll('aside button').forEach(b => {
  b.onclick = () => showPage(b.dataset.page);
});

function formatImportResult(result) {
  const lines = [];
  lines.push(`入庫完成`);
  lines.push(`新增作品：${result.createdTracks || 0} 首`);
  lines.push(`更新作品：${result.updatedTracks || 0} 首`);
  lines.push(`複製資產：${(result.imported || []).length} 個`);
  if (result.imported?.length) {
    lines.push('');
    lines.push('已複製：');
    for (const item of result.imported) lines.push(`[${item.kind}] ${item.target}`);
  }
  if (result.ignored?.length) {
    lines.push('');
    lines.push('已忽略：');
    for (const item of result.ignored) lines.push(`${item.path}：${item.reason}`);
  }
  return lines.join('\n');
}

async function load() {
  const payload = await window.mmcc.getLibrary();
  currentSettings = payload.config.settings;
  $('#fontFamily').value = currentSettings.fontFamily || '';
  $('#enablePV').checked = currentSettings.enablePV !== false;
  $('#playMode').value = currentSettings.playMode || 'song-random';
  $('#bgMode').value = currentSettings.bgMode || 'cover';
  $('#assetLog').textContent = `目前作品：${payload.tracks.length} 首\n背景圖：${payload.bgImages.length} 張\ndata：${payload.dataDir}`;
}

function formSettings() {
  return {
    fontFamily: $('#fontFamily').value,
    enablePV: $('#enablePV').checked,
    playMode: $('#playMode').value,
    bgMode: $('#bgMode').value
  };
}

async function save() {
  await window.mmcc.saveSettings(formSettings());
  await load();
}

async function importPaths(paths) {
  const clean = [...new Set((paths || []).filter(Boolean))];
  if (!clean.length) {
    $('#assetLog').textContent = '沒有取得可入庫的路徑。若是拖放失敗，請改用「選擇檔案或資料夾入庫」。';
    return;
  }
  $('#assetLog').textContent = `正在入庫 ${clean.length} 個來源，請稍候...`;
  try {
    const result = await window.mmcc.importAssets(clean);
    $('#assetLog').textContent = formatImportResult(result);
    await load();
  } catch (err) {
    $('#assetLog').textContent = `入庫失敗：\n${err?.stack || err?.message || String(err)}`;
  }
}

$('#saveBtn').onclick = save;
$('#applyBtn').onclick = save;
$('#cancelBtn').onclick = load;
$('#launchBtn').onclick = () => window.mmcc.launchPlayer();
$('#openPlayerBtn').onclick = () => window.mmcc.launchPlayer();
$('#exportBtn').onclick = async () => {
  const folder = await window.mmcc.openFolderDialog();
  if (!folder) return;
  const out = await window.mmcc.exportData(folder);
  $('#exportLog').textContent = `已匯出：${out}`;
  await window.mmcc.openPath(folder);
};

const chooseBtn = $('#chooseAssetsBtn');
if (chooseBtn) {
  chooseBtn.onclick = async () => {
    const paths = await window.mmcc.openAssetsDialog();
    await importPaths(paths);
  };
}

const dz = $('#dropzone');
dz.addEventListener('dragover', e => {
  e.preventDefault();
  dz.classList.add('drag');
});
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', async e => {
  e.preventDefault();
  dz.classList.remove('drag');
  const paths = [...e.dataTransfer.files]
    .map(file => window.mmcc.getPathForFile ? window.mmcc.getPathForFile(file) : file.path)
    .filter(Boolean);
  await importPaths(paths);
});

load();
