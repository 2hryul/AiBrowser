import type {
  AiState,
  ApprovalRequestView,
  AuditReadView,
  Bookmark,
  BookmarkMetaView,
  BookmarkMetaWriteView,
  BrowserState,
  CheckpointView,
  DownloadItem,
  ExportResultView,
  ExtensionLoadResult,
  FindState,
  GrantScope,
  HistoryEntry,
  InboxStateView,
  NoteStateView,
  NoteWriteView,
  OmniboxSuggestion,
  PageDiffView,
  PendingPrompt,
  PolicyView,
  ProfileImportResult,
  ReaderPayload,
  ResumeView,
  SessionStateView,
  ShellPanel,
  SnapshotView,
  TabStripOrientation,
  ThemeSource,
  ThreadMessageView,
  ThreadView,
  TrackedUrlView,
  UndoOutcomeView,
  UndoStackView
} from './types';

/** 셸이 그리는 브라우저 크롬의 상태 — 탭 목록과 별개로 바뀌므로 따로 둔다. */
export interface ShellState {
  panel: ShellPanel;
  find: FindState | null;
  theme: ThemeSource;
  darkMode: boolean;
  /** 북마크가 하나라도 있으면 북마크바를 띄운다(크롬과 달리 토글을 두지 않는다). */
  bookmarksBarVisible: boolean;
  /** 확장 로드 결과 — 설정 화면과 docs/extensions.md 기록용 */
  extensions: ExtensionLoadResult[];
}

export interface DiscoveredProfileInfo {
  browser: 'chrome' | 'edge';
  name: string;
  dir: string;
  available: readonly string[];
}

/**
 * preload 가 `window.helm` 으로 노출하는 표면.
 * 메인/preload(Node)와 렌더러(DOM)가 서로의 소스를 참조하지 않도록 계약만 여기 둔다.
 */
// ── M5 검증 계층 ──────────────────────────────────────

export interface WorkflowListItem {
  id: string;
  version: number;
  description: string | null;
  file: string;
  /** 로드 실패 사유. null 이면 실행 가능하다. */
  error: string | null;
}

export interface WorkflowOracleView {
  rule: string;
  ruleVersion: number;
  verdict: string;
  ok: boolean;
  message: string;
}

export interface WorkflowRunView {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  inputs: Record<string, unknown>;
  verdict: string;
  status: string;
  /** 단계별 실제 획득 경로 — 폴백이 일어났으면 계약과 달라진다 */
  sources: { step: string; adapter: string | null; source: string; note: string | null }[];
  oracles: WorkflowOracleView[];
  evidencePath: string;
  durationMs: number;
  finishedAt: number;
}

export interface WorkflowDraftView {
  yaml: string;
  workflowId: string;
  /** 사람이 해야 할 일 — 오라클 추가가 언제나 첫 줄이다 */
  todo: string[];
  skipped: { tool: string; reason: string }[];
}

export interface WorkflowCheckView {
  ok: boolean;
  issues: string[];
  id: string | null;
  version: number | null;
  oracles: number;
}

export interface ScheduleView {
  id: string;
  workflowId: string;
  cron: string;
  description?: string;
  lastRunAt: number | null;
  lastVerdict: string | null;
  runCount: number;
}

export interface AgentStatusView {
  available: boolean;
  provider: 'openai' | 'anthropic' | null;
  model: string | null;
  /** 배운 매크로 수 */
  macros: number;
  running: string[];
}

export interface AgentOutcomeView {
  status: 'done' | 'failed' | 'paused' | 'stopped';
  steps: number;
  llmCalls: number;
  macroHits: number;
  rows: number;
  duplicates: number;
  summary: string;
  reason: string | null;
}

export interface HelmApi {
  // 탭
  getState(): Promise<BrowserState>;
  createTab(url?: string): Promise<number>;
  closeTab(id: number): Promise<boolean>;
  selectTab(id: number): Promise<boolean>;
  navigate(id: number, input: string): Promise<boolean>;
  goBack(id: number): Promise<boolean>;
  goForward(id: number): Promise<boolean>;
  reload(id: number): Promise<boolean>;
  moveTab(id: number, toIndex: number): Promise<boolean>;
  setPinned(id: number, pinned: boolean): Promise<boolean>;
  setMuted(id: number, muted: boolean): Promise<boolean>;
  restoreClosedTab(): Promise<number | null>;
  setOrientation(orientation: TabStripOrientation): Promise<boolean>;

  // 셸 상태
  getShellState(): Promise<ShellState>;
  openPanel(panel: ShellPanel): Promise<boolean>;

  // 주소창
  suggest(input: string): Promise<OmniboxSuggestion[]>;

  // 히스토리
  historyList(query?: string): Promise<HistoryEntry[]>;
  historyRemove(id: number): Promise<boolean>;
  historyClear(): Promise<boolean>;

  // 북마크
  bookmarksList(): Promise<Bookmark[]>;
  bookmarkAdd(url: string, title: string): Promise<Bookmark | null>;
  bookmarkRemove(id: number): Promise<boolean>;
  bookmarkRemoveByUrl(url: string): Promise<boolean>;
  bookmarkRename(id: number, title: string): Promise<boolean>;

  // 다운로드
  downloadsList(): Promise<DownloadItem[]>;
  downloadStart(url: string): Promise<boolean>;
  downloadCancel(id: number): Promise<boolean>;
  downloadPause(id: number): Promise<boolean>;
  downloadResume(id: number): Promise<boolean>;
  downloadShowInFolder(id: number): Promise<boolean>;
  downloadOpen(id: number): Promise<boolean>;
  downloadRemove(id: number): Promise<boolean>;
  downloadClearCompleted(): Promise<boolean>;

  // 읽기 모드
  readTab(id: number): Promise<ReaderPayload>;

  // 페이지 도구
  /** advance=true 면 기존 검색 세션에서 다음/이전 일치로 이동한다. */
  find(query: string, advance?: boolean, forward?: boolean): Promise<FindState>;
  stopFind(): Promise<boolean>;
  print(): Promise<boolean>;
  savePdf(): Promise<{ ok: boolean; filePath: string | null; error: string | null }>;
  toggleDevTools(): Promise<boolean>;
  setZoom(factor: number): Promise<number>;

  // 테마
  setTheme(theme: ThemeSource): Promise<ThemeSource>;
  cycleTheme(): Promise<ThemeSource>;

  // 프로필 가져오기
  discoverProfiles(): Promise<DiscoveredProfileInfo[]>;
  runImport(dir: string): Promise<ProfileImportResult | null>;

  // AI 코브라우징 / Handoff
  getAiState(): Promise<AiState>;
  /** "이어서" — 개입이 있었음을 호출자에게 알리고 계속한다. */
  resumeAi(): Promise<boolean>;
  /** "여기까지" — 스레드를 끝내고 탭 소유권을 사람에게 넘긴다. */
  takeOverAi(): Promise<boolean>;
  setOverlayEnabled(enabled: boolean): Promise<boolean>;
  /** ask_user / request_access 에 답한다. */
  answerPrompt(id: string, answer: string): Promise<boolean>;

  // 승인 3단계 — scope 가 null 이면 거부다(자동 승인 경로는 없다).
  getApprovalQueue(): Promise<ApprovalRequestView[]>;
  answerApproval(id: string, scope: GrantScope | null): Promise<boolean>;

  // 정책 설정
  getPolicy(): Promise<PolicyView | null>;
  revokeGrant(index: number): Promise<boolean>;
  setPolicyDeny(hosts: string[], tools: string[]): Promise<boolean>;
  setPolicySite(host: string, decision: 'allow' | 'ask' | 'deny'): Promise<boolean>;

  // 되돌리기 — 사람 UI 와 AI `undo` 도구가 같은 스택을 본다.
  getUndo(): Promise<UndoStackView>;
  /** id 를 생략하면 그 스레드의 가장 최근 항목을 되돌린다. */
  applyUndo(runId: string, id?: string): Promise<UndoOutcomeView>;

  // 단계 로그 재생
  readAudit(): Promise<AuditReadView>;
  /** 그 단계의 URL 을 사람 소유 새 탭으로 연다. */
  openAuditUrl(url: string): Promise<number | null>;

  // ── M4a 지속성 ──

  // 스레드 — 앱을 닫아도 같은 스레드에 이어 말할 수 있다.
  getThreads(): Promise<ThreadView[]>;
  createThread(title?: string): Promise<ThreadView | null>;
  getThreadMessages(threadId: string): Promise<ThreadMessageView[]>;
  /** 사람이 한 마디 보탠다. */
  sayToThread(threadId: string, text: string): Promise<ThreadMessageView | null>;

  // ── M4b 내장 에이전트 ──
  /** 모델이 설정돼 있는가. 없으면 입력칸은 "이어 말하기" 로만 동작한다. */
  getAgentStatus(): Promise<AgentStatusView>;
  /** 지시를 에이전트에게 준다. 가벼운 요청과 작업 지시가 같은 입구를 쓴다. */
  runAgent(threadId: string, instruction: string): Promise<AgentOutcomeView | null>;
  /** "여기까지" — 도는 에이전트를 끊는다. */
  stopAgent(threadId: string): Promise<boolean>;
  onAgentRunning(handler: (payload: { threadId: string; running: boolean }) => void): () => void;
  /** 사이트 메모 제안이 왔다. 사람이 받아야 저장된다. */
  onAgentNoteProposal(
    handler: (payload: { threadId: string; host: string; text: string }) => void
  ): () => void;
  acceptAgentNote(accept: boolean): Promise<unknown>;
  /** "이어서" — 마지막 체크포인트로 되돌리고 running 으로. */
  resumeThread(threadId: string): Promise<ResumeView | null>;
  /** "여기까지" — 스레드를 끝내고 탭 소유권을 사람에게. */
  stopThread(threadId: string): Promise<boolean>;

  // 받은편지함
  getInbox(): Promise<InboxStateView>;
  markInboxRead(id: number): Promise<boolean>;
  markInboxAllRead(): Promise<number>;
  removeInboxItem(id: number): Promise<boolean>;

  // 체크포인트
  getCheckpoints(threadId: string): Promise<CheckpointView[]>;
  saveCheckpoint(threadId: string, name?: string): Promise<CheckpointView | null>;
  restoreCheckpoint(id: number): Promise<{ tabs: { tabId: number; url: string }[] } | null>;

  // 메모
  getNoteScopes(): Promise<string[]>;
  getNote(scope: string): Promise<NoteStateView | null>;
  appendNote(scope: string, text: string): Promise<NoteWriteView>;
  restoreNote(scope: string, version: number): Promise<NoteWriteView>;

  // 세션
  getSessions(): Promise<SessionStateView>;
  useSession(name: string): Promise<{ name: string; partition: string } | null>;

  // 북마크 메타(AI 힌트)
  getBookmarkMeta(bookmarkId: number): Promise<BookmarkMetaView | null>;
  setBookmarkMeta(
    bookmarkId: number,
    value: {
      intent?: string;
      expectedContent?: string;
      keyFields?: string[];
      agentHints?: string;
    }
  ): Promise<BookmarkMetaWriteView>;

  // 변경 이력
  getTrackedUrls(): Promise<TrackedUrlView[]>;
  getPageHistory(url: string): Promise<SnapshotView[]>;
  getPageDiff(url: string, fromId?: number, toId?: number): Promise<PageDiffView | null>;

  // 결과표
  getResults(threadId: string): Promise<unknown[]>;
  exportResults(threadId: string, format: 'csv' | 'md' | 'json'): Promise<ExportResultView | null>;

  // 워크플로우(M5)
  getWorkflows(): Promise<WorkflowListItem[]>;
  runWorkflow(workflowId: string, inputs: Record<string, unknown>): Promise<WorkflowRunView | null>;
  getWorkflowRuns(): Promise<WorkflowRunView[]>;
  promoteThread(threadId: string): Promise<WorkflowDraftView | null>;
  checkWorkflow(source: string): Promise<WorkflowCheckView>;
  saveWorkflow(source: string): Promise<WorkflowCheckView & { file: string | null }>;
  getSchedules(): Promise<ScheduleView[]>;
  addSchedule(input: {
    id: string;
    workflowId: string;
    cron: string;
    inputs?: Record<string, unknown>;
    description?: string;
  }): Promise<ScheduleView | { error: string }>;
  removeSchedule(id: string): Promise<boolean>;
  fireSchedule(id: string): Promise<WorkflowRunView | null>;

  // 구독 — 반환값을 호출하면 해제된다.
  onStateChanged(listener: (state: BrowserState) => void): () => void;
  onShellChanged(listener: (state: ShellState) => void): () => void;
  onBookmarksChanged(listener: (bookmarks: Bookmark[]) => void): () => void;
  onDownloadsChanged(listener: (downloads: DownloadItem[]) => void): () => void;
  onFocusOmnibox(listener: () => void): () => void;
  onFocusFindBar(listener: () => void): () => void;
  onAiStateChanged(listener: (state: AiState) => void): () => void;
  onPromptRequested(listener: (prompt: PendingPrompt) => void): () => void;
  onApprovalRequested(listener: (request: ApprovalRequestView) => void): () => void;
  onApprovalQueueChanged(listener: (queue: ApprovalRequestView[]) => void): () => void;
  onUndoChanged(listener: (stack: UndoStackView) => void): () => void;
  onThreadsChanged(listener: (threads: ThreadView[]) => void): () => void;
  onInboxChanged(listener: (state: InboxStateView) => void): () => void;
  onCheckpointsChanged(
    listener: (payload: { threadId: string; checkpoints: CheckpointView[] }) => void
  ): () => void;
  onSessionsChanged(listener: (state: SessionStateView) => void): () => void;
  onTrackedUrlsChanged(listener: (urls: TrackedUrlView[]) => void): () => void;
  onWorkflowRunsChanged(listener: (runs: WorkflowRunView[]) => void): () => void;
}
