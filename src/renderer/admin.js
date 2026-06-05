const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

let library = null;

function formatImportResult(result) {
  if (!result) return '';
  if (result.canceled) return '已取消。';
  if (!result.ok) return `失敗：${result.error || 'unknown error'}`;

  const log = result.log || {};
  const lines = [];
  lines.push(`入庫完成：專輯 ${result.counts.albums} / 作品 ${result.counts.tracks} / 背景圖 ${result.counts.backgrounds}`);

  const sections = [
    ['新增作品', log.addedTracks],
    ['更新作品', log.updatedTracks],
    ['跳過作品', log.skippedTracks],
    ['背景圖', log.backgrounds],
    ['警告', log.warnings],
    ['跳過檔案', log.skippedFiles]
  ];

  for (const [title, items] of sections) {
    if (!items || !items.length) continue;
    lines.push(`\n[${title}]`);
    lines.push(...items.map(x => `- ${x}`));
  }

  return lines.join('\n');
}

function currentSettingsFromForm() {
  return {
    fontFamily: $('#fontFamily').value.trim(),
    enablePV: $('#enablePV').checked,
    playMode: $('#playMode').value,
    bgMode: $('#bgMode').value
  };
}

function fillSettingsForm() {
  const settings = library?.config?.settings || {};
  $('#fontFamily').value = settings.fontFamily || 'Noto Sans TC, Microsoft JhengHei, sans-serif';
  $('#enablePV').checked = settings.enablePV !== false;
  $('#playMode').value = settings.playMode || 'song-random';
  $('#bgMode').value = settings.bgMode || 'cover';
}

function renderStats() {
  const albums = library?.albums?.length || 0;
  const tracks = library?.tracks?.length || 0;
  const bg = library?.bgImages?.length || 0;
  $('#libraryStats').innerHTML = `
    <strong>目前作品：</strong>${tracks} 首<br>
    <strong>專輯：</strong>${albums} 張<br>
    <strong>背景圖：</strong>${bg} 張<br>
    <strong>data：</strong>${library?.dataDir || ''}
  `;
}

function renderAlbumSelect(selectedId) {
  const select = $('#albumSelect');
  select.innerHTML = '';

  const albums = library?.albums || [];
  for (const album of albums) {
    const option = document.createElement('option');
    option.value = album.id;
    option.textContent = `${album.title}${album.year ? ` (${album.year})` : ''}`;
    select.appendChild(option);
  }

  if (selectedId && albums.some(a => a.id === selectedId)) {
    select.value = selectedId;
  }
}

function fillAlbumForm() {
  const albumId = $('#albumSelect').value;
  const album = (library?.albums || []).find(a => a.id === albumId);

  $('#albumTitle').value = album?.title || '';
  $('#albumArtist').value = album?.artist || '';
  $('#albumYear').value = album?.year || '';
  $('#albumDescription').value = album?.description || '';

  renderTrackTable(albumId);
}

function renderTrackTable(albumId) {
  const tbody = $('#trackTable tbody');
  tbody.innerHTML = '';

  const tracks = (library?.tracks || []).filter(t => t.albumId === albumId);
  if (!tracks.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">這張專輯目前沒有作品。</td></tr>';
    return;
  }

  for (const track of tracks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(track.title || '')}</td>
      <td class="path-cell">${escapeHtml(track.musicpath || '')}</td>
      <td>${track.lyricpath ? '有' : '無'}</td>
      <td>${track.videopath ? '有' : '無'}</td>
      <td>${track.PureMusic ? '是' : '否'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function loadLibrary(selectedAlbumId) {
  library = await window.mmcc.getLibrary();
  fillSettingsForm();
  renderStats();
  renderAlbumSelect(selectedAlbumId);
  fillAlbumForm();
}

async function runImport(paths) {
  $('#assetLog').textContent = '入庫中，請稍候...';
  const result = await window.mmcc.importAssets(paths);
  $('#assetLog').textContent = formatImportResult(result);
  await loadLibrary($('#albumSelect').value);
}

function bindNavigation() {
  $$('aside button[data-page]').forEach(button => {
    button.addEventListener('click', () => {
      $$('aside button[data-page]').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      $$('.page').forEach(page => page.classList.remove('active'));
      $(`#${button.dataset.page}`).classList.add('active');
    });
  });
}

function bindAssetImport() {
  const dropzone = $('#dropzone');

  ['dragenter', 'dragover'].forEach(type => {
    dropzone.addEventListener(type, event => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.add('drag');
    });
  });

  ['dragleave', 'drop'].forEach(type => {
    dropzone.addEventListener(type, event => {
      event.preventDefault();
      event.stopPropagation();
      if (type === 'dragleave') dropzone.classList.remove('drag');
    });
  });

  dropzone.addEventListener('drop', async event => {
    dropzone.classList.remove('drag');
    const paths = Array.from(event.dataTransfer.files)
      .map(file => window.mmcc.getDroppedPath(file))
      .filter(Boolean);

    if (!paths.length) {
      $('#assetLog').textContent = '沒有取得可入庫的檔案路徑。';
      return;
    }
    await runImport(paths);
  });

  $('#chooseAssetsBtn').addEventListener('click', async () => {
    $('#assetLog').textContent = '入庫中，請稍候...';
    const result = await window.mmcc.chooseAssets();
    $('#assetLog').textContent = formatImportResult(result);
    await loadLibrary($('#albumSelect').value);
  });

  $('#reloadLibraryBtn').addEventListener('click', () => loadLibrary($('#albumSelect').value));
}

function bindAlbumEditor() {
  $('#albumSelect').addEventListener('change', fillAlbumForm);

  $('#saveAlbumBtn').addEventListener('click', async () => {
    const albumId = $('#albumSelect').value;
    if (!albumId) return;

    const patch = {
      title: $('#albumTitle').value,
      artist: $('#albumArtist').value,
      year: $('#albumYear').value,
      description: $('#albumDescription').value
    };

    const result = await window.mmcc.updateAlbum(albumId, patch);
    $('#assetLog').textContent = result.ok ? '專輯資訊已保存。' : `保存失敗：${result.error || 'unknown error'}`;
    await loadLibrary(albumId);
  });
}

function bindSettings() {
  async function saveAndMaybeLaunch(launch = false) {
    const result = await window.mmcc.saveSettings(currentSettingsFromForm());
    $('#settingsLog').textContent = result.ok ? '設定已保存。' : '設定保存失敗。';
    library = await window.mmcc.getLibrary();
    if (launch) await window.mmcc.launchPlayer();
  }

  $('#saveBtn').addEventListener('click', () => saveAndMaybeLaunch(false));
  $('#applyBtn').addEventListener('click', () => saveAndMaybeLaunch(false));
  $('#cancelBtn').addEventListener('click', fillSettingsForm);
  $('#launchBtn').addEventListener('click', () => saveAndMaybeLaunch(true));
  $('#openPlayerBtn').addEventListener('click', () => window.mmcc.launchPlayer());

  $('#exportBtn').addEventListener('click', async () => {
    $('#exportLog').textContent = '匯出中，請稍候...';
    const result = await window.mmcc.exportDataZip();
    $('#exportLog').textContent = result.canceled
      ? '已取消。'
      : result.ok
        ? `已匯出：${result.zipPath}`
        : `匯出失敗：${result.error || 'unknown error'}`;
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  bindNavigation();
  bindAssetImport();
  bindAlbumEditor();
  bindSettings();
  await loadLibrary();
});
