const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

let library = null;
let selectedAlbumId = '';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[ch]));
}

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
    ['同名驗證 / 警告', log.warnings],
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
    <strong>data：</strong>${escapeHtml(library?.dataDir || '')}
  `;
}

function trackCountByAlbum(albumId) {
  return (library?.tracks || []).filter(t => t.albumId === albumId).length;
}

function ensureSelectedAlbum() {
  const albums = library?.albums || [];
  if (!albums.length) {
    selectedAlbumId = '';
    return;
  }

  if (!selectedAlbumId || !albums.some(a => a.id === selectedAlbumId)) {
    selectedAlbumId = albums[0].id;
  }
}

function renderAlbumTable() {
  const tbody = $('#albumTable tbody');
  const albums = library?.albums || [];
  tbody.innerHTML = '';

  if (!albums.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">目前沒有專輯。拖入資產或新增專輯後會顯示在這裡。</td></tr>';
    return;
  }

  for (const album of albums) {
    const tr = document.createElement('tr');
    tr.dataset.albumId = album.id;
    tr.classList.toggle('selected', album.id === selectedAlbumId);

    tr.innerHTML = `
      <td><button class="small select-album-btn" data-album-id="${escapeHtml(album.id)}">查看</button></td>
      <td><input class="album-title-input" value="${escapeHtml(album.title || '')}"></td>
      <td><input class="album-artist-input" value="${escapeHtml(album.artist || '')}"></td>
      <td><input class="album-year-input" value="${escapeHtml(album.year || '')}"></td>
      <td><textarea class="album-desc-input" rows="2">${escapeHtml(album.description || '')}</textarea></td>
      <td>${trackCountByAlbum(album.id)}</td>
      <td><button class="small danger delete-album-btn" data-album-id="${escapeHtml(album.id)}">刪除空專輯</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderAlbumSelect() {
  const select = $('#trackAlbumSelect');
  select.innerHTML = '';

  const albums = library?.albums || [];
  for (const album of albums) {
    const option = document.createElement('option');
    option.value = album.id;
    option.textContent = `${album.title}${album.year ? ` (${album.year})` : ''}`;
    select.appendChild(option);
  }

  if (selectedAlbumId && albums.some(a => a.id === selectedAlbumId)) {
    select.value = selectedAlbumId;
  }
}

function renderTrackTable() {
  const tbody = $('#trackTable tbody');
  tbody.innerHTML = '';

  const tracks = (library?.tracks || []).filter(t => t.albumId === selectedAlbumId);

  if (!selectedAlbumId) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">尚未選擇專輯。</td></tr>';
    return;
  }

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

function renderAlbums() {
  ensureSelectedAlbum();
  renderAlbumTable();
  renderAlbumSelect();
  renderTrackTable();
}

async function loadLibrary(preferredAlbumId = '') {
  library = await window.mmcc.getLibrary();

  if (preferredAlbumId) {
    selectedAlbumId = preferredAlbumId;
  }

  fillSettingsForm();
  renderStats();
  renderAlbums();
}

async function runImport(paths) {
  $('#assetLog').textContent = '入庫中，請稍候...';
  const result = await window.mmcc.importAssets(paths);
  $('#assetLog').textContent = formatImportResult(result);
  await loadLibrary(selectedAlbumId);
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
    await loadLibrary(selectedAlbumId);
  });

  $('#reloadLibraryBtn').addEventListener('click', () => loadLibrary(selectedAlbumId));
}

function collectAlbumPatches() {
  return Array.from(document.querySelectorAll('#albumTable tbody tr[data-album-id]')).map(row => ({
    id: row.dataset.albumId,
    title: row.querySelector('.album-title-input')?.value || '',
    artist: row.querySelector('.album-artist-input')?.value || '',
    year: row.querySelector('.album-year-input')?.value || '',
    description: row.querySelector('.album-desc-input')?.value || ''
  }));
}

function bindAlbumManager() {
  $('#trackAlbumSelect').addEventListener('change', event => {
    selectedAlbumId = event.target.value;
    renderAlbums();
  });

  $('#albumTable').addEventListener('click', async event => {
    const selectButton = event.target.closest('.select-album-btn');
    const deleteButton = event.target.closest('.delete-album-btn');

    if (selectButton) {
      selectedAlbumId = selectButton.dataset.albumId;
      renderAlbums();
      return;
    }

    if (deleteButton) {
      const albumId = deleteButton.dataset.albumId;
      const album = (library?.albums || []).find(a => a.id === albumId);
      const count = trackCountByAlbum(albumId);

      if (count > 0) {
        $('#albumManagerLog').textContent = `「${album?.title || albumId}」仍有 ${count} 首作品，不能刪除。`;
        return;
      }

      const result = await window.mmcc.deleteAlbum(albumId);
      $('#albumManagerLog').textContent = result.ok ? '空專輯已刪除。' : `刪除失敗：${result.error || 'unknown error'}`;
      await loadLibrary();
    }
  });

  $('#saveAllAlbumsBtn').addEventListener('click', async () => {
    const patches = collectAlbumPatches();
    const result = await window.mmcc.updateAlbums(patches);

    $('#albumManagerLog').textContent = result.ok
      ? `已保存 ${patches.length} 張專輯。`
      : `保存失敗：${result.error || 'unknown error'}`;

    if (result.ok) await loadLibrary(selectedAlbumId);
  });

  $('#addAlbumBtn').addEventListener('click', async () => {
    const patch = {
      title: $('#newAlbumTitle').value,
      artist: $('#newAlbumArtist').value,
      year: $('#newAlbumYear').value,
      description: ''
    };

    const result = await window.mmcc.createAlbum(patch);

    $('#albumManagerLog').textContent = result.ok
      ? `已新增專輯：${result.album.title}`
      : `新增失敗：${result.error || 'unknown error'}`;

    if (result.ok) {
      $('#newAlbumTitle').value = '';
      $('#newAlbumArtist').value = '';
      $('#newAlbumYear').value = '';
      await loadLibrary(result.album.id);
    }
  });
}

function bindSettings() {
  async function saveAndMaybeLaunch(launch = false) {
    const result = await window.mmcc.saveSettings(currentSettingsFromForm());
    $('#settingsLog').textContent = result.ok ? '設定已保存。' : `設定保存失敗：${result.error || 'unknown error'}`;
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
  bindAlbumManager();
  bindSettings();
  await loadLibrary();
});
