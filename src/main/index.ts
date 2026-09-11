import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BaseWindow,
  WebContentsView,
  dialog,
  ipcMain,
  safeStorage,
  session,
  type Session
} from 'electron';
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
import { Policy, PolicyLoadError } from './control/Policy';
import { Approval, type ApprovalRequest } from './control/Approval';
import { UndoManager } from './persistence/UndoManager';
import { SessionStore, DEFAULT_SESSION } from './sessions/SessionStore';
import { ThreadStore } from './persistence/ThreadStore';
import { CheckpointStore, type Checkpoint } from './persistence/CheckpointStore';
import { Inbox } from './persistence/Inbox';
import { Scheduler } from './scheduler/Scheduler';
import { checkDraft, promoteThread } from './workflow/Promote';
import { WorkflowRunner, type WorkflowRunOutcome } from './workflow/Runner';
import { NoteStore } from './persistence/NoteStore';
import { BookmarkMeta } from './persistence/BookmarkMeta';
import { ChangeTracker } from './persistence/ChangeTracker';
import { AuditLog } from './audit/AuditLog';
import { startConsoleCapture } from './tools/read_console_messages';
import { registerAllTools } from './tools/register';
import { captureMasked } from './tools/computer';
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
import type { ShellState, WorkflowRunView } from '../shared/api';

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
let policy: Policy | null = null;
let approval: Approval | null = null;
let undoManager: UndoManager | null = null;
let auditLog: AuditLog | null = null;
let sessionStore: SessionStore | null = null;
let threadStore: ThreadStore | null = null;
let checkpointStore: CheckpointStore | null = null;
let inbox: Inbox | null = null;
let workflowRunner: WorkflowRunner | null = null;
let scheduler: Scheduler | null = null;
let noteStore: NoteStore | null = null;
let bookmarkMeta: BookmarkMeta | null = null;
let changeTracker: ChangeTracker | null = null;

/**
 * 실행 단위. M4 에서 threadId 로 승격된다.
 * 앱 기동마다 하나를 만들고, MCP 연결은 자기 threadId 를 runId 로 쓴다.
 */
const APP_RUN_ID = `run-${Date.now().toString(36)}`;

/** 사람에게 물어 둔 것들. ask_user / request_access 가 여기서 답을 기다린다. */
const pendingPrompts = new Map<string, { prompt: PendingPrompt; resolve: (answer: string) => void }>();

/** 승인 대기 큐. 헤드리스·MCP 실행에서도 여기 쌓이고 사람이 사이드바에서 처리한다. */
let approvalQueue: ApprovalRequest[] = [];

/**
 * 스레드별 최근 결과표. ResultsTable 이 그리고 체크포인트에 함께 저장된다.
 * DB 에 매 행마다 쓰지 않는 이유: 수집 중에는 초당 여러 번 바뀌고, 남아야 하는 시점은
 * 체크포인트뿐이다.
 */
const lastResults = new Map<string, unknown[]>();

/**
 * 스레드별 최근 진행 커서. 자동 체크포인트에도 실려야 한다 —
 * 자동 저장이 커서 없이 덮이면 "가장 최근 체크포인트에서 재개" 가 처음부터 다시 하기가 된다.
 */
const lastCursor = new Map<string, Record<string, unknown>>();

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

/**
 * 증거 팩이 쌓이는 곳의 부모. 실제 사용은 userData 아래지만, 골든셋 러너가
 * 저장소 안(`evidence/<runId>/`)에 남기고 검사할 수 있게 환경변수로 바꿀 수 있다.
 */
/**
 * 최근 워크플로우 실행 기록. 사이드바가 판정과 증거 팩 경로를 보여 주는 데 쓴다.
 * 디스크(증거 팩)가 진본이므로 메모리에는 최근 것만 둔다.
 */
const workflowRuns: WorkflowRunView[] = [];
const WORKFLOW_RUN_LIMIT = 50;

function recordWorkflowRun(outcome: WorkflowRunOutcome): WorkflowRunView {
  const view: WorkflowRunView = {
    runId: outcome.runId,
    workflowId: outcome.workflowId,
    workflowVersion: outcome.workflowVersion,
    inputs: outcome.inputs,
    verdict: outcome.verdict,
    status: outcome.status,
    sources: outcome.sources,
    oracles: outcome.oracles,
    evidencePath: outcome.evidence.dir,
    durationMs: outcome.durationMs,
    finishedAt: Date.now()
  };

  workflowRuns.unshift(view);
  if (workflowRuns.length > WORKFLOW_RUN_LIMIT) workflowRuns.length = WORKFLOW_RUN_LIMIT;

  sendToShell(IPC.workflowRunsChanged, workflowRuns);
  return view;
}

function evidenceBaseDir(): string {
  const override = process.env['HELM_EVIDENCE_DIR'];
  if (override) {
    const resolved = path.resolve(override);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  return app.getPath('userData');
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

/**
 * 북마크된 주소를 방문하면 본문 스냅샷을 남긴다(ChangeTracker).
 *
 * 모든 방문을 남기지 않는 이유: 스냅샷은 "지난번과 비교" 를 위한 것이고, 비교하고 싶은 곳은
 * 사람이 북마크해 둔 페이지다. 전부 남기면 DB 가 방문 기록의 사본이 된다.
 */
async function snapshotIfBookmarked(url: string, title: string): Promise<void> {
  if (!changeTracker || !bookmarks) return;
  if (!bookmarks.list().some((bookmark) => bookmark.url === url)) return;

  const id = tabManager?.getState().tabs.find((tab) => tab.url === url)?.id;
  const wc = id === undefined ? null : tabManager?.getWebContents(id);
  if (!wc) return;

  try {
    const payload = await readTab(wc, id ?? 0);
    const text = payload.article?.textContent ?? '';
    if (text.trim() === '') return;

    const result = changeTracker.snapshot(url, title, text);
    if (result.created) {
      sendToShell(IPC.pageHistoryUrls, changeTracker.trackedUrls());
    }
  } catch (error) {
    console.warn(`[snapshotIfBookmarked] 스냅샷 실패 - url: ${url}`, error);
  }
}

/**
 * 결과표 내보내기 — CSV / Markdown / JSON.
 *
 * 사람이 결과를 다른 곳(엑셀·보고서)으로 옮기려면 파일이 필요하다. 다운로드 폴더에 쓰는
 * 이유는 그 폴더가 이미 사용자의 "가져갈 것들" 자리이고, 도구가 접근할 수 있는 유일한
 * 쓰기 경로이기 때문이다(upload 제한과 같은 규칙).
 */
function exportResults(
  threadId: string,
  format: 'csv' | 'md' | 'json'
): { filePath: string; rows: number; bytes: number } | null {
  const rows = lastResults.get(threadId) ?? [];

  const columns = [
    ...new Set(
      rows.flatMap((row) =>
        row !== null && typeof row === 'object' ? Object.keys(row as Record<string, unknown>) : []
      )
    )
  ];

  const cell = (row: unknown, column: string): string => {
    if (row === null || typeof row !== 'object') return '';
    const value = (row as Record<string, unknown>)[column];
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };

  const NEWLINE = '\n';
  const CRLF = '\r\n';

  let body: string;

  if (format === 'json') {
    body = JSON.stringify(rows, null, 2) + NEWLINE;
  } else if (format === 'csv') {
    // 쉼표·인용부호·줄바꿈이 들어간 값은 RFC 4180 대로 감싼다.
    const escape = (value: string): string =>
      /["\r\n,]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;

    const lines = [columns.map(escape).join(',')];
    for (const row of rows) lines.push(columns.map((column) => escape(cell(row, column))).join(','));
    body = lines.join(CRLF) + CRLF;
  } else {
    // 표 문법을 깨는 것은 파이프와 줄바꿈뿐이다.
    const escape = (value: string): string =>
      value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

    const lines = [
      `| ${columns.map(escape).join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`
    ];
    for (const row of rows) {
      lines.push(`| ${columns.map((column) => escape(cell(row, column))).join(' | ')} |`);
    }
    body = lines.join(NEWLINE) + NEWLINE;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(downloadDir(), `results-${threadId}-${stamp}.${format}`);

  try {
    fs.writeFileSync(filePath, body, 'utf-8');
  } catch (error) {
    console.error(`[exportResults] 저장 실패 - 경로: ${filePath}`, error);
    return null;
  }

  return { filePath, rows: rows.length, bytes: Buffer.byteLength(body, 'utf-8') };
}

/** 받은편지함이 바뀌면 셸의 배지·목록이 따라간다. */
function pushInbox(): void {
  if (!inbox) return;
  sendToShell(IPC.inboxChanged, { unread: inbox.unreadCount(), items: inbox.list({ limit: 100 }) });
}

function pushThreads(): void {
  if (!threadStore) return;
  sendToShell(IPC.threadsChanged, threadStore.list(50));
}

/**
 * 이 threadId 의 스레드 행을 보장한다.
 *
 * MCP 클라이언트는 연결마다 threadId 를 들고 오는데, 그 자체로는 DB 에 아무것도 없다.
 * 스레드가 없으면 체크포인트·메시지를 매달 곳이 없으므로 첫 도구 호출에서 만든다.
 */
function ensureThread(threadId: string, title = ''): void {
  if (!threadStore) return;
  if (threadStore.get(threadId)) return;

  threadStore.create({
    id: threadId,
    title: title || threadId,
    sessionName: sessionStore?.currentName() ?? DEFAULT_SESSION
  });
  pushThreads();
}

/** AI 소유 탭의 현재 상태(주소·세션·스크롤)를 모은다. 체크포인트의 핵심 내용이다. */
async function collectAiTabs(): Promise<
  { url: string; sessionName: string; scrollY: number; tabId: number; title: string }[]
> {
  if (!tabManager) return [];

  const collected: {
    url: string;
    sessionName: string;
    scrollY: number;
    tabId: number;
    title: string;
  }[] = [];

  for (const tab of tabManager.getState().tabs) {
    if (tab.owner !== 'ai') continue;

    const wc = tabManager.getWebContents(tab.id);
    let scrollY = 0;
    if (wc) {
      try {
        // 로딩 중인 페이지에서는 executeJavaScript 가 응답하지 않을 수 있다.
        // 체크포인트가 그 때문에 멈추면 안 되므로 시간 제한을 둔다(400페이지 순회에서 실측).
        scrollY = await Promise.race([
          wc.executeJavaScript('window.scrollY') as Promise<number>,
          new Promise<number>((resolve) => {
            setTimeout(() => resolve(0), 300).unref?.();
          })
        ]);
      } catch {
        scrollY = 0;
      }
    }

    collected.push({
      url: tab.url,
      sessionName: tab.sessionName,
      scrollY: typeof scrollY === 'number' ? scrollY : 0,
      tabId: tab.id,
      title: tab.title
    });
  }

  return collected;
}

/** 체크포인트 저장. 자동 트리거와 `checkpoint_save` 도구가 같은 경로를 쓴다. */
async function saveCheckpointFor(
  threadId: string,
  input: {
    name: string;
    trigger: Checkpoint['trigger'];
    note?: string;
    cursor?: Record<string, unknown>;
    results?: unknown[];
  }
): Promise<Checkpoint> {
  if (!checkpointStore || !threadStore) {
    throw new Error('[saveCheckpoint] 저장소가 준비되지 않았습니다');
  }

  ensureThread(threadId);

  const saved = checkpointStore.save({
    threadId,
    name: input.name,
    trigger: input.trigger,
    ...(input.note === undefined ? {} : { note: input.note }),
    messageIndex: threadStore.messageCount(threadId),
    payload: {
      tabs: await collectAiTabs(),
      results: input.results ?? lastResults.get(threadId) ?? [],
      noteVersions: (noteStore?.scopes() ?? []).map((scope) => ({
        scope,
        version: noteStore?.latestVersion(scope) ?? 0
      })),
      cursor: input.cursor ?? lastCursor.get(threadId) ?? {}
    }
  });

  if (input.results) lastResults.set(threadId, input.results);
  if (input.cursor) lastCursor.set(threadId, input.cursor);
  sendToShell(IPC.checkpointsChanged, { threadId, checkpoints: checkpointStore.list(threadId) });
  return saved;
}

/**
 * 체크포인트로 되돌린다. 저장돼 있던 AI 탭을 다시 열고 스크롤을 맞춘다.
 * 지금 열려 있는 AI 탭은 닫는다 — 두 상태가 섞이면 "복원됐다" 고 말할 수 없다.
 */
async function restoreCheckpointFor(
  id: number
): Promise<{ tabs: { tabId: number; url: string; sessionName: string }[] }> {
  if (!checkpointStore || !tabManager) return { tabs: [] };

  const target = checkpointStore.get(id);
  if (!target) return { tabs: [] };

  const manager = tabManager;

  for (const tab of manager.getState().tabs) {
    if (tab.owner === 'ai') manager.closeTab(tab.id);
  }

  const opened: { tabId: number; url: string; sessionName: string }[] = [];

  for (const saved of target.payload.tabs) {
    const tabId = manager.createTab(saved.url, 'ai', saved.sessionName);
    const wc = manager.getWebContents(tabId);
    if (wc) handoff?.claimTab(tabId, target.threadId, wc);
    opened.push({ tabId, url: saved.url, sessionName: saved.sessionName });

    if (saved.scrollY > 0) {
      {
        // 로드가 끝난 뒤에 스크롤해야 위치가 남는다.
        wc?.once('did-finish-load', () => {
          void wc.executeJavaScript(`window.scrollTo(0, ${saved.scrollY})`).catch(() => undefined);
        });
      }
    }
  }

  lastResults.set(target.threadId, target.payload.results);
  lastCursor.set(target.threadId, target.payload.cursor);
  refreshAiState();
  return { tabs: opened };
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
    /**
     * 이름 있는 세션의 파티션을 돌려준다. 한 창에서 여러 계정을 쓰는 유일한 경로다.
     * 세션 행이 없으면(이름이 규칙에 안 맞으면) null 을 돌려 기본 세션으로 떨어진다.
     */
    resolveSession: (name) => {
      const info = sessionStore?.ensure(name);
      return info ? session.fromPartition(info.partition) : null;
    },
    onVisit: (url, title) => {
      history?.add(url, title);
      void snapshotIfBookmarked(url, title);
    },
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
    openUndoPanel: () => setPanel(shell.panel === 'undo' ? 'none' : 'undo'),
    openStepLog: () => setPanel(shell.panel === 'audit' ? 'none' : 'audit'),
    openPolicy: () => setPanel(shell.panel === 'policy' ? 'none' : 'policy'),
    openThreads: () => setPanel(shell.panel === 'threads' ? 'none' : 'threads'),
    openInbox: () => setPanel(shell.panel === 'inbox' ? 'none' : 'inbox'),
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
function createToolContext(threadId: string, source = 'mcp'): ToolContext {
  if (
    !tabManager ||
    !overlay ||
    !handoff ||
    !downloads ||
    !policy ||
    !approval ||
    !undoManager ||
    !auditLog ||
    !sessionStore ||
    !threadStore ||
    !checkpointStore ||
    !inbox ||
    !noteStore ||
    !bookmarkMeta ||
    !changeTracker
  ) {
    throw new Error('[tools] 브라우저가 아직 준비되지 않았습니다');
  }

  const manager = tabManager;
  ensureThread(threadId);

  return {
    tabs: manager,
    session: session.fromPartition(SESSION_PARTITION),
    downloads,
    overlay,
    handoff,
    policy,
    approval,
    undo: undoManager,
    audit: auditLog,
    threadId,
    runId: threadId,
    source,
    /**
     * 조작 직후 화면을 남긴다. computer 도구의 캡처 경로를 그대로 써서
     * 마스킹이 한 곳에서만 이뤄지게 한다(로그용 스크린샷에도 개인정보가 없어야 한다).
     */
    captureStep: async (tabId) => {
      const id = tabId ?? manager.activeTabId;
      if (id === null) return null;

      const wc = manager.getWebContents(id);
      if (!wc) return null;

      try {
        // 도구 호출을 한 번 더 거치지 않는다 — Policy 훅에 걸려 승인을 기다리다 교착된다.
        const shot = await captureMasked(wc, { scale: 0.5 });
        return auditLog?.saveScreenshot(shot.image) ?? null;
      } catch (error) {
        console.warn('[captureStep] 스크린샷 실패', error);
        return null;
      }
    },
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
    askUser: async (question, options) => {
      // ask_user 직전은 자동 체크포인트 지점이다(CLAUDE.md) — 사람을 기다리는 사이 앱이
      // 닫혀도 여기서 이어갈 수 있어야 한다.
      await saveCheckpointFor(threadId, {
        name: 'ask_user 직전',
        trigger: 'ask_user',
        note: question.slice(0, 200)
      }).catch((error) => {
        console.warn('[askUser] 체크포인트 저장 실패', error);
        return null;
      });

      return { answer: await askHuman({ kind: 'ask_user', question, options }) };
    },

    // ── M4a 지속성 계층 ──
    sessions: sessionStore,
    threads: threadStore,
    checkpoints: checkpointStore,
    inbox,
    notes: noteStore,
    bookmarkMeta,
    changes: changeTracker,
    saveCheckpoint: (input) => saveCheckpointFor(threadId, input),
    restoreCheckpoint: (id) => restoreCheckpointFor(id)
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
    const allowed: ShellPanel[] = [
      'none',
      'history',
      'downloads',
      'bookmarks',
      'reader',
      'undo',
      'audit',
      'policy',
      'threads',
      'inbox',
      'notes',
      'results',
      'sessions',
      'changes',
      'workflows'
    ];
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

  // ── 승인 (Policy / Approval) ──
  ipcMain.handle(IPC.approvalQueueGet, () => approvalQueue);

  ipcMain.handle(IPC.approvalAnswer, (_e, id: unknown, scope: unknown) => {
    if (typeof id !== 'string' || !approval) return false;

    // scope 가 유효한 범위면 승인, 아니면 거부다. 잘못된 값이 승인으로 새지 않게 한다.
    const allowed = ['once', 'thread', 'domain'];
    if (typeof scope === 'string' && allowed.includes(scope)) {
      return approval.answer(id, { granted: true, scope: scope as 'once' | 'thread' | 'domain' });
    }
    return approval.answer(id, { granted: false, reason: 'denied' });
  });

  // ── 정책 설정 화면 ──
  ipcMain.handle(IPC.policyGet, () => {
    if (!policy) return null;
    return { ...policy.snapshot(), locked: policy.isLocked() };
  });

  ipcMain.handle(IPC.policyRevokeGrant, (_e, index: unknown) => {
    if (typeof index !== 'number' || !policy) return false;
    return policy.revokeGrant(index);
  });

  ipcMain.handle(IPC.policySetDeny, (_e, hosts: unknown, tools: unknown) => {
    if (!policy) return false;
    const asStrings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return policy.setDeny(asStrings(hosts), asStrings(tools));
  });

  ipcMain.handle(IPC.policySetSite, (_e, host: unknown, decision: unknown) => {
    if (typeof host !== 'string' || !policy) return false;
    const allowed = ['allow', 'ask', 'deny'];
    if (typeof decision !== 'string' || !allowed.includes(decision)) return false;
    return policy.setSiteDecision(host, decision as 'allow' | 'ask' | 'deny');
  });

  // ── 되돌리기 ──
  ipcMain.handle(IPC.undoGet, () => {
    // 셸이 처음 열릴 때는 가장 최근에 움직인 스택을 보여준다 — MCP 클라이언트가 만든
    // 항목도 사람이 같은 목록에서 되돌릴 수 있어야 한다.
    const runId = undoManager?.activeRunId() ?? APP_RUN_ID;
    return { runId, records: undoManager?.list(runId) ?? [] };
  });

  ipcMain.handle(IPC.undoApply, async (_e, runId: unknown, id: unknown) => {
    if (!undoManager) return { ok: false, reason: 'failed', message: '되돌리기 준비 안 됨' };
    const targetRun = typeof runId === 'string' && runId !== '' ? runId : APP_RUN_ID;
    return undoManager.undo(targetRun, typeof id === 'string' ? id : undefined);
  });

  // ── 감사 로그 재생 ──
  ipcMain.handle(IPC.auditRead, () => ({
    runId: APP_RUN_ID,
    file: auditLog?.file ?? null,
    entries: auditLog?.read() ?? []
  }));

  ipcMain.handle(IPC.auditOpenUrl, (_e, url: unknown) => {
    if (typeof url !== 'string' || url.trim() === '' || !tabManager) return null;
    // 재생 화면의 "그 URL 새 탭으로 열기" — 사람이 여는 탭이므로 owner 는 human 이다.
    return tabManager.createTab(url);
  });

  // ── M4a 지속성: 스레드 ──
  ipcMain.handle(IPC.threadsGet, () => threadStore?.list(50) ?? []);

  ipcMain.handle(IPC.threadCreate, (_e, title: unknown) => {
    if (!threadStore) return null;
    const thread = threadStore.create({
      title: typeof title === 'string' && title.trim() !== '' ? title : '새 작업',
      sessionName: sessionStore?.currentName() ?? DEFAULT_SESSION
    });
    pushThreads();
    return thread;
  });

  ipcMain.handle(IPC.threadMessages, (_e, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadStore) return [];
    return threadStore.messages(threadId);
  });

  /** 사이드바에서 사람이 한 마디 보탠다. 앱을 다시 켠 뒤에도 같은 스레드에 이어진다. */
  ipcMain.handle(IPC.threadSay, (_e, threadId: unknown, text: unknown) => {
    if (typeof threadId !== 'string' || typeof text !== 'string' || !threadStore) return null;
    if (text.trim() === '') return null;
    if (!threadStore.get(threadId)) return null;

    const message = threadStore.append(threadId, { role: 'human', text });
    pushThreads();
    return message;
  });

  /**
   * "이어서" — 마지막 체크포인트로 돌아가 상태를 running 으로 되돌린다.
   * 내장 에이전트는 M4b 라, 지금은 재개 지점(커서)을 돌려주는 것까지가 이 핸들러의 일이다.
   */
  ipcMain.handle(IPC.threadResume, async (_e, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadStore || !checkpointStore) return null;

    const checkpoint = checkpointStore.latest(threadId);
    const restored = checkpoint ? await restoreCheckpointFor(checkpoint.id) : { tabs: [] };

    threadStore.setStatus(threadId, 'running');
    threadStore.append(threadId, { role: 'system', text: '사람이 이어서를 눌렀습니다' });
    pushThreads();
    handoff?.resume(threadId);

    return {
      threadId,
      checkpointId: checkpoint?.id ?? null,
      cursor: checkpoint?.payload.cursor ?? {},
      results: checkpoint?.payload.results ?? [],
      messageIndex: checkpoint?.messageIndex ?? 0,
      tabs: restored.tabs
    };
  });

  ipcMain.handle(IPC.threadStop, (_e, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadStore) return false;
    threadStore.setStatus(threadId, 'done', 'user_takeover');
    threadStore.append(threadId, { role: 'system', text: '사람이 여기까지를 눌렀습니다' });
    handoff?.takeOver(threadId);
    pushThreads();
    return true;
  });

  // ── M4a 지속성: 받은편지함 ──
  ipcMain.handle(IPC.inboxGet, () =>
    inbox ? { unread: inbox.unreadCount(), items: inbox.list({ limit: 100 }) } : { unread: 0, items: [] }
  );

  ipcMain.handle(IPC.inboxMarkRead, (_e, id: unknown) =>
    typeof id === 'number' ? (inbox?.markRead(id) ?? false) : false
  );

  ipcMain.handle(IPC.inboxMarkAllRead, () => inbox?.markAllRead() ?? 0);

  ipcMain.handle(IPC.inboxRemove, (_e, id: unknown) =>
    typeof id === 'number' ? (inbox?.remove(id) ?? false) : false
  );

  // ── M4a 지속성: 체크포인트 ──
  ipcMain.handle(IPC.checkpointsGet, (_e, threadId: unknown) => {
    if (typeof threadId !== 'string' || !checkpointStore) return [];
    return checkpointStore.list(threadId);
  });

  ipcMain.handle(IPC.checkpointSave, async (_e, threadId: unknown, name: unknown) => {
    if (typeof threadId !== 'string') return null;
    return saveCheckpointFor(threadId, {
      name: typeof name === 'string' && name.trim() !== '' ? name : '수동 저장',
      trigger: 'manual'
    });
  });

  ipcMain.handle(IPC.checkpointRestore, async (_e, id: unknown) => {
    if (typeof id !== 'number') return null;
    return restoreCheckpointFor(id);
  });

  // ── M4a 지속성: 메모 ──
  ipcMain.handle(IPC.notesScopes, () => noteStore?.scopes() ?? []);

  ipcMain.handle(IPC.notesGet, (_e, scope: unknown) => {
    if (typeof scope !== 'string' || !noteStore) return null;
    return { note: noteStore.read(scope), history: noteStore.history(scope) };
  });

  ipcMain.handle(IPC.noteAppend, (_e, scope: unknown, text: unknown) => {
    if (typeof scope !== 'string' || typeof text !== 'string' || !noteStore) {
      return { ok: false, reason: 'scope', message: '잘못된 인자' };
    }
    return noteStore.append(scope, text);
  });

  ipcMain.handle(IPC.noteRestore, (_e, scope: unknown, version: unknown) => {
    if (typeof scope !== 'string' || typeof version !== 'number' || !noteStore) {
      return { ok: false, reason: 'scope', message: '잘못된 인자' };
    }
    return noteStore.restore(scope, version);
  });

  // ── M4a 지속성: 세션 ──
  ipcMain.handle(IPC.sessionsGet, () => {
    if (!sessionStore) return { current: DEFAULT_SESSION, sessions: [] };
    return { current: sessionStore.currentName(), sessions: sessionStore.list() };
  });

  ipcMain.handle(IPC.sessionUse, (_e, name: unknown) => {
    if (typeof name !== 'string' || !sessionStore) return null;
    const info = sessionStore.use(name);
    if (info) sendToShell(IPC.sessionsChanged, { current: name, sessions: sessionStore.list() });
    return info;
  });

  // ── M4a 지속성: 북마크 메타 ──
  ipcMain.handle(IPC.bookmarkMetaGet, (_e, bookmarkId: unknown) => {
    if (typeof bookmarkId !== 'number' || !bookmarkMeta) return null;
    return bookmarkMeta.get(bookmarkId);
  });

  ipcMain.handle(IPC.bookmarkMetaSet, (_e, bookmarkId: unknown, value: unknown) => {
    if (typeof bookmarkId !== 'number' || !bookmarkMeta || value === null || typeof value !== 'object') {
      return { ok: false, reason: 'scope', message: '잘못된 인자' };
    }

    const input = value as Record<string, unknown>;
    const asString = (key: string): string | undefined =>
      typeof input[key] === 'string' ? (input[key] as string) : undefined;

    return bookmarkMeta.set(bookmarkId, {
      ...(asString('intent') === undefined ? {} : { intent: asString('intent') as string }),
      ...(asString('expectedContent') === undefined
        ? {}
        : { expectedContent: asString('expectedContent') as string }),
      ...(asString('agentHints') === undefined ? {} : { agentHints: asString('agentHints') as string }),
      ...(Array.isArray(input['keyFields'])
        ? {
            keyFields: (input['keyFields'] as unknown[]).filter(
              (item): item is string => typeof item === 'string'
            )
          }
        : {})
    });
  });

  // ── M4a 지속성: 변경 이력 ──
  ipcMain.handle(IPC.pageHistoryUrls, () => changeTracker?.trackedUrls() ?? []);

  ipcMain.handle(IPC.pageHistoryGet, (_e, url: unknown) => {
    if (typeof url !== 'string' || !changeTracker) return [];
    return changeTracker.history(url);
  });

  ipcMain.handle(IPC.pageDiffGet, (_e, url: unknown, fromId: unknown, toId: unknown) => {
    if (typeof url !== 'string' || !changeTracker) return null;
    return changeTracker.diff(
      url,
      typeof fromId === 'number' ? fromId : undefined,
      typeof toId === 'number' ? toId : undefined
    );
  });

  // ── M4a 지속성: 결과표 ──
  ipcMain.handle(IPC.resultsGet, (_e, threadId: unknown) => {
    if (typeof threadId !== 'string') return [];
    return lastResults.get(threadId) ?? [];
  });

  ipcMain.handle(IPC.resultsExport, (_e, threadId: unknown, format: unknown) => {
    if (typeof threadId !== 'string') return null;
    const allowed = ['csv', 'md', 'json'];
    if (typeof format !== 'string' || !allowed.includes(format)) return null;

    return exportResults(threadId, format as 'csv' | 'md' | 'json');
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

  // ── M5 검증 계층 ──
  ipcMain.handle(IPC.workflowsGet, () => workflowRunner?.list() ?? []);
  ipcMain.handle(IPC.workflowRunsGet, () => workflowRuns);

  ipcMain.handle(IPC.workflowRun, async (_e, workflowId: unknown, inputs: unknown) => {
    if (typeof workflowId !== 'string' || !workflowRunner) return null;

    const args =
      inputs !== null && typeof inputs === 'object' ? (inputs as Record<string, unknown>) : {};

    try {
      return recordWorkflowRun(await workflowRunner.run(workflowId, args));
    } catch (error) {
      console.error(`[workflow] ${workflowId} 실행 실패`, error);
      return null;
    }
  });

  ipcMain.handle(IPC.workflowPromote, (_e, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadStore) return null;

    const thread = threadStore.get(threadId);
    if (!thread) return null;

    const draft = promoteThread({
      threadId,
      title: thread.title,
      messages: threadStore.messages(threadId)
    });

    return { yaml: draft.yaml, workflowId: draft.workflowId, todo: draft.todo, skipped: draft.skipped };
  });

  ipcMain.handle(IPC.workflowCheck, (_e, source: unknown) => {
    if (typeof source !== 'string') {
      return { ok: false, issues: ['내용이 없습니다'], id: null, version: null, oracles: 0 };
    }

    const check = checkDraft(source);
    return {
      ok: check.ok,
      issues: check.issues,
      id: check.workflow?.id ?? null,
      version: check.workflow?.version ?? null,
      oracles: check.workflow?.oracles.length ?? 0
    };
  });

  ipcMain.handle(IPC.workflowSave, (_e, source: unknown) => {
    if (typeof source !== 'string') {
      return { ok: false, issues: ['내용이 없습니다'], id: null, version: null, oracles: 0, file: null };
    }

    // 저장 전에 실제 로더를 통과해야 한다 — 오라클이 빈 초안은 여기서 막힌다.
    const check = checkDraft(source);
    if (!check.ok || !check.workflow) {
      return {
        ok: false,
        issues: check.issues,
        id: null,
        version: null,
        oracles: 0,
        file: null
      };
    }

    const dir = path.join(app.getAppPath(), 'workflows');
    const file = path.join(dir, `${check.workflow.id}.yaml`);

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, source.endsWith('\n') ? source : `${source}\n`, 'utf-8');
      workflowRunner?.forget(check.workflow.id);
    } catch (error) {
      return {
        ok: false,
        issues: [`[workflowSave] 저장 실패 - 경로: ${file} - ${(error as Error).message}`],
        id: check.workflow.id,
        version: check.workflow.version,
        oracles: check.workflow.oracles.length,
        file: null
      };
    }

    return {
      ok: true,
      issues: [],
      id: check.workflow.id,
      version: check.workflow.version,
      oracles: check.workflow.oracles.length,
      file
    };
  });

  ipcMain.handle(IPC.schedulesGet, () =>
    (scheduler?.list() ?? []).map((entry) => ({
      id: entry.id,
      workflowId: entry.workflowId,
      cron: entry.cron,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      lastRunAt: entry.lastRunAt,
      lastVerdict: entry.lastVerdict,
      runCount: entry.runCount
    }))
  );

  ipcMain.handle(IPC.scheduleAdd, (_e, input: unknown) => {
    if (input === null || typeof input !== 'object' || !scheduler) return { error: '입력이 없습니다' };

    const record = input as Record<string, unknown>;
    const id = String(record['id'] ?? '');
    const workflowId = String(record['workflowId'] ?? '');
    const expression = String(record['cron'] ?? '');

    if (id === '' || workflowId === '' || expression === '') {
      return { error: 'id · workflowId · cron 이 모두 필요합니다' };
    }

    try {
      const entry = scheduler.add({
        id,
        workflowId,
        cron: expression,
        ...(record['inputs'] !== null && typeof record['inputs'] === 'object'
          ? { inputs: record['inputs'] as Record<string, unknown> }
          : {}),
        ...(typeof record['description'] === 'string' ? { description: record['description'] } : {})
      });

      return {
        id: entry.id,
        workflowId: entry.workflowId,
        cron: entry.cron,
        lastRunAt: entry.lastRunAt,
        lastVerdict: entry.lastVerdict,
        runCount: entry.runCount
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC.scheduleRemove, (_e, id: unknown) => {
    if (typeof id !== 'string' || !scheduler) return false;
    return scheduler.remove(id);
  });

  ipcMain.handle(IPC.scheduleFire, async (_e, id: unknown) => {
    if (typeof id !== 'string' || !scheduler) return null;

    const outcome = await scheduler.fire(id);
    return outcome === null ? null : recordWorkflowRun(outcome);
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
  // 남은 승인 요청은 거부로 떨어뜨린다. 조용히 통과시키지 않는다.
  approval?.rejectAll();
  // 예약을 먼저 세운다 — 종료 중에 cron 이 새 실행을 시작하면 탭 없이 돌게 된다.
  scheduler?.stopAll();
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

  // ── M4a 지속성 계층 ──
  sessionStore = new SessionStore(database, {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted)
  });
  threadStore = new ThreadStore(database);
  checkpointStore = new CheckpointStore(database);
  inbox = new Inbox(database, () => pushInbox());
  noteStore = new NoteStore(database);
  bookmarkMeta = new BookmarkMeta(database);
  changeTracker = new ChangeTracker(database);

  // ── M5 검증 계층 ──
  // 워크플로우는 사람이 쓰는 것과 같은 문(ToolSurface)을 지난다 — 정책·마스킹·감사 로그가
  // 거기 붙어 있다. 증거 팩 위치는 테스트가 저장소 안으로 돌릴 수 있게 환경변수로 연다.
  workflowRunner = new WorkflowRunner({
    callTool: async (threadId, name, args) => {
      const { callTool: dispatch } = await import('./tools/index');
      return dispatch(createToolContext(threadId, 'workflow'), name, args);
    },
    baseDir: evidenceBaseDir(),
    workflowDir: path.join(app.getAppPath(), 'workflows')
  });

  scheduler = new Scheduler({
    runner: workflowRunner,
    post: (item) => {
      inbox?.post({
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        threadId: item.threadId,
        ...(item.evidencePath === '' ? {} : { evidencePath: item.evidencePath })
      });
    }
  });

  // 앱이 죽어서 남은 running 스레드는 paused 로 내린다(불변 조건 6).
  const recovered = threadStore.recoverInterrupted();
  if (recovered > 0) {
    console.warn(`[main] 중단된 스레드 ${recovered}건을 paused 로 복구했습니다`);
  }
  searchConfig = loadSearchConfig(configDir());

  downloads = new Downloads({
    downloadDir: downloadDir(),
    onChange: (items) => sendToShell(IPC.downloadsChanged, items)
  });
  downloads.attach(helmSession);

  shell.theme = getThemeSource();
  shell.darkMode = isDarkMode();

  // ── M3 제어 계층 ──
  // policy.json 형식이 어긋나면 기동을 세운다(GOAL-M3 FIXED DECISIONS).
  // 정책 파일이 깨진 채로 도는 것이 정책 없이 도는 것보다 위험하다.
  try {
    policy = Policy.load(app.getPath('userData'), path.join(configDir(), 'policy.json'));
  } catch (error) {
    if (error instanceof PolicyLoadError) {
      console.error(error.message);
      dialog.showErrorBox('정책 파일 오류', error.message);
      app.exit(1);
      return;
    }
    throw error;
  }

  approval = new Approval({
    onRequest: (request) => sendToShell(IPC.approvalRequested, request),
    onQueueChange: (queue) => {
      approvalQueue = queue;
      sendToShell(IPC.approvalQueueChanged, queue);
      refreshAiState();
    }
  });

  // 되돌리기 스택이 바뀌면 셸의 UndoPanel 이 곧바로 따라간다.
  undoManager = new UndoManager((runId, records) => {
    sendToShell(IPC.undoChanged, { runId, records });
  });

  auditLog = new AuditLog(app.getPath('userData'), APP_RUN_ID);
  AuditLog.prune(app.getPath('userData'), policy.snapshot().retentionDays);

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
      getPolicy: () => policy,
      getApproval: () => approval,
      getUndo: () => undoManager,
      /** 셸의 UndoPanel 이 보고 있는 실행 단위 — MCP 연결이 만든 스택일 수 있다. */
      undoActiveRunId: () => undoManager?.activeRunId() ?? APP_RUN_ID,
      getAudit: () => auditLog,
      runId: APP_RUN_ID,
      approvalQueue: () => approvalQueue,
      answerApproval: (id: string, scope: string | null) => {
        if (!approval) return false;
        return scope === null
          ? approval.answer(id, { granted: false, reason: 'denied' })
          : approval.answer(id, { granted: true, scope: scope as 'once' | 'thread' | 'domain' });
      },
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
      // ── M4a 지속성 ──
      getSessionStore: () => sessionStore,
      getThreadStore: () => threadStore,
      getCheckpointStore: () => checkpointStore,
      getInbox: () => inbox,
      getNoteStore: () => noteStore,
      getBookmarkMeta: () => bookmarkMeta,
      getChangeTracker: () => changeTracker,
      exportResults: (threadId: string, format: 'csv' | 'md' | 'json') =>
        exportResults(threadId, format),
      getResults: (threadId: string) => lastResults.get(threadId) ?? [],
      saveCheckpointFor,
      restoreCheckpointFor,
      /** 모의 포털 내부 상태 — "자동 상신 0회"·PII 원본 대조의 판정 근거 */
      submittedDocs: async () => {
        const { portalTestHooks } = await import('./browser/PortalProtocol');
        return portalTestHooks.submittedDocs();
      },
      resetSubmitted: async () => {
        const { portalTestHooks } = await import('./browser/PortalProtocol');
        portalTestHooks.resetSubmitted();
      },
      wikiDefects: async () => {
        const { portalTestHooks } = await import('./browser/PortalProtocol');
        return portalTestHooks.wiki.defects().map((defect) => `${defect.pageId}:${defect.kind}`);
      },
      portalTeams: async () => {
        const { portalTestHooks } = await import('./browser/PortalProtocol');
        return portalTestHooks.teams();
      },
      approvalDocs: async () => {
        const { portalTestHooks } = await import('./browser/PortalProtocol');
        return portalTestHooks.approvalDocs();
      },
      piiSamples: async () => {
        const { portalTestHooks } = await import('./browser/PortalProtocol');
        return portalTestHooks.piiSamples();
      },
      // ── M5 검증 계층 ──
      evidenceBaseDir: evidenceBaseDir(),
      listWorkflows: () => workflowRunner?.list() ?? [],
      runWorkflow: async (workflowId: string, inputs: Record<string, unknown>, runId?: string) => {
        if (!workflowRunner) return null;
        const outcome = await workflowRunner.run(
          workflowId,
          inputs,
          runId === undefined ? {} : { runId }
        );
        recordWorkflowRun(outcome);
        return outcome;
      },
      workflowRuns: () => workflowRuns,
      promoteThreadDraft: (threadId: string) => {
        if (!threadStore) return null;
        const thread = threadStore.get(threadId);
        if (!thread) return null;
        return promoteThread({
          threadId,
          title: thread.title,
          messages: threadStore.messages(threadId)
        });
      },
      checkWorkflowDraft: (source: string) => {
        const check = checkDraft(source);
        return { ok: check.ok, issues: check.issues, id: check.workflow?.id ?? null };
      },
      getScheduler: () => scheduler,
      addSchedule: (input: { id: string; workflowId: string; cron: string; inputs?: Record<string, unknown> }) =>
        scheduler?.add(input) ?? null,
      fireSchedule: async (id: string) => {
        const outcome = (await scheduler?.fire(id)) ?? null;
        return outcome === null ? null : recordWorkflowRun(outcome);
      },
      /** 정산 API 스위치 — 어댑터 사다리 폴백을 시험한다(성공 조건 5) */
      setSettleApi: async (enabled: boolean) => {
        const { portalTestHooks } = await import('./browser/PortalProtocol');
        portalTestHooks.setSettleApi(enabled);
        return portalTestHooks.isSettleApiEnabled();
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
