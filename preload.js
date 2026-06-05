const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mmcc', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  importAssets: paths => ipcRenderer.invoke('asset:import', paths),
  exportData: folder => ipcRenderer.invoke('asset:export', folder),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  launchPlayer: () => ipcRenderer.invoke('player:launch'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openAssetsDialog: () => ipcRenderer.invoke('dialog:openAssets'),
  openPath: p => ipcRenderer.invoke('shell:openPath', p),
  getPathForFile: file => webUtils.getPathForFile(file)
});
