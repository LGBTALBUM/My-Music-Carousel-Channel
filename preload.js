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
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  updateAlbum: (albumId, patch) => ipcRenderer.invoke('album:update', { albumId, patch }),
  exportDataZip: () => ipcRenderer.invoke('data:exportZip'),
  launchPlayer: () => ipcRenderer.invoke('player:launch'),
  dataFileUrl: relPath => ipcRenderer.invoke('data:fileUrl', relPath),
  readDataText: relPath => ipcRenderer.invoke('data:readText', relPath)
});
