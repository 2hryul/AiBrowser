import { WebContentsView, type BaseWindow, type Session, type Rectangle } from 'electron';
import type { BrowserState, TabState, TabOwner } from '../../shared/types';
import { HOME_URL, LAYOUT } from '../../shared/types';
import { normalizeAddress } from './Omnibox';

interface Tab {
  id: number;
  view: WebContentsView;
  owner: TabOwner;
  sessionName: string;
}

export interface TabManagerOptions {
  window: BaseWindow;
  /** 탭 웹 콘텐츠가 쓰는 영구 세션(persist:helm). */
  session: Session;
  sessionName: string;
  /** 상태가 바뀔 때마다 셸에 푸시하기 위한 콜백. */
  onStateChange: (state: BrowserState) => void;
  /** 새 탭 웹 콘텐츠에 단축키 등 공통 설정을 붙이는 훅. */
  onTabWebContents?: (wc: Electron.WebContents) => void;
}

/**
 * BaseWindow 의 contentView 위에 탭별 WebContentsView 를 얹어 관리한다.
 * 활성 탭만 보이게 하고(setVisible), 나머지는 살아 있는 상태로 숨긴다.
 */
export class TabManager {
  private readonly tabs: Tab[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private readonly opts: TabManagerOptions;

  constructor(opts: TabManagerOptions) {
    this.opts = opts;
  }

  /** 웹 콘텐츠가 차지하는 사각형. 사이드바(세로 탭바)와 툴바를 제외한 영역. */
  private contentBounds(): Rectangle {
    const { width, height } = this.opts.window.getContentBounds();
    return {
      x: LAYOUT.sidebarWidth,
      y: LAYOUT.toolbarHeight,
      width: Math.max(0, width - LAYOUT.sidebarWidth),
      height: Math.max(0, height - LAYOUT.toolbarHeight)
    };
  }

  /** 윈도우 리사이즈 때 활성 탭 크기를 다시 맞춘다. */
  relayout(): void {
    const bounds = this.contentBounds();
    for (const tab of this.tabs) {
      tab.view.setBounds(bounds);
    }
  }

  createTab(rawUrl?: string, owner: TabOwner = 'human'): number {
    const id = this.nextId++;
    const view = new WebContentsView({
      webPreferences: {
        session: this.opts.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
        // 웹 콘텐츠 뷰에는 preload 를 붙이지 않는다(CLAUDE.md 보안 기본값).
      }
    });

    const tab: Tab = { id, view, owner, sessionName: this.opts.sessionName };
    this.tabs.push(tab);

    this.opts.window.contentView.addChildView(view);
    view.setBounds(this.contentBounds());
    view.setVisible(false);

    this.wireTabEvents(tab);

    const target = rawUrl ? normalizeAddress(rawUrl) ?? HOME_URL : HOME_URL;
    void view.webContents.loadURL(target);

    this.selectTab(id);
    return id;
  }

  private wireTabEvents(tab: Tab): void {
    const wc = tab.view.webContents;
    const push = (): void => this.emitState();

    wc.on('page-title-updated', push);
    wc.on('did-start-loading', push);
    wc.on('did-stop-loading', push);
    wc.on('did-navigate', push);
    wc.on('did-navigate-in-page', push);
    wc.on('did-fail-load', (_e, code, desc, url) => {
      // -3(ERR_ABORTED)은 사용자가 로딩을 중단한 정상 흐름이라 로그로 남기지 않는다.
      if (code !== -3) {
        console.warn(`[TabManager] 페이지 로드 실패 - 탭 ${tab.id}, 코드 ${code}, ${desc}, url: ${url}`);
      }
      push();
    });

    this.opts.onTabWebContents?.(wc);

    // target=_blank 등 새 창 요청은 창을 띄우지 않고 새 탭으로 받는다.
    wc.setWindowOpenHandler(({ url }) => {
      const normalized = normalizeAddress(url);
      if (normalized) this.createTab(normalized, tab.owner);
      return { action: 'deny' };
    });
  }

  closeTab(id: number): void {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    const tab = this.tabs[index];
    if (!tab) return;
    this.tabs.splice(index, 1);

    this.opts.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close();
    }

    if (this.activeId === id) {
      // 닫힌 탭의 오른쪽 탭, 없으면 왼쪽 탭으로 활성 탭을 넘긴다(크롬 동작).
      const next = this.tabs[index] ?? this.tabs[index - 1];
      this.activeId = null;
      if (next) {
        this.selectTab(next.id);
        return;
      }
    }
    this.emitState();
  }

  selectTab(id: number): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;

    this.activeId = id;
    for (const t of this.tabs) {
      t.view.setVisible(t.id === id);
    }
    tab.view.setBounds(this.contentBounds());
    this.emitState();
  }

  /** 주소창 입력을 정규화해 이동한다. 정규화 실패 시 false 를 돌려 셸이 안내한다. */
  navigate(id: number, rawInput: string): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return false;

    const target = normalizeAddress(rawInput);
    if (!target) return false;

    void tab.view.webContents.loadURL(target);
    return true;
  }

  goBack(id: number): void {
    const wc = this.tabs.find((t) => t.id === id)?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  goForward(id: number): void {
    const wc = this.tabs.find((t) => t.id === id)?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(id: number): void {
    this.tabs.find((t) => t.id === id)?.view.webContents.reload();
  }

  getState(): BrowserState {
    const tabs: TabState[] = this.tabs.map((tab) => {
      const wc = tab.view.webContents;
      return {
        id: tab.id,
        title: wc.getTitle() || '새 탭',
        url: wc.getURL(),
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        owner: tab.owner,
        sessionName: tab.sessionName
      };
    });
    return { tabs, activeTabId: this.activeId };
  }

  get activeTabId(): number | null {
    return this.activeId;
  }

  /** 스모크 테스트가 활성 탭 화면을 캡처할 때 사용한다. */
  getWebContents(id: number): Electron.WebContents | null {
    return this.tabs.find((t) => t.id === id)?.view.webContents ?? null;
  }

  /** 탭 뷰가 실제로 놓인 사각형. 레이아웃이 셸과 어긋나지 않는지 검증하는 데 쓴다. */
  getTabBounds(id: number): Rectangle | null {
    return this.tabs.find((t) => t.id === id)?.view.getBounds() ?? null;
  }

  /** 웹 콘텐츠가 차지해야 하는 기대 사각형(외부 검증용). */
  expectedContentBounds(): Rectangle {
    return this.contentBounds();
  }

  private emitState(): void {
    this.opts.onStateChange(this.getState());
  }
}
