const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

let library = null;
let selectedAlbumId = '';
let selectedTrackIds = new Set();
let manualImportItems = [];
let resourceLoading = { videos: false, lyrics: false, dataFiles: false };

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

function getActivePageId() {
  return document.querySelector('.page.active')?.id || 'assets';
}

function clearLazyResourceLists() {
  if (!library) return;
  delete library.videos;
  delete library.lyrics;
  delete library.dataFiles;
}

async function loadLazyResource(kind, force = false) {
  if (!library) return;

  if (!force && Array.isArray(library[kind])) return;
  if (resourceLoading[kind]) return;

  resourceLoading[kind] = true;

  try {
    if (kind === 'videos') {
      const result = await window.mmcc.listPvs();
      library.videos = result.ok ? (result.videos || []) : [];
    } else if (kind === 'lyrics') {
      const result = await window.mmcc.listLrcs();
      library.lyrics = result.ok ? (result.lyrics || []) : [];
    } else if (kind === 'dataFiles') {
      const result = await window.mmcc.listDataFiles();
      library.dataFiles = result.ok ? (result.files || []) : [];
    }
  } finally {
    resourceLoading[kind] = false;
  }
}

async function loadBindingResources(force = false) {
  if (!library) return;
  if (force) {
    delete library.videos;
    delete library.lyrics;
  }

  await Promise.all([
    loadLazyResource('videos', force),
    loadLazyResource('lyrics', force)
  ]);
  renderBinding();
}

async function loadDeleteResources(force = false) {
  if (!library) return;
  if (force) delete library.dataFiles;

  await loadLazyResource('dataFiles', force);
  renderDeleteManager();
}

async function loadVisibleLazyResources(force = false) {
  const page = getActivePageId();
  if (page === 'bind') await loadBindingResources(force);
  if (page === 'delete') await loadDeleteResources(force);
}


function manualKindLabel(kind) {
  return ({ audio: '音訊', lrc: 'LRC', video: 'PV', image: 'BG' })[kind] || kind || '未知';
}

function renderManualImportAlbumSelect() {
  const select = $('#manualImportAlbumSelect');
  if (!select) return;

  const albums = library?.albums || [];
  select.innerHTML = `
    <option value="__uncategorized__">未分類</option>
    ${albums.map(album => `<option value="${escapeHtml(album.id)}">${escapeHtml(album.title)}${album.year ? ` (${escapeHtml(album.year)})` : ''}</option>`).join('')}
    <option value="__new__">新增專輯...</option>
  `;

  if (selectedAlbumId && albums.some(album => album.id === selectedAlbumId)) {
    select.value = selectedAlbumId;
  }
}

function renderManualImportTable() {
  const tbody = $('#manualImportTable tbody');
  if (!tbody) return;

  if (!manualImportItems.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">尚未選擇要手動入庫的檔案。</td></tr>';
    return;
  }

  tbody.innerHTML = manualImportItems.map((item, index) => `
    <tr data-index="${index}">
      <td><input type="checkbox" class="manual-import-enabled" ${item.enabled === false ? '' : 'checked'}></td>
      <td>
        <select class="manual-import-kind">
          <option value="audio" ${item.kind === 'audio' ? 'selected' : ''}>音訊</option>
          <option value="lrc" ${item.kind === 'lrc' ? 'selected' : ''}>LRC</option>
          <option value="video" ${item.kind === 'video' ? 'selected' : ''}>PV</option>
          <option value="image" ${item.kind === 'image' ? 'selected' : ''}>BG</option>
        </select>
      </td>
      <td class="path-cell">${escapeHtml(item.filename || item.sourcePath || '')}</td>
      <td><input class="manual-import-title" value="${escapeHtml(item.title || item.stem || '')}" placeholder="入庫名稱，不需要副檔名"></td>
    </tr>
  `).join('');
}

function renderManualImport() {
  renderManualImportAlbumSelect();
  renderManualImportTable();
}

function syncManualImportFromTable() {
  document.querySelectorAll('#manualImportTable tbody tr[data-index]').forEach(row => {
    const index = Number(row.dataset.index);
    const item = manualImportItems[index];
    if (!item) return;
    item.enabled = row.querySelector('.manual-import-enabled')?.checked !== false;
    item.kind = row.querySelector('.manual-import-kind')?.value || item.kind;
    item.title = row.querySelector('.manual-import-title')?.value || item.title;
  });
}

function getAlbumTitle(albumId) {
  return (library?.albums || []).find(album => album.id === albumId)?.title || '未分類';
}


function formatMediaConvertResult(result) {
  if (!result) return '';
  if (!result.ok) return `轉換失敗：${result.error || 'unknown error'}`;

  const log = result.log || {};
  const lines = [];
  if (log.converted?.length) {
    lines.push('[已轉換]');
    lines.push(...log.converted.map(item => `- ${item}`));
  }
  if (log.skipped?.length) {
    lines.push('\n[略過]');
    lines.push(...log.skipped.map(item => `- ${item}`));
  }
  if (log.warnings?.length) {
    lines.push('\n[警告]');
    lines.push(...log.warnings.map(item => `- ${item}`));
  }

  return lines.length ? lines.join('\n') : '沒有需要轉換的既有媒體。';
}

function currentSettingsFromForm() {
  return {
    fontFamily: $('#fontFamily').value.trim(),
    enablePV: $('#enablePV').checked,
    playMode: $('#playMode').value,
    bgMode: $('#bgMode').value,
    ffmpegPath: $('#ffmpegPath')?.value.trim() || '',
    transcodeGpuMode: $('#transcodeGpuMode')?.value || 'auto',
    playbackGpu: $('#playbackGpu') ? $('#playbackGpu').checked : true
  };
}

function fillSettingsForm() {
  const settings = library?.config?.settings || {};
  $('#fontFamily').value = settings.fontFamily || 'Noto Sans TC, Microsoft JhengHei, sans-serif';
  $('#enablePV').checked = settings.enablePV !== false;
  $('#playMode').value = settings.playMode || 'song-random';
  $('#bgMode').value = settings.bgMode || 'cover';
  if ($('#ffmpegPath')) $('#ffmpegPath').value = settings.ffmpegPath || '';
  if ($('#transcodeGpuMode')) $('#transcodeGpuMode').value = settings.transcodeGpuMode || 'auto';
  if ($('#playbackGpu')) $('#playbackGpu').checked = settings.playbackGpu !== false;
  fillDataRootForm();
}

function fillDataRootForm() {
  const dataRoot = library?.dataRoot || {};
  if ($('#dataRootPath')) $('#dataRootPath').value = dataRoot.dataDir || library?.dataDir || '';
  if ($('#dataRootLog')) {
    const lines = [];
    if (dataRoot.dataDir) lines.push(`目前 DATA：${dataRoot.dataDir}`);
    if (dataRoot.defaultDataDir) lines.push(`預設 DATA：${dataRoot.defaultDataDir}`);
    if (dataRoot.fallbackNotice) lines.push(dataRoot.fallbackNotice);
    $('#dataRootLog').textContent = lines.join('\n');
  }
}

function renderStats() {
  const albums = library?.albums?.length || 0;
  const tracks = library?.tracks?.length || 0;
  const bg = library?.bgImages?.length || 0;
  const counts = library?.resourceCounts || {};
  const videos = Array.isArray(library?.videos) ? library.videos.length : Number(counts.videos || 0);
  const lyrics = Array.isArray(library?.lyrics) ? library.lyrics.length : Number(counts.lyrics || 0);

  $('#libraryStats').innerHTML = `
    <div><strong>${tracks}</strong><span>作品</span></div>
    <div><strong>${albums}</strong><span>專輯</span></div>
    <div><strong>${lyrics}</strong><span>LRC</span></div>
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
    tbody.innerHTML = '<tr><td colspan="6" class="muted">沒有可顯示的歌曲。</td></tr>'; 
    return;
  }

  for (const track of tracks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="bind-track-check" value="${escapeHtml(track.id)}" ${selectedTrackIds.has(track.id) ? 'checked' : ''}></td>
      <td><strong>${escapeHtml(track.title)}</strong></td>
      <td>${escapeHtml(getAlbumTitle(track.albumId))}</td>
      <td class="path-cell">${escapeHtml(track.musicpath || '')}</td>
      <td>${track.lyricpath ? `<span class="pill ok">${escapeHtml(track.lyricpath.split('/').pop())}</span>` : '<span class="pill">未綁定</span>'}</td>
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

  if (!Array.isArray(library?.videos)) {
    pvSelect.innerHTML = '<option value="">PV 池尚未載入，切到本頁時才讀取</option>';
    pvSelect.disabled = true;
  } else {
    pvSelect.disabled = false;
    pvSelect.innerHTML = (library.videos || []).map(video => `
      <option value="${escapeHtml(video.path)}">${escapeHtml(video.filename)}${video.usedBy?.length ? ' · 已綁定' : ''}</option>
    `).join('');
  }

  if ([...trackSelect.options].some(opt => opt.value === oldTrack)) trackSelect.value = oldTrack;
  if ([...pvSelect.options].some(opt => opt.value === oldPv)) pvSelect.value = oldPv;
}

function renderPvTable() {
  const tbody = $('#pvTable tbody');
  if (!tbody) return;

  if (!Array.isArray(library?.videos)) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">PV 池尚未載入。MMCC 現在只先讀 config.yaml，進入綁定頁時才掃描 PV 檔案。</td></tr>';
    return;
  }

  const videos = library.videos || [];
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


function renderLrcSelectors() {
  const trackSelect = $('#lrcTrackSelect');
  const lrcSelect = $('#lrcFileSelect');
  if (!trackSelect || !lrcSelect) return;

  const oldTrack = trackSelect.value;
  const oldLrc = lrcSelect.value;

  trackSelect.innerHTML = (library?.tracks || []).map(track => `
    <option value="${escapeHtml(track.id)}">${escapeHtml(track.title)} · ${escapeHtml(getAlbumTitle(track.albumId))}${track.lyricpath ? ' · 已有LRC' : ''}</option>
  `).join('');

  if (!Array.isArray(library?.lyrics)) {
    lrcSelect.innerHTML = '<option value="">LRC 池尚未載入，切到本頁時才讀取</option>';
    lrcSelect.disabled = true;
  } else {
    lrcSelect.disabled = false;
    lrcSelect.innerHTML = (library.lyrics || []).map(lyric => `
      <option value="${escapeHtml(lyric.path)}">${escapeHtml(lyric.filename)}${lyric.usedBy?.length ? ' · 已綁定' : ''}</option>
    `).join('');
  }

  if ([...trackSelect.options].some(opt => opt.value === oldTrack)) trackSelect.value = oldTrack;
  if ([...lrcSelect.options].some(opt => opt.value === oldLrc)) lrcSelect.value = oldLrc;
}

function renderLrcTable() {
  const tbody = $('#lrcTable tbody');
  if (!tbody) return;

  if (!Array.isArray(library?.lyrics)) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">LRC 池尚未載入。MMCC 現在只先讀 config.yaml，進入綁定頁時才掃描 LRC 檔案。</td></tr>';
    return;
  }

  const lyrics = library.lyrics || [];
  tbody.innerHTML = '';

  if (!lyrics.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">LRC 池目前是空的。請先入庫 LRC。</td></tr>';
    return;
  }

  for (const lyric of lyrics) {
    const used = lyric.usedBy || [];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="path-cell"><strong>${escapeHtml(lyric.filename)}</strong><br>${escapeHtml(lyric.path)}</td>
      <td>${used.length ? '<span class="pill ok">已綁定</span>' : '<span class="pill warn">未綁定</span>'}</td>
      <td>${used.length ? used.map(item => `${escapeHtml(item.title)} · ${escapeHtml(getAlbumTitle(item.albumId))}`).join('<br>') : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDeleteLog(result) {
  if (!result) return '';
  if (!result.ok) return `刪除失敗：${result.error || 'unknown error'}`;
  const log = result.log || {};
  const lines = [];
  for (const [title, items] of [
    ['移除歌曲', log.removedTracks],
    ['刪除檔案', log.deletedFiles],
    ['清理引用', log.cleared],
    ['略過', log.skipped]
  ]) {
    if (!items || !items.length) continue;
    lines.push(`[${title}]`);
    lines.push(...items.map(item => `- ${item}`));
  }
  return lines.join('\n') || '完成。';
}

function categoryLabel(category) {
  return {
    song: '歌曲',
    lrc: 'LRC',
    pv: 'PV',
    bg: 'BG',
    other: '其他'
  }[category] || category;
}

function renderDeleteTrackTable() {
  const tbody = $('#deleteTrackTable tbody');
  if (!tbody) return;

  const tracks = library?.tracks || [];
  tbody.innerHTML = '';

  if (!tracks.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">目前沒有歌曲。</td></tr>';
    return;
  }

  for (const track of tracks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(track.title)}</strong></td>
      <td>${escapeHtml(getAlbumTitle(track.albumId))}</td>
      <td class="path-cell">${escapeHtml(track.musicpath || '')}</td>
      <td class="path-cell">${track.lyricpath ? escapeHtml(track.lyricpath) : '—'}</td>
      <td class="path-cell">${track.videopath ? escapeHtml(track.videopath) : '—'}</td>
      <td>
        <button class="small delete-track-record-btn" data-track-id="${escapeHtml(track.id)}">只刪記錄</button>
        <button class="small danger delete-track-files-btn" data-track-id="${escapeHtml(track.id)}">刪記錄+檔案</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function renderDataFileTable() {
  const tbody = $('#dataFileTable tbody');
  if (!tbody) return;

  if (!Array.isArray(library?.dataFiles)) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">DATA 檔案清單尚未載入。MMCC 現在只先讀 config.yaml，進入刪除頁時才掃描 /DATA。</td></tr>';
    return;
  }

  const filter = $('#deleteFileFilter')?.value || '__all__';
  const files = (library.dataFiles || []).filter(file => filter === '__all__' || file.category === filter);
  tbody.innerHTML = '';

  if (!files.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">沒有可顯示的 data 檔案。</td></tr>';
    return;
  }

  for (const file of files) {
    const used = file.usedBy || [];
    const usage = used.length
      ? used.map(item => `${escapeHtml(item.type)} · ${escapeHtml(item.title || item.id || '')}`).join('<br>')
      : '<span class="muted">未引用</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="pill">${escapeHtml(categoryLabel(file.category))}</span></td>
      <td class="path-cell"><strong>${escapeHtml(file.filename)}</strong><br>${escapeHtml(file.path)}</td>
      <td>${escapeHtml(formatBytes(file.size))}</td>
      <td>${usage}</td>
      <td><button class="small danger delete-data-file-btn" data-path="${escapeHtml(file.path)}">刪除檔案</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderDeleteManager() {
  renderDeleteTrackTable();
  renderDataFileTable();
}

function renderBinding() {
  renderBindControls();
  renderBindTrackTable();
  renderLrcSelectors();
  renderLrcTable();
  renderPvSelectors();
  renderPvTable();
}

async function loadLibrary(preferredAlbumId = '') {
  library = await window.mmcc.getLibrary();

  if (preferredAlbumId) selectedAlbumId = preferredAlbumId;

  fillSettingsForm();
  renderStats();
  renderManualImport();
  renderAlbums();
  renderBinding();
  renderDeleteManager();
  await loadVisibleLazyResources(false);
}

async function runImport(paths) {
  $('#assetLog').textContent = '入庫中，請稍候...';
  const result = await window.mmcc.importAssets(paths);
  $('#assetLog').textContent = formatImportResult(result);
  await loadLibrary(selectedAlbumId);
}

function bindNavigation() {
  $$('aside button[data-page]').forEach(button => {
    button.addEventListener('click', async () => {
      $$('aside button[data-page]').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      $$('.page').forEach(page => page.classList.remove('active'));
      $(`#${button.dataset.page}`).classList.add('active');

      if (button.dataset.page === 'bind') {
        await loadBindingResources(false);
      } else if (button.dataset.page === 'delete') {
        await loadDeleteResources(false);
      }
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

  $('#chooseManualImportBtn')?.addEventListener('click', async () => {
    $('#manualImportLog').textContent = '正在讀取檔案清單...';
    const result = await window.mmcc.chooseManualImportAssets();
    if (result.canceled) {
      $('#manualImportLog').textContent = '已取消。';
      return;
    }
    if (!result.ok) {
      $('#manualImportLog').textContent = `讀取失敗：${result.error || 'unknown error'}`;
      return;
    }

    manualImportItems = (result.items || []).map(item => ({ ...item, enabled: true }));
    renderManualImportTable();
    const skipped = result.skipped?.length ? `\n[略過]\n${result.skipped.map(x => `- ${x}`).join('\n')}` : '';
    $('#manualImportLog').textContent = `已載入 ${manualImportItems.length} 個檔案，可先修改類型與名稱後再入庫。${skipped}`;
  });

  $('#manualImportTable')?.addEventListener('input', syncManualImportFromTable);
  $('#manualImportTable')?.addEventListener('change', syncManualImportFromTable);

  $('#clearManualImportBtn')?.addEventListener('click', () => {
    manualImportItems = [];
    renderManualImportTable();
    $('#manualImportLog').textContent = '已清空手動入庫預覽。';
  });

  $('#importManualAssetsBtn')?.addEventListener('click', async () => {
    syncManualImportFromTable();
    const items = manualImportItems.filter(item => item.enabled !== false);
    if (!items.length) {
      $('#manualImportLog').textContent = '沒有選擇要入庫的檔案。';
      return;
    }

    const albumValue = $('#manualImportAlbumSelect')?.value || '__uncategorized__';
    const newAlbumTitle = $('#manualImportNewAlbumTitle')?.value.trim() || '';
    const payload = {
      albumId: albumValue && !albumValue.startsWith('__') ? albumValue : '',
      albumTitle: albumValue === '__new__' ? newAlbumTitle : albumValue === '__uncategorized__' ? '未分類' : '',
      items
    };

    if (albumValue === '__new__' && !newAlbumTitle) {
      $('#manualImportLog').textContent = '請輸入新增專輯名稱。';
      return;
    }

    $('#manualImportLog').textContent = '手動入庫中，請稍候...';
    const result = await window.mmcc.importManualAssets(payload);
    $('#manualImportLog').textContent = formatImportResult(result);
    if (result.ok) {
      manualImportItems = [];
      await loadLibrary(selectedAlbumId);
    }
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

  $('#chooseLrcsBtn').addEventListener('click', async () => {
    $('#bindLrcLog').textContent = 'LRC 入庫中，請稍候...';
    const result = await window.mmcc.chooseAndImportLrcs();
    $('#bindLrcLog').textContent = formatImportResult(result);
    await loadLibrary(selectedAlbumId);
  });

  $('#autoBindLrcBtn').addEventListener('click', async () => {
    $('#bindLrcLog').textContent = '正在按同名自動綁定 LRC...';
    const result = await window.mmcc.autoBindLrcs();
    $('#bindLrcLog').textContent = result.ok
      ? `自動綁定完成：${result.updated} 個。\n${formatGenericLog(result.log)}`
      : `自動綁定失敗：${result.error || 'unknown error'}`;
    await loadLibrary(selectedAlbumId);
  });

  $('#bindLrcBtn').addEventListener('click', async () => {
    const trackId = $('#lrcTrackSelect').value;
    const lyricPath = $('#lrcFileSelect').value;
    const result = await window.mmcc.bindLrcToTrack(trackId, lyricPath);

    $('#bindLrcLog').textContent = result.ok
      ? 'LRC 已綁定到歌曲。'
      : `LRC 綁定失敗：${result.error || 'unknown error'}`;

    if (result.ok) await loadLibrary(selectedAlbumId);
  });

  $('#unbindLrcBtn').addEventListener('click', async () => {
    const trackId = $('#lrcTrackSelect').value;
    const result = await window.mmcc.unbindLrcFromTrack(trackId);

    $('#bindLrcLog').textContent = result.ok
      ? '已移除該歌曲的 LRC 綁定。'
      : `移除失敗：${result.error || 'unknown error'}`;

    if (result.ok) await loadLibrary(selectedAlbumId);
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

function bindDeleteManager() {
  $('#deleteFileFilter')?.addEventListener('change', renderDataFileTable);
  $('#reloadDeleteFilesBtn')?.addEventListener('click', () => loadLibrary(selectedAlbumId));

  $('#deleteTrackTable')?.addEventListener('click', async event => {
    const recordBtn = event.target.closest('.delete-track-record-btn');
    const filesBtn = event.target.closest('.delete-track-files-btn');
    const button = recordBtn || filesBtn;
    if (!button) return;

    const trackId = button.dataset.trackId;
    const track = (library?.tracks || []).find(item => item.id === trackId);
    const deleteFiles = Boolean(filesBtn);
    const message = deleteFiles
      ? `確定刪除歌曲「${track?.title || trackId}」以及未被其他項目引用的 data 檔案？`
      : `確定只刪除歌曲記錄「${track?.title || trackId}」？data 檔案會保留。`;

    if (!confirm(message)) return;

    const result = await window.mmcc.deleteTrack(trackId, deleteFiles);
    $('#deleteTrackLog').textContent = formatDeleteLog(result);
    await loadLibrary(selectedAlbumId);
  });

  $('#dataFileTable')?.addEventListener('click', async event => {
    const btn = event.target.closest('.delete-data-file-btn');
    if (!btn) return;

    const relPath = btn.dataset.path;
    if (!confirm(`確定直接刪除 data 檔案？\n${relPath}\n\n引用它的歌曲 / LRC / PV / BG 記錄會同步清理。`)) return;

    const result = await window.mmcc.deleteDataFile(relPath);
    $('#deleteFileLog').textContent = formatDeleteLog(result);
    await loadLibrary(selectedAlbumId);
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

  $('#convertMediaBtn')?.addEventListener('click', async () => {
    await window.mmcc.saveSettings(currentSettingsFromForm());
    $('#settingsLog').textContent = '轉換中，請稍候。大檔案可能需要幾分鐘...';
    const result = await window.mmcc.convertExistingMedia();
    $('#settingsLog').textContent = formatMediaConvertResult(result);
    await loadLibrary(selectedAlbumId);
  });


  $('#chooseDataRootBtn')?.addEventListener('click', async () => {
    $('#dataRootLog').textContent = '正在選擇 DATA 位置...';
    const result = await window.mmcc.chooseDataRoot();
    if (result.canceled) {
      fillDataRootForm();
      return;
    }
    $('#dataRootLog').textContent = result.ok ? `DATA 位置已切換：${result.dataDir}` : `DATA 位置切換失敗：${result.error || 'unknown error'}`;
    await loadLibrary(selectedAlbumId);
  });

  $('#applyDataRootBtn')?.addEventListener('click', async () => {
    const path = $('#dataRootPath')?.value.trim();
    if (!path) {
      $('#dataRootLog').textContent = 'DATA 路徑不能為空。';
      return;
    }
    $('#dataRootLog').textContent = '正在套用 DATA 位置...';
    const result = await window.mmcc.setDataRoot(path);
    $('#dataRootLog').textContent = result.ok ? `DATA 位置已切換：${result.dataDir}` : `DATA 位置切換失敗：${result.error || 'unknown error'}`;
    if (result.ok) await loadLibrary(selectedAlbumId);
  });

  $('#resetDataRootBtn')?.addEventListener('click', async () => {
    if (!confirm('確定回到預設 DATA 位置？這不會搬移舊 DATA，只會切換目前使用的資料庫路徑。')) return;
    const result = await window.mmcc.resetDataRoot();
    $('#dataRootLog').textContent = result.ok ? `已回到預設 DATA：${result.dataDir}` : `回到預設失敗：${result.error || 'unknown error'}`;
    if (result.ok) await loadLibrary(selectedAlbumId);
  });

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
  bindDeleteManager();
  bindSettings();
  await loadLibrary();
});
