'use strict';

// 크롬 UI(렌더러)에 노출되는 안전한 브리지. contextIsolation + sandbox 하에서 동작.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('shield', {
  // 탭 제어
  newTab: (url) => invoke('tab:new', url),
  closeTab: (id) => invoke('tab:close', id),
  activateTab: (id) => invoke('tab:activate', id),
  navigate: (id, url) => invoke('tab:navigate', { id, url }),
  back: (id) => invoke('tab:back', id),
  forward: (id) => invoke('tab:forward', id),
  reload: (id) => invoke('tab:reload', id),
  stop: (id) => invoke('tab:stop', id),
  home: (id) => invoke('tab:home', id),
  toggleFullscreen: () => invoke('win:toggleFullscreen'),

  // UI / 설정 / 프라이버시
  setPanel: (open) => invoke('ui:panel', open),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  clearData: () => invoke('privacy:clear'),
  getStats: () => invoke('privacy:stats'),

  // 방문 기록(메모리 전용)
  getHistory: () => invoke('history:get'),
  clearHistory: () => invoke('history:clear'),

  // 바로가기 편집
  getShortcuts: () => invoke('shortcuts:get'),
  saveShortcuts: (list) => invoke('shortcuts:save', list),
  resetShortcuts: () => invoke('shortcuts:reset'),
  addShortcut: (item) => invoke('shortcuts:add', item),

  // 메인 → 렌더러 이벤트 구독
  on: (channel, cb) => {
    const allowed = ['tab:created', 'tab:updated', 'tab:activated', 'tab:closed', 'stats:blocked'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
