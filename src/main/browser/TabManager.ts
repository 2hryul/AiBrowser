import { WebContentsView, type BaseWindow, type Session, type Rectangle } from 'electron';
import type { BrowserState, TabState, TabOwner, TabStripOrientation } from '../../shared/types';
import { HOME_URL, IDLE_UNLOAD_MS } from '../../shared/types';
import { normalizeAddress } from './Omnibox';

/** 웹 콘텐츠 영역을 둘러싼 셸 크롬의 두께. 무엇이 차지하는지는 셸이 정하고 여기는 값만 받는다. */
export interface ContentInsets {
  top: number;
  left: number;
}

interface Tab {
  id: number;
  /** 유휴 언로드된 탭은 view 가 없다. */
  view: WebContentsView | null;
  owner: TabOwner;
  sessionName: string;
  pinned: boolean;
  /** 언로드 상태에서도 탭바에 보여줄 값 */
  lastUrl: string;
  lastTitle: string;
  /** 마지막으로 활성 탭이었던 시각 — 유휴 언로드 판단 기준 */
  lastActiveAt: number;
  readerable: boolean;
  zoomFactor: number;
}

/** 닫은 탭 복구용 스냅샷 */
interface ClosedTab {
  url: string;
  title: string;
  pinned: boolean;
  index: number;
}

export interface TabManagerOptions {
  window: BaseWindow;
  /** 탭 웹 콘텐츠가 쓰는 영구 세션(persist:helm). */
  session: Session;
  sessionName: string;
  onStateChange: (state: BrowserState) => void;
  /** 새 탭 웹 콘텐츠에 단축키 등 공통 설정을 붙이는 훅. */
  onTabWebContents?: (wc: Electron.WebContents) => void;
  /** 방문 기록 적재. 히스토리 저장소를 직접 참조하지 않게 콜백으로 받는다. */
  onVisit?: (url: string, title: string) => void;
  onTitleUpdated?: (url: string, title: string) => void;
  /** 유휴 언로드 임계 시간. 테스트가 짧게 줄인다. */
  idleUnloadMs?: number;
}

/** 복구 스택 상한. 크롬과 비슷한 수준으로 둔다. */
const CLOSED_STACK_LIMIT = 25;

/**
 * BaseWindow 의 contentView 위에 탭별 WebContentsView 를 얹어 관리한다.
 * 활성 탭만 보이게 하고(setVisible), 나머지는 살아 있는 상태로 숨긴다.
 * 30분 이상 방치된 비활성 탭은 메모리를 돌려주기 위해 언로드하고, 다시 선택하면 복구한다.
 */
export class TabManager {
  private readonly tabs: Tab[] = [];
  private readonly closed: ClosedTab[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private orientation: TabStripOrientation = 'vertical';
  private insets: ContentInsets = { top: 0, left: 0 };
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly opts: TabManagerOptions;

  constructor(opts: TabManagerOptions) {
    this.opts = opts;
  }

  private get idleUnloadMs(): number {
    return this.opts.idleUnloadMs ?? IDLE_UNLOAD_MS;
  }

  /** 셸이 알려준 크롬 두께를 반영한다. */
  setInsets(insets: ContentInsets): void {
    this.insets = insets;
    this.relayout();
  }

  /** 웹 콘텐츠가 차지하는 사각형. */
  private contentBounds(): Rectangle {
    const { width, height } = this.opts.window.getContentBounds();
    return {
      x: this.insets.left,
      y: this.insets.top,
      width: Math.max(0, width - this.insets.left),
      height: Math.max(0, height - this.insets.top)
    };
  }

  expectedContentBounds(): Rectangle {
    return this.contentBounds();
  }

  relayout(): void {
    const bounds = this.contentBounds();
    for (const tab of this.tabs) {
      tab.view?.setBounds(bounds);
    }
  }

  getOrientation(): TabStripOrientation {
    return this.orientation;
  }

  setOrientation(orientation: TabStripOrientation): void {
    if (this.orientation === orientation) return;
    this.orientation = orientation;
    this.emitState();
  }

  createTab(rawUrl?: string, owner: TabOwner = 'human'): number {
    const id = this.nextId++;
    const target = rawUrl ? normalizeAddress(rawUrl) ?? HOME_URL : HOME_URL;

    const tab: Tab = {
      id,
      view: null,
      owner,
      sessionName: this.opts.sessionName,
      pinned: false,
      lastUrl: target,
      lastTitle: '새 탭',
      lastActiveAt: Date.now(),
      readerable: false,
      zoomFactor: 1
    };
    this.tabs.push(tab);

    this.attachView(tab, target);
    this.selectTab(id);
    this.ensureIdleTimer();
    return id;
  }

  /** 탭에 실제 WebContentsView 를 붙이고 주어진 주소를 띄운다. 복구에도 같은 경로를 쓴다. */
  private attachView(tab: Tab, url: string): void {
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

    tab.view = view;
    this.opts.window.contentView.addChildView(view);
    view.setBounds(this.contentBounds());
    view.setVisible(this.activeId === tab.id);

    this.wireTabEvents(tab, view);
    void view.webContents.loadURL(url);
  }

  private wireTabEvents(tab: Tab, view: WebContentsView): void {
    const wc = view.webContents;
    const push = (): void => this.emitState();

    wc.on('page-title-updated', (_event, title) => {
      tab.lastTitle = title;
      this.opts.onTitleUpdated?.(wc.getURL(), title);
      push();
    });

    wc.on('did-start-loading', push);
    wc.on('did-stop-loading', push);

    wc.on('did-navigate', (_event, url) => {
      tab.lastUrl = url;
      tab.readerable = false;
      this.opts.onVisit?.(url, wc.getTitle());
      push();
    });

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.lastUrl = url;
      push();
    });

    wc.on('did-finish-load', () => {
      void this.refreshReaderable(tab);
    });

    wc.on('audio-state-changed', push);

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

  /**
   * 읽기 모드 버튼 활성화 여부를 페이지 안에서 값싸게 가늠한다.
   * 본문 HTML 전체를 메인으로 끌어오는 건 비싸므로, 본문 텍스트 길이만 재고
   * 실제 추출 판정은 사용자가 읽기 모드를 눌렀을 때 Reader 가 한다.
   */
  private async refreshReaderable(tab: Tab): Promise<void> {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return;

    try {
      const length = (await wc.executeJavaScript(
        '(document.body && document.body.innerText ? document.body.innerText.length : 0)'
      )) as number;
      const next = typeof length === 'number' && length > 500;
      if (next !== tab.readerable) {
        tab.readerable = next;
        this.emitState();
      }
    } catch {
      // 페이지가 곧바로 이동하면 실행이 취소된다. 판정 실패는 버튼 비활성으로 충분하다.
    }
  }

  closeTab(id: number): void {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    const tab = this.tabs[index];
    if (!tab) return;

    // 고정 탭은 닫기 버튼이 없다. IPC 로 직접 들어온 요청도 여기서 막는다.
    if (tab.pinned) return;

    this.closed.push({ url: tab.lastUrl, title: tab.lastTitle, pinned: tab.pinned, index });
    if (this.closed.length > CLOSED_STACK_LIMIT) this.closed.shift();

    this.tabs.splice(index, 1);
    this.destroyView(tab);

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

  private destroyView(tab: Tab): void {
    const view = tab.view;
    if (!view) return;
    tab.view = null;
    this.opts.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  /** Ctrl+Shift+T — 가장 최근에 닫은 탭을 원래 자리로 되살린다. */
  restoreClosedTab(): number | null {
    const snapshot = this.closed.pop();
    if (!snapshot) return null;

    const id = this.createTab(snapshot.url);
    const restored = this.tabs.find((t) => t.id === id);
    if (restored) {
      restored.pinned = snapshot.pinned;
      restored.lastTitle = snapshot.title;
      this.moveTab(id, Math.min(snapshot.index, this.tabs.length - 1));
    }
    this.emitState();
    return id;
  }

  canRestoreClosedTab(): boolean {
    return this.closed.length > 0;
  }

  selectTab(id: number): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;

    this.activeId = id;
    tab.lastActiveAt = Date.now();

    // 언로드된 탭을 다시 고르면 그 자리에서 복구한다.
    if (!tab.view) this.attachView(tab, tab.lastUrl);

    for (const other of this.tabs) {
      other.view?.setVisible(other.id === id);
    }
    tab.view?.setBounds(this.contentBounds());
    this.emitState();
  }

  /** 드래그 정렬. 고정 탭은 항상 앞쪽 구간에 머문다. */
  moveTab(id: number, toIndex: number): boolean {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from === -1) return false;

    const tab = this.tabs[from];
    if (!tab) return false;

    const pinnedCount = this.tabs.filter((t) => t.pinned).length;
    // 고정 탭은 [0, pinnedCount) 구간, 일반 탭은 [pinnedCount, length) 구간 안에서만 움직인다.
    const lower = tab.pinned ? 0 : pinnedCount;
    const upper = tab.pinned ? pinnedCount - 1 : this.tabs.length - 1;
    const target = Math.max(lower, Math.min(upper, toIndex));
    if (target === from) return true;

    this.tabs.splice(from, 1);
    this.tabs.splice(target, 0, tab);
    this.emitState();
    return true;
  }

  /** 고정 토글. 고정하면 고정 구간의 끝으로, 해제하면 일반 구간의 앞으로 옮긴다. */
  setPinned(id: number, pinned: boolean): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.pinned === pinned) return false;

    tab.pinned = pinned;
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);

    const pinnedCount = this.tabs.filter((t) => t.pinned).length;
    this.tabs.splice(pinnedCount, 0, tab);

    this.emitState();
    return true;
  }

  setMuted(id: number, muted: boolean): boolean {
    const wc = this.tabs.find((t) => t.id === id)?.view?.webContents;
    if (!wc) return false;
    wc.setAudioMuted(muted);
    this.emitState();
    return true;
  }

  /** 확대/축소. 0.25~5배 사이로 제한한다(크롬 범위). */
  setZoom(id: number, factor: number): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    const wc = tab?.view?.webContents;
    if (!tab || !wc) return false;

    const clamped = Math.max(0.25, Math.min(5, factor));
    wc.setZoomFactor(clamped);
    tab.zoomFactor = clamped;
    this.emitState();
    return true;
  }

  getZoom(id: number): number {
    return this.tabs.find((t) => t.id === id)?.zoomFactor ?? 1;
  }

  navigate(id: number, rawInput: string): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return false;

    const target = normalizeAddress(rawInput);
    if (!target) return false;

    if (!tab.view) this.attachView(tab, target);
    else void tab.view.webContents.loadURL(target);

    tab.lastUrl = target;
    return true;
  }

  goBack(id: number): void {
    const wc = this.webContentsOf(id);
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  goForward(id: number): void {
    const wc = this.webContentsOf(id);
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(id: number): void {
    this.webContentsOf(id)?.reload();
  }

  private webContentsOf(id: number): Electron.WebContents | null {
    const wc = this.tabs.find((t) => t.id === id)?.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  getWebContents(id: number): Electron.WebContents | null {
    return this.webContentsOf(id);
  }

  getTabBounds(id: number): Rectangle | null {
    return this.tabs.find((t) => t.id === id)?.view?.getBounds() ?? null;
  }

  getActiveWebContents(): Electron.WebContents | null {
    return this.activeId === null ? null : this.webContentsOf(this.activeId);
  }

  get activeTabId(): number | null {
    return this.activeId;
  }

  /** 유휴 언로드를 강제로 한 번 돌린다(테스트·수동 정리용). 언로드한 탭 수를 돌려준다. */
  unloadIdleTabs(now = Date.now()): number {
    let unloaded = 0;

    for (const tab of this.tabs) {
      if (tab.id === this.activeId || !tab.view || tab.pinned) continue;
      if (now - tab.lastActiveAt < this.idleUnloadMs) continue;

      // 언로드 전에 표시용 값을 확정해 둔다. 뷰가 사라지면 읽을 수 없다.
      tab.lastUrl = tab.view.webContents.getURL() || tab.lastUrl;
      tab.lastTitle = tab.view.webContents.getTitle() || tab.lastTitle;
      this.destroyView(tab);
      unloaded += 1;
    }

    if (unloaded > 0) this.emitState();
    return unloaded;
  }

  private ensureIdleTimer(): void {
    if (this.idleTimer) return;
    // 임계 시간의 1/10 주기로 점검한다(기본 3분). 타이머 하나로 전체 탭을 훑는다.
    const period = Math.max(1000, Math.floor(this.idleUnloadMs / 10));
    this.idleTimer = setInterval(() => this.unloadIdleTabs(), period);
    this.idleTimer.unref?.();
  }

  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const tab of [...this.tabs]) this.destroyView(tab);
    this.tabs.length = 0;
  }

  getState(): BrowserState {
    const tabs: TabState[] = this.tabs.map((tab) => {
      const wc = tab.view?.webContents;
      const alive = wc && !wc.isDestroyed() ? wc : null;

      return {
        id: tab.id,
        title: (alive?.getTitle() || tab.lastTitle) ?? '새 탭',
        url: alive?.getURL() || tab.lastUrl,
        loading: alive?.isLoading() ?? false,
        canGoBack: alive?.navigationHistory.canGoBack() ?? false,
        canGoForward: alive?.navigationHistory.canGoForward() ?? false,
        owner: tab.owner,
        sessionName: tab.sessionName,
        pinned: tab.pinned,
        muted: alive?.isAudioMuted() ?? false,
        audible: alive?.isCurrentlyAudible() ?? false,
        suspended: alive === null,
        readerable: tab.readerable,
        zoomFactor: tab.zoomFactor
      };
    });

    return {
      tabs,
      activeTabId: this.activeId,
      orientation: this.orientation,
      canRestoreClosedTab: this.canRestoreClosedTab()
    };
  }

  private emitState(): void {
    this.opts.onStateChange(this.getState());
  }
}
