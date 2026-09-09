import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../main/ipc/channels';
import type { HelmApi } from '../shared/api';
import type { BrowserState } from '../shared/types';

/**
 * 셸에 노출하는 API. channels.ts 화이트리스트 밖의 채널은 접근할 수 없고,
 * ipcRenderer 자체는 넘기지 않는다.
 */
const api: HelmApi = {
  getState: () => ipcRenderer.invoke(IPC.stateGet),
  createTab: (url) => ipcRenderer.invoke(IPC.tabsCreate, url),
  closeTab: (id) => ipcRenderer.invoke(IPC.tabsClose, id),
  selectTab: (id) => ipcRenderer.invoke(IPC.tabsSelect, id),
  navigate: (id, input) => ipcRenderer.invoke(IPC.tabsNavigate, id, input),
  goBack: (id) => ipcRenderer.invoke(IPC.tabsGoBack, id),
  goForward: (id) => ipcRenderer.invoke(IPC.tabsGoForward, id),
  reload: (id) => ipcRenderer.invoke(IPC.tabsReload, id),

  onStateChanged: (listener) => {
    const wrapped = (_event: unknown, state: BrowserState): void => listener(state);
    ipcRenderer.on(IPC.stateChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.stateChanged, wrapped);
  },

  onFocusOmnibox: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on(IPC.focusOmnibox, wrapped);
    return () => ipcRenderer.removeListener(IPC.focusOmnibox, wrapped);
  }
};

contextBridge.exposeInMainWorld('helm', api);
