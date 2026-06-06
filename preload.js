const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mmcc', {
  getDroppedPath(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  getLibrary: () => ipcRenderer.invoke('library:get'),

  importAssets: paths => ipcRenderer.invoke('assets:import', paths),
  chooseAssets: () => ipcRenderer.invoke('assets:chooseAndImport'),
  chooseManualImportAssets: () => ipcRenderer.invoke('assets:chooseManualImport'),
  stageManualImportAssets: paths => ipcRenderer.invoke('assets:stageManualImport', paths),
  importManualAssets: payload => ipcRenderer.invoke('assets:importManual', payload),

  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),

  createAlbum: patch => ipcRenderer.invoke('album:create', patch),
  updateAlbum: (albumId, patch) => ipcRenderer.invoke('album:update', { albumId, patch }),
  updateAlbums: patches => ipcRenderer.invoke('album:updateMany', patches),
  deleteAlbum: albumId => ipcRenderer.invoke('album:delete', albumId),

  bindTracksToAlbum: (trackIds, albumId) => ipcRenderer.invoke('track:bindAlbum', { trackIds, albumId }),
  bindPvToTrack: (trackId, videoPath) => ipcRenderer.invoke('track:bindPv', { trackId, videoPath }),
  unbindPvFromTrack: trackId => ipcRenderer.invoke('track:unbindPv', trackId),
  bindLrcToTrack: (trackId, lyricPath) => ipcRenderer.invoke('track:bindLrc', { trackId, lyricPath }),
  unbindLrcFromTrack: trackId => ipcRenderer.invoke('track:unbindLrc', trackId),
  deleteTrack: (trackId, deleteFiles = false) => ipcRenderer.invoke('track:delete', { trackId, deleteFiles }),

  listPvs: () => ipcRenderer.invoke('pvs:list'),
  importPvs: paths => ipcRenderer.invoke('pvs:import', paths),
  chooseAndImportPvs: () => ipcRenderer.invoke('pvs:chooseAndImport'),
  autoBindPvs: () => ipcRenderer.invoke('pvs:autoBind'),
  listLrcs: () => ipcRenderer.invoke('lrcs:list'),
  importLrcs: paths => ipcRenderer.invoke('lrcs:import', paths),
  chooseAndImportLrcs: () => ipcRenderer.invoke('lrcs:chooseAndImport'),
  autoBindLrcs: () => ipcRenderer.invoke('lrcs:autoBind'),
  listDataFiles: () => ipcRenderer.invoke('data:listFiles'),
  deleteDataFile: path => ipcRenderer.invoke('data:deleteFile', { path }),
  refreshResourceIndex: () => ipcRenderer.invoke('resources:refreshIndex'),
  convertExistingMedia: () => ipcRenderer.invoke('media:convertExisting'),

  getDataRoot: () => ipcRenderer.invoke('data:getRoot'),
  chooseDataRoot: () => ipcRenderer.invoke('data:chooseRoot'),
  setDataRoot: dataDir => ipcRenderer.invoke('data:setRoot', dataDir),
  resetDataRoot: () => ipcRenderer.invoke('data:resetRoot'),

  exportDataZip: () => ipcRenderer.invoke('data:exportZip'),
  launchPlayer: () => ipcRenderer.invoke('player:launch'),

  dataFileUrl: relPath => ipcRenderer.invoke('data:fileUrl', relPath),
  readDataText: relPath => ipcRenderer.invoke('data:readText', relPath)
});
