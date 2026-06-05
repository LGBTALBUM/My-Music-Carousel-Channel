const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mmcc', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  importAssets: paths => ipcRenderer.invoke('asset:import', paths),
  exportData: folder => ipcRenderer.invoke('asset:export', folder),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  launchPlayer: () => ipcRenderer.invoke('player:launch'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openPath: p => ipcRenderer.invoke('shell:openPath', p)
});
