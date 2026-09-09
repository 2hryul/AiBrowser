import path from 'node:path';
import { app, BaseWindow, WebContentsView, ipcMain, session, type Session } from 'electron';
import { installAppProtocol, registerAppScheme } from './browser/AppProtocol';
import { TabManager } from './browser/TabManager';
import { attachShortcuts } from './browser/Shortcuts';
import { IPC } from './ipc/channels';
import { LAYOUT, type BrowserState } from '../shared/types';

/** Named Session: M0은 기본 세션 하나만 쓴다. 파티션 이름은 재시작 후 세션 유지의 키다. */
const SESSION_NAME = 'default';
const SESSION_PARTITION = 'persist:helm';

// 스모크 테스트가 재시작 간 프로필을 재사용하려면 userData 경로가 고정되어야 한다.
// app.whenReady() 이전, 어떤 세션도 만들기 전에 설정해야 반영된다.
const userDataOverride = process.env['HELM_USER_DATA_DIR'];
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
}

const isE2E = process.env['HELM_E2E'] === '1';

// 단일 인스턴스: 두 번째 실행은 기존 창을 띄우고 종료한다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

registerAppScheme();

let mainWindow: BaseWindow | null = null;
let shellView: WebContentsView | null = null;
let tabManager: TabManager | null = null;

function pushState(state: BrowserState): void {
  if (shellView && !shellView.webContents.isDestroyed()) {
    shellView.webContents.send(IPC.stateChanged, state);
  }
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
  const shell = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  shellView = shell;

  window.contentView.addChildView(shell);

  const manager = new TabManager({
    window,
    session: helmSession,
    sessionName: SESSION_NAME,
    onStateChange: pushState,
    onTabWebContents: (wc) => attachShortcuts(wc, shortcutHandlers)
  });
  tabManager = manager;

  const shortcutHandlers = {
    newTab: () => manager.createTab(),
    closeTab: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.closeTab(id);
    },
    focusOmnibox: () => shell.webContents.send(IPC.focusOmnibox),
    reload: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.reload(id);
    },
    goBack: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.goBack(id);
    },
    goForward: () => {
      const id = manager.activeTabId;
      if (id !== null) manager.goForward(id);
    }
  };
  attachShortcuts(shell.webContents, shortcutHandlers);

  /** 셸은 창 콘텐츠 전체를, 탭은 그 안쪽 사각형을 채운다. 두 곳에서 같은 값을 쓴다. */
  const syncLayout = (): void => {
    const { width, height } = window.getContentBounds();
    shell.setBounds({ x: 0, y: 0, width, height });
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
    tabManager = null;
  });

  const entry = shellEntry();
  const loaded = entry.url
    ? shell.webContents.loadURL(entry.url)
    : shell.webContents.loadFile(entry.file as string);

  void loaded
    .then(() => {
      window.show();
      settleLayout();
      manager.createTab();
    })
    .catch((error: unknown) => {
      console.error('[createWindow] 셸 로드 실패 - 진입점:', entry, error);
    });
}

function registerIpc(): void {
  const requireManager = (): TabManager => {
    if (!tabManager) throw new Error('[ipc] 탭 매니저 없음 - 윈도우가 아직 만들어지지 않았습니다');
    return tabManager;
  };

  /** 렌더러가 보낸 탭 id 검증: 숫자가 아니면 즉시 종료(early return 대상). */
  const asTabId = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

  ipcMain.handle(IPC.stateGet, () => requireManager().getState());

  ipcMain.handle(IPC.tabsCreate, (_e, url: unknown) => {
    const raw = typeof url === 'string' ? url : undefined;
    return requireManager().createTab(raw);
  });

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

void app.whenReady().then(() => {
  const helmSession = session.fromPartition(SESSION_PARTITION);

  // 권한 요청은 M0에서 전부 거부한다(최소 권한 원칙). 사이트별 허용 UI는 M1 이후.
  helmSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  installAppProtocol([session.defaultSession, helmSession]);
  registerIpc();
  createWindow(helmSession);

  if (isE2E) {
    // 스모크 테스트가 메인 프로세스에서 탭을 조작할 수 있게 하는 훅.
    // HELM_E2E=1 일 때만 존재하고, 웹 콘텐츠에는 노출되지 않는다.
    (globalThis as Record<string, unknown>)['__helm'] = {
      getTabManager: () => tabManager,
      getWindow: () => mainWindow,
      getShell: () => shellView,
      sessionPartition: SESSION_PARTITION,
      layout: LAYOUT
    };
  }
});
