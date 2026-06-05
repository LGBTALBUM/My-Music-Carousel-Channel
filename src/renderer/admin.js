const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

let library = null;
let selectedAlbumId = '';
let selectedTrackIds = new Set();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>\"]/g, ch => ({
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

  if (result.counts) {
    lines.push(`入庫完成：專輯 ${result.counts.albums} / 作品 ${result.counts.tracks} / 背景圖 ${result.counts.backgrounds}`);
  } else {
    lines.push('處理完成。');
  }

  const sections = [
    ['新增作品', log.addedTracks],
    ['更新 / 掛載', log.updatedTracks || log.added],
    ['跳過作品', log.skippedTracks],
    ['背景圖', log.backgrounds],
    ['警告', log.warnings],
    ['跳過檔案', log.skippedFiles || log.skipped]
  ];

  for (const [title, items] of sections) {
    if (!items || !items.length) continue;
    lines.push(`\n[${title}]`);
    lines.push(...items.map(x => `- ${x}`));
  }

  return lines.join('\n');
}

function formatGenericLog(log) {
  if (!log) return '';
  const lines = [];
  for (const [title, items] of [
    ['已綁定', log.bound],
    ['新增', log.added],
    ['略過', log.skipped],
    ['警告', log.warnings]
  ]) {
    if (!items || !items.length) continue;
    lines.push(`[${title}]`);
    lines.push(...items.map(x => `- ${x}`));
  }
  return lines.join('\n') || '沒有可處理項目。';
}

function getAlbumTitle(albumId) {
  return (library?.albums || []).find(album => album.id === albumId)?.title || '未分類';
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
  const videos = library?.videos?.length || 0;

  $('#libraryStats').innerHTML = `
    <div><strong>${tracks}</strong><span>作品</span></div>
    <div><strong>${albums}</strong><span>專輯</span></div>
    <div><strong>${videos}</strong><span>PV</span></div>
    <div><strong>${bg}</strong><span>背景圖</span></div>
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

function albumOptions(includeAll = false) {
  const prefix = includeAll ? '<option value="__all__">全部專輯</option>' : '';
  return prefix + (library?.albums || []).map(album => `
    <option value="${escapeHtml(album.id)}">${escapeHtml(album.title)}${album.year ? ` (${escapeHtml(album.year)})` : ''}</option>
  `).join('');
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
  select.innerHTML = albumOptions(false);

  if (selectedAlbumId && (library?.albums || []).some(a => a.id === selectedAlbumId)) {
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
      <td>${track.lyricpath ? '<span class="pill ok">有</span>' : '<span class="pill">無</span>'}</td>
      <td>${track.videopath ? '<span class="pill ok">有</span>' : '<span class="pill">無</span>'}</td>
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

function getFilteredBindTracks() {
  const filter = $('#bindFilterAlbum')?.value || '__all__';
  const tracks = library?.tracks || [];
  return filter === '__all__' ? tracks : tracks.filter(track => track.albumId === filter);
}

function renderBindControls() {
  const filter = $('#bindFilterAlbum');
  const target = $('#bindTargetAlbum');
  const oldFilter = filter.value || '__all__';
  const oldTarget = target.value || selectedAlbumId;

  filter.innerHTML = albumOptions(true);
  target.innerHTML = albumOptions(false);

  filter.value = [...filter.options].some(opt => opt.value === oldFilter) ? oldFilter : '__all__';
  if ([...target.options].some(opt => opt.value === oldTarget)) target.value = oldTarget;
}

function renderBindTrackTable() {
  const tbody = $('#bindTrackTable tbody');
  const tracks = getFilteredBindTracks();
  tbody.innerHTML = '';

  if (!tracks.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">沒有可顯示的歌曲。</td></tr>';
    return;
  }

  for (const track of tracks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="bind-track-check" value="${escapeHtml(track.id)}" ${selectedTrackIds.has(track.id) ? 'checked' : ''}></td>
      <td><strong>${escapeHtml(track.title)}</strong></td>
      <td>${escapeHtml(getAlbumTitle(track.albumId))}</td>
      <td class="path-cell">${escapeHtml(track.musicpath || '')}</td>
      <td>${track.videopath ? `<span class="pill ok">${escapeHtml(track.videopath.split('/').pop())}</span>` : '<span class="pill">未綁定</span>'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderPvSelectors() {
  const trackSelect = $('#pvTrackSelect');
  const pvSelect = $('#pvFileSelect');
  const oldTrack = trackSelect.value;
  const oldPv = pvSelect.value;

  trackSelect.innerHTML = (library?.tracks || []).map(track => `
    <option value="${escapeHtml(track.id)}">${escapeHtml(track.title)} · ${escapeHtml(getAlbumTitle(track.albumId))}${track.videopath ? ' · 已有PV' : ''}</option>
  `).join('');

  pvSelect.innerHTML = (library?.videos || []).map(video => `
    <option value="${escapeHtml(video.path)}">${escapeHtml(video.filename)}${video.usedBy?.length ? ' · 已綁定' : ''}</option>
  `).join('');

  if ([...trackSelect.options].some(opt => opt.value === oldTrack)) trackSelect.value = oldTrack;
  if ([...pvSelect.options].some(opt => opt.value === oldPv)) pvSelect.value = oldPv;
}

function renderPvTable() {
  const tbody = $('#pvTable tbody');
  const videos = library?.videos || [];
  tbody.innerHTML = '';

  if (!videos.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">PV 池目前是空的。請先入庫 PV。</td></tr>';
    return;
  }

  for (const video of videos) {
    const used = video.usedBy || [];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="path-cell"><strong>${escapeHtml(video.filename)}</strong><br>${escapeHtml(video.path)}</td>
      <td>${used.length ? '<span class="pill ok">已綁定</span>' : '<span class="pill warn">未綁定</span>'}</td>
      <td>${used.length ? used.map(item => `${escapeHtml(item.title)} · ${escapeHtml(getAlbumTitle(item.albumId))}`).join('<br>') : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderBinding() {
  renderBindControls();
  renderBindTrackTable();
  renderPvSelectors();
  renderPvTable();
}

async function loadLibrary(preferredAlbumId = '') {
  library = await window.mmcc.getLibrary();

  if (preferredAlbumId) selectedAlbumId = preferredAlbumId;

  fillSettingsForm();
  renderStats();
  renderAlbums();
  renderBinding();
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

function bindBindingManager() {
  $('#bindFilterAlbum').addEventListener('change', () => renderBindTrackTable());

  $('#bindTrackTable').addEventListener('change', event => {
    const checkbox = event.target.closest('.bind-track-check');
    if (!checkbox) return;
    if (checkbox.checked) selectedTrackIds.add(checkbox.value);
    else selectedTrackIds.delete(checkbox.value);
  });

  $('#selectAllVisibleTracksBtn').addEventListener('click', () => {
    for (const track of getFilteredBindTracks()) selectedTrackIds.add(track.id);
    renderBindTrackTable();
  });

  $('#clearSelectedTracksBtn').addEventListener('click', () => {
    selectedTrackIds.clear();
    renderBindTrackTable();
  });

  $('#bindSelectedTracksBtn').addEventListener('click', async () => {
    const albumId = $('#bindTargetAlbum').value;
    const trackIds = Array.from(selectedTrackIds);
    const result = await window.mmcc.bindTracksToAlbum(trackIds, albumId);

    $('#bindAlbumLog').textContent = result.ok
      ? [`已更新 ${result.updated} 首歌曲的專輯綁定。`, ...(result.skipped || []).map(item => `- ${item}`)].join('\n')
      : `綁定失敗：${result.error || 'unknown error'}`;

    if (result.ok) {
      selectedTrackIds.clear();
      await loadLibrary(albumId);
    }
  });

  $('#choosePvsBtn').addEventListener('click', async () => {
    $('#bindPvLog').textContent = 'PV 入庫中，請稍候...';
    const result = await window.mmcc.chooseAndImportPvs();
    $('#bindPvLog').textContent = formatImportResult(result);
    await loadLibrary(selectedAlbumId);
  });

  $('#autoBindPvBtn').addEventListener('click', async () => {
    $('#bindPvLog').textContent = '正在按同名自動綁定 PV...';
    const result = await window.mmcc.autoBindPvs();
    $('#bindPvLog').textContent = result.ok
      ? `自動綁定完成：${result.updated} 個。\n${formatGenericLog(result.log)}`
      : `自動綁定失敗：${result.error || 'unknown error'}`;
    await loadLibrary(selectedAlbumId);
  });

  $('#bindPvBtn').addEventListener('click', async () => {
    const trackId = $('#pvTrackSelect').value;
    const videoPath = $('#pvFileSelect').value;
    const result = await window.mmcc.bindPvToTrack(trackId, videoPath);

    $('#bindPvLog').textContent = result.ok
      ? 'PV 已綁定到歌曲。'
      : `PV 綁定失敗：${result.error || 'unknown error'}`;

    if (result.ok) await loadLibrary(selectedAlbumId);
  });

  $('#unbindPvBtn').addEventListener('click', async () => {
    const trackId = $('#pvTrackSelect').value;
    const result = await window.mmcc.unbindPvFromTrack(trackId);

    $('#bindPvLog').textContent = result.ok
      ? '已移除該歌曲的 PV 綁定。'
      : `移除失敗：${result.error || 'unknown error'}`;

    if (result.ok) await loadLibrary(selectedAlbumId);
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
  bindBindingManager();
  bindSettings();
  await loadLibrary();
});
