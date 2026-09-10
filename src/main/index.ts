import fs from 'node:fs';
import path from 'node:path';
import { app, BaseWindow, WebContentsView, ipcMain, session, type Session } from 'electron';
import { installAppProtocol, registerAppScheme } from './browser/AppProtocol';
import { TabManager, type ContentInsets } from './browser/TabManager';
import { attachShortcuts, type ShortcutHandlers } from './browser/Shortcuts';
import { buildSuggestions, loadSearchConfig, type SearchConfig } from './browser/Omnibox';
import { History } from './browser/History';
import { Bookmarks } from './browser/Bookmarks';
import { Autofill } from './browser/Autofill';
import { Downloads } from './browser/Downloads';
import { openDatabase, type HelmDatabase } from './persistence/Database';
import { loadExtensionConfig, loadExtensions } from './browser/Extensions';
import { findInPage, printPage, savePageAsPdf, stopFind, toggleDevTools } from './browser/PageTools';
import { readTab } from './browser/ReaderService';
import { cycleThemeSource, getThemeSource, isDarkMode, setThemeSource } from './browser/Theme';
import { discoverProfiles, importProfile } from './browser/ProfileImport';
import { Overlay } from './cobrowse/Overlay';
import { Handoff } from './control/Handoff';
import { startConsoleCapture } from './tools/read_console_messages';
import { registerAllTools } from './tools/register';
import type { ToolContext } from './tools/index';
import { HelmMcpServer, type McpEndpointInfo } from './mcp/Server';
import { IPC } from './ipc/channels';
import {
  LAYOUT,
  type AiState,
  type BrowserState,
  type PendingPrompt,
  type ShellPanel,
  type ThemeSource
} from '../shared/types';
import type { ShellState } from '../shared/api';

/** Named Session: M1은 기본 세션 하나만 쓴다. 파티션 이름은 재시작 후 세션 유지의 키다. */
const SESSION_NAME = 'default';
const SESSION_PARTITION = 'persist:helm';

// 스모크 테스트가 재시작 간 프로필을 재사용하려면 userData 경로가 고정되어야 한다.
// app.whenReady() 이전, 어떤 세션도 만들기 전에 설정해야 반영된다.
const userDataOverride = process.env['HELM_USER_DATA_DIR'];
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
}

const isE2E = process.env['HELM_E2E'] === '1';

/** 유휴 언로드 임계 시간. 30분을 기다릴 수 없는 테스트가 줄여 쓴다. */
const idleUnloadOverride = Number(process.env['HELM_IDLE_UNLOAD_MS'] ?? '');

// 단일 인스턴스: 두 번째 실행은 기존 창을 띄우고 종료한다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

registerAppScheme();

let mainWindow: BaseWindow | null = null;
let shellView: WebContentsView | null = null;
let tabManager: TabManager | null = null;
let database: HelmDatabase | null = null;
let history: History | null = null;
let bookmarks: Bookmarks | null = null;
let autofill: Autofill | null = null;
let downloads: Downloads | null = null;
let searchConfig: SearchConfig = { defaultEngine: null, engines: [] };
let overlay: Overlay | null = null;
let handoff: Handoff | null = null;
let mcpServer: HelmMcpServer | null = null;
let mcpEndpoint: McpEndpointInfo | null = null;

/** 사람에게 물어 둔 것들. ask_user / request_access 가 여기서 답을 기다린다. */
const pendingPrompts = new Map<string, { prompt: PendingPrompt; resolve: (answer: string) => void }>();

/** 마지막으로 셸에 보낸 AI 상태. 셸이 늦게 붙어도 현재 상태를 받을 수 있게 보관한다. */
let aiState: AiState = {
  threadId: '',
  status: 'idle',
  pauseReason: null,
  pausedTabId: null,
  aiTabIds: [],
  overlayEnabled: true,
  mcpEndpoint: null
};

/** 셸이 그리는 크롬 상태. 탭 상태와 갱신 주기가 달라 따로 관리한다. */
const shell: ShellState = {
  panel: 'none',
  find: null,
  theme: 'system',
  darkMode: false,
  bookmarksBarVisible: false,
  extensions: []
};

function configDir(): string {
  return path.join(app.getAppPath(), 'config');
}

/** 다운로드 폴더. 테스트가 임시 폴더로 바꿔 파일 존재를 확인한다. */
function downloadDir(): string {
  const override = process.env['HELM_DOWNLOAD_DIR'];
  if (override) {
    const resolved = path.resolve(override);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  return app.getPath('downloads');
}

function sendToShell(channel: string, payload?: unknown): void {
  if (shellView && !shellView.webContents.isDestroyed()) {
    shellView.webContents.send(channel, payload);
  }
}

function pushBrowserState(state: BrowserState): void {
  sendToShell(IPC.stateChanged, state);
}

function pushShellState(): void {
  sendToShell(IPC.shellChanged, shell);
}

function pushBookmarks(): void {
  const list = bookmarks?.list() ?? [];
  const visible = list.length > 0;
  if (visible !== shell.bookmarksBarVisible) {
    shell.bookmarksBarVisible = visible;
    applyInsets();
    pushShellState();
  }
  sendToShell(IPC.bookmarksChanged, list);
}

function pushAiState(): void {
  sendToShell(IPC.aiStateChanged, aiState);
}

/** Handoff·오버레이 상태가 바뀔 때마다 셸이 볼 값을 새로 만든다. */
function refreshAiState(partial: Partial<AiState> = {}): void {
  const aiTabIds = tabManager
    ? tabManager.getState().tabs.filter((tab) => tab.owner === 'ai').map((tab) => tab.id)
    : [];

  const previousStatus = aiState.status;
  aiState = {
    ...aiState,
    aiTabIds,
    overlayEnabled: overlay?.isEnabled() ?? true,
    mcpEndpoint: mcpEndpoint?.url ?? null,
    ...partial
  };

  // 일시정지 띠가 생기거나 사라지면 웹 콘텐츠 영역이 그만큼 움직인다.
  if (previousStatus !== aiState.status) applyInsets();
  pushAiState();
}

/**
 * 사람에게 묻고 답을 기다린다. ask_user / request_access 가 공유한다.
 * 답이 오기 전에는 도구 호출이 그대로 대기한다 — 헤드리스로 도는 경우를 위한 큐잉은 M3.
 */
function askHuman(prompt: Omit<PendingPrompt, 'id' | 'createdAt'>): Promise<string> {
  const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full: PendingPrompt = { ...prompt, id, createdAt: Date.now() };

  return new Promise<string>((resolve) => {
    pendingPrompts.set(id, { prompt: full, resolve });
    sendToShell(IPC.promptRequested, full);
  });
}

/**
 * 웹 콘텐츠 영역을 둘러싼 크롬 두께를 계산해 TabManager 에 알린다.
 * 세로 탭바면 왼쪽을, 가로 탭바면 위쪽을 쓰고, 북마크바·찾기바가 있으면 위쪽이 더 두꺼워진다.
 */
function applyInsets(): void {
  if (!tabManager) return;

  const vertical = tabManager.getOrientation() === 'vertical';
  const insets: ContentInsets = {
    left: vertical ? LAYOUT.sidebarWidth : 0,
    top:
      LAYOUT.toolbarHeight +
      (vertical ? 0 : LAYOUT.horizontalTabStripHeight) +
      (shell.bookmarksBarVisible ? LAYOUT.bookmarksBarHeight : 0) +
      (aiState.status === 'paused' ? LAYOUT.pauseBarHeight : 0) +
      (shell.find ? LAYOUT.findBarHeight : 0)
  };

  tabManager.setInsets(insets);
  // 오버레이는 웹 콘텐츠와 정확히 같은 사각형을 덮어야 좌표가 맞는다.
  overlay?.setBounds(tabManager.expectedContentBounds());
}

/** 패널을 열거나 닫는다. 패널이 열리면 탭 뷰를 숨겨 셸이 그린 화면이 보이게 한다(ADR 0005). */
function setPanel(panel: ShellPanel): void {
  shell.panel = panel;
  tabManager?.setContentHidden(panel !== 'none');
  pushShellState();
}

/** 셸(React UI) 로드 주소. dev 는 vite 서버, prod 는 번들된 파일. */
function shellEntry(): { url?: string; file?: string } {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) return { url: devUrl };
  return { file: path.join(__dirname, '../renderer/index.html') };
}

function createWindow(helmSession: Session): void {
  const window = new BaseWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Helm',
    backgroundColor: '#17171a',
    show: false
  });
  mainWindow = window;

  // 셸은 기본 세션 + preload. 웹 콘텐츠 탭과 세션을 분리해 둔다.
  const shellWebView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  shellView = shellWebView;
  window.contentView.addChildView(shellWebView);

  overlay = new Overlay(window);
  handoff = new Handoff({
    onChange: (state) => {
      refreshAiState({
        threadId: state.threadId,
        status: state.status,
        pauseReason: state.pause?.reason ?? null,
        pausedTabId: state.pause?.tabId ?? null
      });
    }
  });

  const manager = new TabManager({
    window,
    session: helmSession,
    sessionName: SESSION_NAME,
    onStateChange: pushBrowserState,
    onTabWebContents: (wc) => {
      attachShortcuts(wc, shortcutHandlers);
      // AI 가 나중에 콘솔을 물어볼 수 있으므로 탭이 생길 때부터 모아 둔다.
      startConsoleCapture(wc);
    },
    onPopup: (childTabId, parentTabId) => {
      // 팝업은 부모 탭을 몰고 있던 스레드가 이어서 다룬다.
      const owner = handoff?.ownerOf(parentTabId) ?? aiState.threadId;
      const wc = tabManager?.getWebContents(childTabId);
      if (handoff && wc && owner !== '') handoff.claimTab(childTabId, owner, wc);
      refreshAiState();
    },
    onVisit: (url, title) => history?.add(url, title),
    onTitleUpdated: (url, title) => history?.updateTitle(url, title),
    ...(Number.isFinite(idleUnloadOverride) && idleUnloadOverride > 0
      ? { idleUnloadMs: idleUnloadOverride }
      : {})
  });
  tabManager = manager;

  const activeWc = (): Electron.WebContents | null => manager.getActiveWebContents();

  const shortcutHandlers: ShortcutHandlers = {
    newTab: () => void manager.createTab(),
    closeTab: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.closeTab(id);
    },
    restoreClosedTab: () => void manager.restoreClosedTab(),
    focusOmnibox: () => sendToShell(IPC.focusOmnibox),
    reload: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.reload(id);
    },
    hardReload: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.hardReload(id);
    },
    goBack: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.goBack(id);
    },
    goForward: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.goForward(id);
    },
    openHistory: () => setPanel(shell.panel === 'history' ? 'none' : 'history'),
    openDownloads: () => setPanel(shell.panel === 'downloads' ? 'none' : 'downloads'),
    openBookmarkManager: () => setPanel(shell.panel === 'bookmarks' ? 'none' : 'bookmarks'),
    bookmarkCurrentPage: () => void toggleBookmarkForActiveTab(),
    toggleReader: () => void toggleReaderForActiveTab(),
    openFind: () => {
      // 찾기바를 띄우기만 하고 검색어는 셸이 받는다.
      shell.find = shell.find ?? { query: '', matches: 0, activeMatchOrdinal: 0 };
      applyInsets();
      pushShellState();
      sendToShell(IPC.focusFindBar);
    },
    print: () => {
      const wc = activeWc();
      if (wc) void printPage(wc);
    },
    savePdf: () => void savePdfForActiveTab(),
    toggleDevTools: () => {
      const wc = activeWc();
      if (wc) toggleDevTools(wc);
    },
    zoomIn: () => stepZoom(0.1),
    zoomOut: () => stepZoom(-0.1),
    zoomReset: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.setZoom(id, 1);
    },
    cycleTheme: () => {
      shell.theme = cycleThemeSource();
      shell.darkMode = isDarkMode();
      pushShellState();
    },
    toggleOrientation: () => {
      manager.setOrientation(manager.getOrientation() === 'vertical' ? 'horizontal' : 'vertical');
      applyInsets();
    },
    escape: () => {
      const wc = activeWc();
      if (wc) stopFind(wc);
      shell.find = null;
      applyInsets();
      setPanel('none');
    },
    selectTabByIndex: (index) => manager.selectByIndex(index),
    nextTab: () => manager.cycleTab(1),
    previousTab: () => manager.cycleTab(-1)
  };

  attachShortcuts(shellWebView.webContents, shortcutHandlers);

  /** 셸은 창 콘텐츠 전체를, 탭은 그 안쪽 사각형을 채운다. 두 곳에서 같은 값을 쓴다. */
  const syncLayout = (): void => {
    const { width, height } = window.getContentBounds();
    shellWebView.setBounds({ x: 0, y: 0, width, height });
    manager.relayout();
  };

  /**
   * 창을 띄운 직후에는 Windows 프레임(캡션) 높이가 아직 반영되지 않아
   * getContentBounds() 가 잠시 더 큰 값을 돌려주고, 값이 바뀔 때 resize 이벤트도 뜨지 않는다.
   * 그대로 두면 셸 하단(사이드바 푸터)이 창 밖으로 밀려 잘리므로 값이 안정될 때까지 재동기화한다.
   */
  const settleLayout = (): void => {
    let previous = '';
    let stableTicks = 0;
    let elapsed = 0;

    const tick = (): void => {
      if (window.isDestroyed()) return;
      const { width, height } = window.getContentBounds();
      const current = `${width}x${height}`;

      if (current === previous) {
        stableTicks += 1;
      } else {
        previous = current;
        stableTicks = 0;
        syncLayout();
      }

      elapsed += 50;
      if (stableTicks < 3 && elapsed < 1000) setTimeout(tick, 50);
    };

    tick();
  };

  window.on('resize', syncLayout);

  window.on('closed', () => {
    mainWindow = null;
    shellView = null;
    overlay?.dispose();
    overlay = null;
    handoff?.dispose();
    handoff = null;
    tabManager?.dispose();
    tabManager = null;
  });

  const entry = shellEntry();
  const loaded = entry.url
    ? shellWebView.webContents.loadURL(entry.url)
    : shellWebView.webContents.loadFile(entry.file as string);

  void loaded
    .then(() => {
      window.show();
      settleLayout();
      applyInsets();
      manager.createTab();
      pushBookmarks();
      pushShellState();
      applyInsets();
      refreshAiState();
    })
    .catch((error: unknown) => {
      console.error('[createWindow] 셸 로드 실패 - 진입점:', entry, error);
    });
}

function stepZoom(delta: number): void {
  const id = tabManager?.activeTabId;
  if (id === null || id === undefined || !tabManager) return;
  tabManager.setZoom(id, tabManager.getZoom(id) + delta);
}

/** Ctrl+D — 별 토글. 이미 북마크된 페이지면 해제한다. */
async function toggleBookmarkForActiveTab(): Promise<void> {
  const wc = tabManager?.getActiveWebContents();
  if (!wc || !bookmarks) return;

  const url = wc.getURL();
  if (url.trim() === '') return;

  if (bookmarks.find(url)) bookmarks.removeByUrl(url);
  else bookmarks.add(url, wc.getTitle() || url);

  pushBookmarks();
}

async function toggleReaderForActiveTab(): Promise<void> {
  if (shell.panel === 'reader') {
    setPanel('none');
    return;
  }

  const id = tabManager?.activeTabId;
  const wc = tabManager?.getActiveWebContents();
  if (id === null || id === undefined || !wc) return;

  const payload = await readTab(wc, id);
  // 추출 실패면 패널을 열지 않는다 — 빈 화면을 보여주는 것보다 낫다.
  if (!payload.article) {
    console.warn(`[toggleReader] 본문 추출 실패 - 사유: ${payload.reason}, url: ${payload.url}`);
    return;
  }
  setPanel('reader');
}

async function savePdfForActiveTab(): Promise<void> {
  const wc = tabManager?.getActiveWebContents();
  if (!wc) return;
  await savePageAsPdf(wc, downloadDir(), wc.getTitle() || 'page');
}

/**
 * 도구 호출 컨텍스트. MCP 연결마다 threadId 가 다르고, 나머지 자원은 공유한다.
 * 여기가 ToolSurface 와 브라우저 본체가 만나는 유일한 지점이다.
 */
function createToolContext(threadId: string): ToolContext {
  if (!tabManager || !overlay || !handoff || !downloads) {
    throw new Error('[tools] 브라우저가 아직 준비되지 않았습니다');
  }

  return {
    tabs: tabManager,
    session: session.fromPartition(SESSION_PARTITION),
    downloads,
    overlay,
    handoff,
    threadId,
    downloadDir: downloadDir(),
    requestAccess: async (host, reason) => {
      const answer = await askHuman({
        kind: 'request_access',
        question: `AI 가 ${host} 에 접근하려 합니다.

이유: ${reason}`,
        options: ['허용', '거부'],
        host
      });
      return answer === '허용';
    },
    askUser: async (question, options) => ({ answer: await askHuman({ kind: 'ask_user', question, options }) })
  };
}

/** MCP 서버 기동. 실패해도 브라우저는 정상 동작해야 한다. */
async function startMcpServer(): Promise<void> {
  if (mcpServer) return;

  registerAllTools();
  const server = new HelmMcpServer({
    ...(process.env['HELM_MCP_PORT'] ? { port: Number(process.env['HELM_MCP_PORT']) } : {}),
    ...(process.env['HELM_MCP_TOKEN'] ? { token: process.env['HELM_MCP_TOKEN'] } : {}),
    createContext: createToolContext
  });

  try {
    mcpEndpoint = await server.start();
    mcpServer = server;
    refreshAiState();
  } catch (error) {
    console.error('[mcp] 서버 기동 실패 - 포트가 이미 쓰이고 있을 수 있습니다', error);
  }
}

function registerIpc(): void {
  const requireManager = (): TabManager => {
    if (!tabManager) throw new Error('[ipc] 탭 매니저 없음 - 윈도우가 아직 만들어지지 않았습니다');
    return tabManager;
  };

  /** 렌더러가 보낸 탭 id 검증: 양의 정수가 아니면 즉시 거부한다. */
  const asTabId = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

  const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

  const activeWc = (): Electron.WebContents | null =>
    tabManager?.getActiveWebContents() ?? null;

  // ── 탭 ──
  ipcMain.handle(IPC.stateGet, () => requireManager().getState());

  ipcMain.handle(IPC.tabsCreate, (_e, url: unknown) =>
    requireManager().createTab(typeof url === 'string' ? url : undefined)
  );

  ipcMain.handle(IPC.tabsClose, (_e, id: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null) return false;
    requireManager().closeTab(tabId);
    return true;
  });

  ipcMain.handle(IPC.tabsSelect, (_e, id: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null) return false;
    requireManager().selectTab(tabId);
    return true;
  });

  ipcMain.handle(IPC.tabsNavigate, (_e, id: unknown, input: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null || typeof input !== 'string') return false;
    return requireManager().navigate(tabId, input);
  });

  ipcMain.handle(IPC.tabsGoBack, (_e, id: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null) return false;
    requireManager().goBack(tabId);
    return true;
  });

  ipcMain.handle(IPC.tabsGoForward, (_e, id: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null) return false;
    requireManager().goForward(tabId);
    return true;
  });

  ipcMain.handle(IPC.tabsReload, (_e, id: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null) return false;
    requireManager().reload(tabId);
    return true;
  });

  ipcMain.handle(IPC.tabsMove, (_e, id: unknown, toIndex: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null || typeof toIndex !== 'number' || !Number.isInteger(toIndex)) return false;
    return requireManager().moveTab(tabId, toIndex);
  });

  ipcMain.handle(IPC.tabsSetPinned, (_e, id: unknown, pinned: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null || typeof pinned !== 'boolean') return false;
    return requireManager().setPinned(tabId, pinned);
  });

  ipcMain.handle(IPC.tabsSetMuted, (_e, id: unknown, muted: unknown) => {
    const tabId = asTabId(id);
    if (tabId === null || typeof muted !== 'boolean') return false;
    return requireManager().setMuted(tabId, muted);
  });

  ipcMain.handle(IPC.tabsRestoreClosed, () => requireManager().restoreClosedTab());

  ipcMain.handle(IPC.tabsSetOrientation, (_e, orientation: unknown) => {
    if (orientation !== 'vertical' && orientation !== 'horizontal') return false;
    requireManager().setOrientation(orientation);
    applyInsets();
    return true;
  });

  // ── 셸 상태 ──
  ipcMain.handle(IPC.shellGet, () => shell);

  ipcMain.handle(IPC.panelOpen, (_e, panel: unknown) => {
    const allowed: ShellPanel[] = ['none', 'history', 'downloads', 'bookmarks', 'reader'];
    if (typeof panel !== 'string' || !allowed.includes(panel as ShellPanel)) return false;
    setPanel(panel as ShellPanel);
    return true;
  });

  // ── 주소창 ──
  ipcMain.handle(IPC.omniboxSuggest, (_e, input: unknown) =>
    buildSuggestions(asText(input), {
      bookmarks: (query, limit) => bookmarks?.search(query, limit) ?? [],
      history: (query, limit) => history?.suggest(query, limit) ?? [],
      search: searchConfig
    })
  );

  // ── 히스토리 ──
  ipcMain.handle(IPC.historyList, (_e, query: unknown) => history?.list(asText(query)) ?? []);

  ipcMain.handle(IPC.historyRemove, (_e, id: unknown) => {
    if (typeof id !== 'number') return false;
    history?.remove(id);
    return true;
  });

  ipcMain.handle(IPC.historyClear, () => {
    history?.clear();
    return true;
  });

  // ── 북마크 ──
  ipcMain.handle(IPC.bookmarksList, () => bookmarks?.list() ?? []);

  ipcMain.handle(IPC.bookmarksAdd, (_e, url: unknown, title: unknown) => {
    if (typeof url !== 'string') return null;
    const added = bookmarks?.add(url, asText(title) || url) ?? null;
    pushBookmarks();
    return added;
  });

  ipcMain.handle(IPC.bookmarksRemove, (_e, id: unknown) => {
    if (typeof id !== 'number') return false;
    const removed = bookmarks?.remove(id) ?? false;
    pushBookmarks();
    return removed;
  });

  ipcMain.handle(IPC.bookmarksRemoveByUrl, (_e, url: unknown) => {
    if (typeof url !== 'string') return false;
    const removed = bookmarks?.removeByUrl(url) ?? false;
    pushBookmarks();
    return removed;
  });

  ipcMain.handle(IPC.bookmarksRename, (_e, id: unknown, title: unknown) => {
    if (typeof id !== 'number' || typeof title !== 'string') return false;
    const renamed = bookmarks?.rename(id, title) ?? false;
    pushBookmarks();
    return renamed;
  });

  // ── 다운로드 ──
  ipcMain.handle(IPC.downloadsList, () => downloads?.list() ?? []);

  ipcMain.handle(IPC.downloadStart, (_e, url: unknown) => {
    if (typeof url !== 'string' || url.trim() === '') return false;

    // 활성 탭의 webContents 로 내려받는다. 사용자가 링크를 누르는 것과 같은 경로여서
    // 출처(origin)와 쿠키 컨텍스트가 페이지와 일치하고, 커스텀 프로토콜(app://)도 처리된다.
    // 탭이 없을 때만 세션 단위로 떨어진다.
    const wc = activeWc();
    if (wc) wc.downloadURL(url);
    else session.fromPartition(SESSION_PARTITION).downloadURL(url);
    return true;
  });

  ipcMain.handle(IPC.downloadsCancel, (_e, id: unknown) =>
    typeof id === 'number' ? (downloads?.cancel(id) ?? false) : false
  );
  ipcMain.handle(IPC.downloadsPause, (_e, id: unknown) =>
    typeof id === 'number' ? (downloads?.pause(id) ?? false) : false
  );
  ipcMain.handle(IPC.downloadsResume, (_e, id: unknown) =>
    typeof id === 'number' ? (downloads?.resume(id) ?? false) : false
  );
  ipcMain.handle(IPC.downloadsShowInFolder, (_e, id: unknown) =>
    typeof id === 'number' ? (downloads?.showInFolder(id) ?? false) : false
  );
  ipcMain.handle(IPC.downloadsOpen, async (_e, id: unknown) =>
    typeof id === 'number' ? ((await downloads?.open(id)) ?? false) : false
  );
  ipcMain.handle(IPC.downloadsRemove, (_e, id: unknown) =>
    typeof id === 'number' ? (downloads?.removeFromList(id) ?? false) : false
  );
  ipcMain.handle(IPC.downloadsClearCompleted, () => {
    downloads?.clearCompleted();
    return true;
  });

  // ── 읽기 모드 ──
  ipcMain.handle(IPC.readerRead, async (_e, id: unknown) => {
    const tabId = asTabId(id);
    const manager = requireManager();
    const wc = tabId === null ? null : manager.getWebContents(tabId);
    if (tabId === null || !wc) {
      return { tabId: tabId ?? -1, url: '', article: null, reason: 'no-tab' };
    }
    return readTab(wc, tabId);
  });

  // ── 페이지 도구 ──
  ipcMain.handle(IPC.findStart, async (_e, query: unknown, advance: unknown, forward: unknown) => {
    const wc = activeWc();
    const text = asText(query);
    const empty = { query: '', matches: 0, activeMatchOrdinal: 0 };

    // 빈 검색어는 "찾기바를 연다"는 뜻이다(Ctrl+F). 바를 띄우기만 하고 검색은 하지 않는다.
    if (text.trim() === '') {
      if (wc) stopFind(wc);
      shell.find = empty;
      applyInsets();
      pushShellState();
      return empty;
    }

    if (!wc) return { ...empty, query: text };

    const result = await findInPage(wc, text, {
      advance: advance === true,
      forward: forward !== false
    });

    shell.find = result;
    applyInsets();
    pushShellState();
    return result;
  });

  ipcMain.handle(IPC.findStop, () => {
    const wc = activeWc();
    if (wc) stopFind(wc);
    shell.find = null;
    applyInsets();
    pushShellState();
    return true;
  });

  ipcMain.handle(IPC.pagePrint, async () => {
    const wc = activeWc();
    return wc ? printPage(wc) : false;
  });

  ipcMain.handle(IPC.pageSavePdf, async () => {
    const wc = activeWc();
    if (!wc) return { ok: false, filePath: null, error: '활성 탭이 없습니다' };
    return savePageAsPdf(wc, downloadDir(), wc.getTitle() || 'page');
  });

  ipcMain.handle(IPC.pageToggleDevTools, () => {
    const wc = activeWc();
    return wc ? toggleDevTools(wc) : false;
  });

  ipcMain.handle(IPC.pageSetZoom, (_e, factor: unknown) => {
    const id = tabManager?.activeTabId;
    if (typeof factor !== 'number' || id === null || id === undefined || !tabManager) return 1;
    tabManager.setZoom(id, factor);
    return tabManager.getZoom(id);
  });

  // ── 테마 ──
  ipcMain.handle(IPC.themeSet, (_e, theme: unknown) => {
    const allowed: ThemeSource[] = ['system', 'light', 'dark'];
    if (typeof theme !== 'string' || !allowed.includes(theme as ThemeSource)) return shell.theme;
    shell.theme = setThemeSource(theme as ThemeSource);
    shell.darkMode = isDarkMode();
    pushShellState();
    return shell.theme;
  });

  ipcMain.handle(IPC.themeCycle, () => {
    shell.theme = cycleThemeSource();
    shell.darkMode = isDarkMode();
    pushShellState();
    return shell.theme;
  });

  // ── 프로필 가져오기 ──
  ipcMain.handle(IPC.importDiscover, () =>
    discoverProfiles(process.env['HELM_PROFILE_ROOT'] ?? process.env['LOCALAPPDATA'] ?? '').map(
      (profile) => ({
        browser: profile.browser,
        name: profile.name,
        dir: profile.dir,
        available: profile.available
      })
    )
  );

  // ── AI 코브라우징 / Handoff ──
  ipcMain.handle(IPC.aiStateGet, () => aiState);

  ipcMain.handle(IPC.aiResume, () => {
    if (!handoff || aiState.threadId === '') return false;
    handoff.resume(aiState.threadId);
    return true;
  });

  ipcMain.handle(IPC.aiTakeOver, () => {
    if (!handoff || aiState.threadId === '') return false;
    handoff.takeOver(aiState.threadId);
    return true;
  });

  ipcMain.handle(IPC.aiOverlayToggle, (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean' || !overlay) return overlay?.isEnabled() ?? true;
    overlay.setEnabled(enabled);
    refreshAiState();
    return enabled;
  });

  // ── 사람에게 묻기 ──
  ipcMain.handle(IPC.promptAnswer, (_e, id: unknown, answer: unknown) => {
    if (typeof id !== 'string') return false;
    const pending = pendingPrompts.get(id);
    if (!pending) return false;

    pendingPrompts.delete(id);
    pending.resolve(typeof answer === 'string' ? answer : '');
    return true;
  });

  ipcMain.handle(IPC.importRun, (_e, dir: unknown) => {
    if (typeof dir !== 'string' || !history || !bookmarks || !autofill) return null;

    const profile = discoverProfiles(
      process.env['HELM_PROFILE_ROOT'] ?? process.env['LOCALAPPDATA'] ?? ''
    ).find((candidate) => path.resolve(candidate.dir) === path.resolve(dir));

    // 탐색으로 찾은 프로필만 가져온다 — 렌더러가 보낸 임의 경로를 열지 않는다.
    if (!profile) return null;

    const result = importProfile(profile, {
      history,
      bookmarks,
      saveAutofill: (rows) => autofill?.saveMany(rows) ?? 0
    });

    pushBookmarks();
    return result;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  void mcpServer?.stop();
  overlay?.dispose();
  handoff?.dispose();
  tabManager?.dispose();
  try {
    database?.close();
  } catch (error) {
    console.error('[will-quit] DB 닫기 실패', error);
  }
});

void app.whenReady().then(async () => {
  const helmSession = session.fromPartition(SESSION_PARTITION);

  // 권한 요청은 M1에서 전부 거부한다(최소 권한 원칙). 사이트별 허용 UI는 M3 정책 화면에서.
  helmSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // 모의 포털(app://portal-a|b|c)은 검증용이다. 패키징된 앱에는 붙이지 않는다.
  installAppProtocol(
    [session.defaultSession, helmSession],
    app.isPackaged ? {} : { portals: helmSession }
  );

  database = openDatabase(app.getPath('userData'));
  history = new History(database);
  bookmarks = new Bookmarks(database);
  autofill = new Autofill(database);
  searchConfig = loadSearchConfig(configDir());

  downloads = new Downloads({
    downloadDir: downloadDir(),
    onChange: (items) => sendToShell(IPC.downloadsChanged, items)
  });
  downloads.attach(helmSession);

  shell.theme = getThemeSource();
  shell.darkMode = isDarkMode();

  // ToolSurface 는 MCP 와 무관하게 항상 등록한다 — 내장 에이전트(M4)도 같은 레지스트리를 쓴다.
  registerAllTools();

  registerIpc();
  createWindow(helmSession);

  // 확장 로드는 창을 띄운 뒤에 한다 — 실패해도 브라우저는 떠야 한다(GOAL FIXED DECISIONS).
  const entries = loadExtensionConfig(configDir());
  if (entries.length > 0) {
    const results = await loadExtensions(helmSession, entries);
    shell.extensions = results.map(({ unsupportedPermissions: _unsupported, ...rest }) => rest);
    for (const result of results) {
      if (!result.ok) console.warn(`[extensions] 로드 실패 - ${result.name}: ${result.error}`);
    }
    pushShellState();
  }

  // MCP 서버는 AI 표면이 필요할 때만 켠다. 기본은 켜고, 껐으면 설정에서 다시 켠다(M3).
  if (process.env['HELM_MCP_DISABLED'] !== '1') {
    await startMcpServer();
  }

  if (isE2E) {
    // 스모크 테스트가 메인 프로세스 상태를 직접 확인할 수 있게 하는 훅.
    // HELM_E2E=1 일 때만 존재하고, 웹 콘텐츠에는 노출되지 않는다.
    (globalThis as Record<string, unknown>)['__helm'] = {
      getTabManager: () => tabManager,
      getWindow: () => mainWindow,
      getShell: () => shellView,
      getShellState: () => shell,
      getHistory: () => history,
      getBookmarks: () => bookmarks,
      getAutofill: () => autofill,
      getDownloads: () => downloads,
      getSession: () => helmSession,
      setPanel,
      applyInsets,
      loadExtensionsFrom: async (dirs: { name: string; path: string }[]) => {
        const results = await loadExtensions(helmSession, dirs);
        shell.extensions = results.map(({ unsupportedPermissions: _u, ...rest }) => rest);
        pushShellState();
        return results;
      },
      downloadDir: downloadDir(),
      sessionPartition: SESSION_PARTITION,
      layout: LAYOUT,
      // ── M2 도구 표면 ──
      getOverlay: () => overlay,
      overlayCapture: () => overlay?.capture() ?? Promise.resolve(null),
      overlayLastState: () => overlay?.lastState() ?? null,
      getHandoff: () => handoff,
      getAiState: () => aiState,
      getMcpEndpoint: () => mcpEndpoint,
      createToolContext,
      callTool: async (threadId: string, name: string, args: unknown) => {
        const { callTool: dispatch } = await import('./tools/index');
        return dispatch(createToolContext(threadId), name, args);
      },
      toolNames: async () => {
        const { toolNames } = await import('./tools/register');
        return toolNames();
      },
      pendingPrompts: () => [...pendingPrompts.values()].map((entry) => entry.prompt),
      answerPrompt: (id: string, answer: string) => {
        const pending = pendingPrompts.get(id);
        if (!pending) return false;
        pendingPrompts.delete(id);
        pending.resolve(answer);
        return true;
      }
    };
  }
});
