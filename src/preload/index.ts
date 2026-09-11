import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../main/ipc/channels';
import type { HelmApi } from '../shared/api';

/**
 * 셸에 노출하는 API. channels.ts 화이트리스트 밖의 채널은 접근할 수 없고,
 * ipcRenderer 자체는 넘기지 않는다.
 */

/** 이벤트 구독 보일러플레이트. 반환된 함수를 호출하면 리스너를 뗀다. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: HelmApi = {
  // 탭
  getState: () => ipcRenderer.invoke(IPC.stateGet),
  createTab: (url) => ipcRenderer.invoke(IPC.tabsCreate, url),
  closeTab: (id) => ipcRenderer.invoke(IPC.tabsClose, id),
  selectTab: (id) => ipcRenderer.invoke(IPC.tabsSelect, id),
  navigate: (id, input) => ipcRenderer.invoke(IPC.tabsNavigate, id, input),
  goBack: (id) => ipcRenderer.invoke(IPC.tabsGoBack, id),
  goForward: (id) => ipcRenderer.invoke(IPC.tabsGoForward, id),
  reload: (id) => ipcRenderer.invoke(IPC.tabsReload, id),
  moveTab: (id, toIndex) => ipcRenderer.invoke(IPC.tabsMove, id, toIndex),
  setPinned: (id, pinned) => ipcRenderer.invoke(IPC.tabsSetPinned, id, pinned),
  setMuted: (id, muted) => ipcRenderer.invoke(IPC.tabsSetMuted, id, muted),
  restoreClosedTab: () => ipcRenderer.invoke(IPC.tabsRestoreClosed),
  setOrientation: (orientation) => ipcRenderer.invoke(IPC.tabsSetOrientation, orientation),

  // 셸 상태
  getShellState: () => ipcRenderer.invoke(IPC.shellGet),
  openPanel: (panel) => ipcRenderer.invoke(IPC.panelOpen, panel),

  // 주소창
  suggest: (input) => ipcRenderer.invoke(IPC.omniboxSuggest, input),

  // 히스토리
  historyList: (query) => ipcRenderer.invoke(IPC.historyList, query ?? ''),
  historyRemove: (id) => ipcRenderer.invoke(IPC.historyRemove, id),
  historyClear: () => ipcRenderer.invoke(IPC.historyClear),

  // 북마크
  bookmarksList: () => ipcRenderer.invoke(IPC.bookmarksList),
  bookmarkAdd: (url, title) => ipcRenderer.invoke(IPC.bookmarksAdd, url, title),
  bookmarkRemove: (id) => ipcRenderer.invoke(IPC.bookmarksRemove, id),
  bookmarkRemoveByUrl: (url) => ipcRenderer.invoke(IPC.bookmarksRemoveByUrl, url),
  bookmarkRename: (id, title) => ipcRenderer.invoke(IPC.bookmarksRename, id, title),

  // 다운로드
  downloadsList: () => ipcRenderer.invoke(IPC.downloadsList),
  downloadStart: (url) => ipcRenderer.invoke(IPC.downloadStart, url),
  downloadCancel: (id) => ipcRenderer.invoke(IPC.downloadsCancel, id),
  downloadPause: (id) => ipcRenderer.invoke(IPC.downloadsPause, id),
  downloadResume: (id) => ipcRenderer.invoke(IPC.downloadsResume, id),
  downloadShowInFolder: (id) => ipcRenderer.invoke(IPC.downloadsShowInFolder, id),
  downloadOpen: (id) => ipcRenderer.invoke(IPC.downloadsOpen, id),
  downloadRemove: (id) => ipcRenderer.invoke(IPC.downloadsRemove, id),
  downloadClearCompleted: () => ipcRenderer.invoke(IPC.downloadsClearCompleted),

  // 읽기 모드
  readTab: (id) => ipcRenderer.invoke(IPC.readerRead, id),

  // 페이지 도구
  find: (query, advance, forward) => ipcRenderer.invoke(IPC.findStart, query, advance, forward),
  stopFind: () => ipcRenderer.invoke(IPC.findStop),
  print: () => ipcRenderer.invoke(IPC.pagePrint),
  savePdf: () => ipcRenderer.invoke(IPC.pageSavePdf),
  toggleDevTools: () => ipcRenderer.invoke(IPC.pageToggleDevTools),
  setZoom: (factor) => ipcRenderer.invoke(IPC.pageSetZoom, factor),

  // 테마
  setTheme: (theme) => ipcRenderer.invoke(IPC.themeSet, theme),
  cycleTheme: () => ipcRenderer.invoke(IPC.themeCycle),

  // 프로필 가져오기
  discoverProfiles: () => ipcRenderer.invoke(IPC.importDiscover),
  runImport: (dir) => ipcRenderer.invoke(IPC.importRun, dir),

  // AI 코브라우징 / Handoff
  getAiState: () => ipcRenderer.invoke(IPC.aiStateGet),
  resumeAi: () => ipcRenderer.invoke(IPC.aiResume),
  takeOverAi: () => ipcRenderer.invoke(IPC.aiTakeOver),
  setOverlayEnabled: (enabled) => ipcRenderer.invoke(IPC.aiOverlayToggle, enabled),
  answerPrompt: (id, answer) => ipcRenderer.invoke(IPC.promptAnswer, id, answer),

  // 승인 3단계
  getApprovalQueue: () => ipcRenderer.invoke(IPC.approvalQueueGet),
  answerApproval: (id, scope) => ipcRenderer.invoke(IPC.approvalAnswer, id, scope),

  // 정책 설정
  getPolicy: () => ipcRenderer.invoke(IPC.policyGet),
  revokeGrant: (index) => ipcRenderer.invoke(IPC.policyRevokeGrant, index),
  setPolicyDeny: (hosts, tools) => ipcRenderer.invoke(IPC.policySetDeny, hosts, tools),
  setPolicySite: (host, decision) => ipcRenderer.invoke(IPC.policySetSite, host, decision),

  // 되돌리기
  getUndo: () => ipcRenderer.invoke(IPC.undoGet),
  applyUndo: (runId, id) => ipcRenderer.invoke(IPC.undoApply, runId, id),

  // 단계 로그 재생
  readAudit: () => ipcRenderer.invoke(IPC.auditRead),
  openAuditUrl: (url) => ipcRenderer.invoke(IPC.auditOpenUrl, url),

  // ── M4a 지속성 ──
  getThreads: () => ipcRenderer.invoke(IPC.threadsGet),
  createThread: (title) => ipcRenderer.invoke(IPC.threadCreate, title),
  getThreadMessages: (threadId) => ipcRenderer.invoke(IPC.threadMessages, threadId),
  sayToThread: (threadId, text) => ipcRenderer.invoke(IPC.threadSay, threadId, text),
  resumeThread: (threadId) => ipcRenderer.invoke(IPC.threadResume, threadId),
  stopThread: (threadId) => ipcRenderer.invoke(IPC.threadStop, threadId),

  getInbox: () => ipcRenderer.invoke(IPC.inboxGet),
  markInboxRead: (id) => ipcRenderer.invoke(IPC.inboxMarkRead, id),
  markInboxAllRead: () => ipcRenderer.invoke(IPC.inboxMarkAllRead),
  removeInboxItem: (id) => ipcRenderer.invoke(IPC.inboxRemove, id),

  getCheckpoints: (threadId) => ipcRenderer.invoke(IPC.checkpointsGet, threadId),
  saveCheckpoint: (threadId, name) => ipcRenderer.invoke(IPC.checkpointSave, threadId, name),
  restoreCheckpoint: (id) => ipcRenderer.invoke(IPC.checkpointRestore, id),

  getNoteScopes: () => ipcRenderer.invoke(IPC.notesScopes),
  getNote: (scope) => ipcRenderer.invoke(IPC.notesGet, scope),
  appendNote: (scope, text) => ipcRenderer.invoke(IPC.noteAppend, scope, text),
  restoreNote: (scope, version) => ipcRenderer.invoke(IPC.noteRestore, scope, version),

  getSessions: () => ipcRenderer.invoke(IPC.sessionsGet),
  useSession: (name) => ipcRenderer.invoke(IPC.sessionUse, name),

  getBookmarkMeta: (bookmarkId) => ipcRenderer.invoke(IPC.bookmarkMetaGet, bookmarkId),
  setBookmarkMeta: (bookmarkId, value) =>
    ipcRenderer.invoke(IPC.bookmarkMetaSet, bookmarkId, value),

  getTrackedUrls: () => ipcRenderer.invoke(IPC.pageHistoryUrls),
  getPageHistory: (url) => ipcRenderer.invoke(IPC.pageHistoryGet, url),
  getPageDiff: (url, fromId, toId) => ipcRenderer.invoke(IPC.pageDiffGet, url, fromId, toId),

  getResults: (threadId) => ipcRenderer.invoke(IPC.resultsGet, threadId),
  exportResults: (threadId, format) => ipcRenderer.invoke(IPC.resultsExport, threadId, format),

  // 워크플로우(M5)
  getWorkflows: () => ipcRenderer.invoke(IPC.workflowsGet),
  runWorkflow: (workflowId, inputs) => ipcRenderer.invoke(IPC.workflowRun, workflowId, inputs),
  getWorkflowRuns: () => ipcRenderer.invoke(IPC.workflowRunsGet),
  promoteThread: (threadId) => ipcRenderer.invoke(IPC.workflowPromote, threadId),
  checkWorkflow: (source) => ipcRenderer.invoke(IPC.workflowCheck, source),
  saveWorkflow: (source) => ipcRenderer.invoke(IPC.workflowSave, source),
  getSchedules: () => ipcRenderer.invoke(IPC.schedulesGet),
  addSchedule: (input) => ipcRenderer.invoke(IPC.scheduleAdd, input),
  removeSchedule: (id) => ipcRenderer.invoke(IPC.scheduleRemove, id),
  fireSchedule: (id) => ipcRenderer.invoke(IPC.scheduleFire, id),

  // 구독
  onStateChanged: (listener) => subscribe(IPC.stateChanged, listener),
  onShellChanged: (listener) => subscribe(IPC.shellChanged, listener),
  onBookmarksChanged: (listener) => subscribe(IPC.bookmarksChanged, listener),
  onDownloadsChanged: (listener) => subscribe(IPC.downloadsChanged, listener),
  onFocusOmnibox: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on(IPC.focusOmnibox, wrapped);
    return () => ipcRenderer.removeListener(IPC.focusOmnibox, wrapped);
  },
  onFocusFindBar: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on(IPC.focusFindBar, wrapped);
    return () => ipcRenderer.removeListener(IPC.focusFindBar, wrapped);
  },
  onAiStateChanged: (listener) => subscribe(IPC.aiStateChanged, listener),
  onPromptRequested: (listener) => subscribe(IPC.promptRequested, listener),
  onApprovalRequested: (listener) => subscribe(IPC.approvalRequested, listener),
  onApprovalQueueChanged: (listener) => subscribe(IPC.approvalQueueChanged, listener),
  onUndoChanged: (listener) => subscribe(IPC.undoChanged, listener),
  onThreadsChanged: (listener) => subscribe(IPC.threadsChanged, listener),
  onInboxChanged: (listener) => subscribe(IPC.inboxChanged, listener),
  onCheckpointsChanged: (listener) => subscribe(IPC.checkpointsChanged, listener),
  onSessionsChanged: (listener) => subscribe(IPC.sessionsChanged, listener),
  onTrackedUrlsChanged: (listener) => subscribe(IPC.pageHistoryUrls, listener),
  onWorkflowRunsChanged: (listener) => subscribe(IPC.workflowRunsChanged, listener)
};

contextBridge.exposeInMainWorld('helm', api);
