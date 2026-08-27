'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets exactly this surface and nothing else: no Node, no fs,
// no direct process control.
contextBridge.exposeInMainWorld('claudify', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => {
    ipcRenderer.on('state', (_event, state) => callback(state));
  },

  addProfile: (payload) => ipcRenderer.invoke('profile:add', payload),
  updateProfile: (payload) => ipcRenderer.invoke('profile:update', payload),
  removeProfile: (id) => ipcRenderer.invoke('profile:remove', id),

  launch: (id) => ipcRenderer.invoke('profile:launch', id),
  focus: (id) => ipcRenderer.invoke('profile:focus', id),
  quit: (id) => ipcRenderer.invoke('profile:quit', id),

  reveal: (id) => ipcRenderer.invoke('profile:reveal', id),
  openMcpConfig: (id) => ipcRenderer.invoke('profile:openMcpConfig', id),
  mcpSources: (excludeProfileId) =>
    ipcRenderer.invoke('mcp:sources', excludeProfileId),
  copyMcp: (payload) => ipcRenderer.invoke('mcp:copy', payload),

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  openSession: (payload) => ipcRenderer.invoke('sessions:open', payload),
  listArchived: () => ipcRenderer.invoke('sessions:archived'),
  unarchiveSession: (payload) => ipcRenderer.invoke('sessions:unarchive', payload),
  usage: (id) => ipcRenderer.invoke('profile:usage', id),

  chooseClaude: () => ipcRenderer.invoke('settings:chooseClaude'),
  clearClaude: () => ipcRenderer.invoke('settings:clearClaude'),
  recheck: () => ipcRenderer.invoke('settings:recheck'),
  revealRoot: () => ipcRenderer.invoke('settings:revealRoot'),
});
