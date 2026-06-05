const $ = s => document.querySelector(s);
const pages = document.querySelectorAll('.page');
let currentSettings = {};

function showPage(id){ pages.forEach(p=>p.classList.toggle('active',p.id===id)); }
document.querySelectorAll('aside button').forEach(b=>b.onclick=()=>showPage(b.dataset.page));

async function load(){
  const payload = await window.mmcc.getLibrary();
  currentSettings = payload.config.settings;
  $('#fontFamily').value = currentSettings.fontFamily || '';
  $('#enablePV').checked = currentSettings.enablePV !== false;
  $('#playMode').value = currentSettings.playMode || 'song-random';
  $('#bgMode').value = currentSettings.bgMode || 'cover';
  $('#assetLog').textContent = `目前作品：${payload.tracks.length} 首\n背景圖：${payload.bgImages.length} 張\ndata：${payload.dataDir}`;
}
function formSettings(){ return { fontFamily: $('#fontFamily').value, enablePV: $('#enablePV').checked, playMode: $('#playMode').value, bgMode: $('#bgMode').value }; }
async function save(){ await window.mmcc.saveSettings(formSettings()); await load(); }
$('#saveBtn').onclick = save;
$('#applyBtn').onclick = save;
$('#cancelBtn').onclick = load;
$('#launchBtn').onclick = () => window.mmcc.launchPlayer();
$('#openPlayerBtn').onclick = () => window.mmcc.launchPlayer();
$('#exportBtn').onclick = async () => { const folder = await window.mmcc.openFolderDialog(); if (!folder) return; const out = await window.mmcc.exportData(folder); $('#exportLog').textContent = `已匯出：${out}`; await window.mmcc.openPath(folder); };

const dz = $('#dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', async e => { e.preventDefault(); dz.classList.remove('drag'); const files = [...e.dataTransfer.files].map(f => f.path).filter(Boolean); const result = await window.mmcc.importAssets(files); $('#assetLog').textContent = `匯入完成：\n${result.imported.join('\n')}`; await load(); });
load();
