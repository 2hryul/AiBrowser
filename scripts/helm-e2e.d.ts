/**
 * HELM_E2E=1 일 때 메인 프로세스에 노출되는 테스트 훅의 공용 선언.
 *
 * 테스트 파일마다 따로 declare global 을 쓰면 선언이 충돌하므로 한 곳에 모은다.
 * 이 훅은 제품 기능이 아니라 검증 통로다 — 웹 콘텐츠에는 노출되지 않는다.
 */

interface HelmTabState {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  pinned: boolean;
  suspended: boolean;
  readerable: boolean;
  owner: 'human' | 'ai';
}

interface HelmBrowserState {
  tabs: HelmTabState[];
  activeTabId: number | null;
  orientation: 'vertical' | 'horizontal';
  canRestoreClosedTab: boolean;
}

interface HelmTabManagerHook {
  createTab: (url?: string, owner?: 'human' | 'ai', sessionName?: string) => number;
  closeTab: (id: number) => void;
  selectTab: (id: number) => void;
  navigate: (id: number, input: string) => boolean;
  moveTab: (id: number, toIndex: number) => boolean;
  setPinned: (id: number, pinned: boolean) => boolean;
  restoreClosedTab: () => number | null;
  unloadIdleTabs: (now?: number) => number;
  indexOf: (id: number) => number;
  ownerOf: (id: number) => 'human' | 'ai' | null;
  getState: () => HelmBrowserState;
  getWebContents: (id: number) => Electron.WebContents | null;
  getTabBounds: (id: number) => Electron.Rectangle | null;
  expectedContentBounds: () => Electron.Rectangle;
  isContentHidden: () => boolean;
  activeTabId: number | null;
}

interface HelmPendingPrompt {
  id: string;
  kind: 'ask_user' | 'request_access';
  question: string;
  options: string[];
  host?: string;
}

// ── M3 제어 계층 ──

interface HelmApprovalRequest {
  id: string;
  subject: string;
  tool: string;
  action:
    | 'write_click'
    | 'form_submit'
    | 'download'
    | 'upload'
    | 'javascript'
    | 'site_first_visit'
    | 'tool';
  host: string;
  reason: string;
  targetText: string | null;
  irreversible: boolean;
  runId: string;
  createdAt: number;
}

interface HelmUndoRecord {
  id: string;
  runId: string;
  tool: string;
  describe: string;
  createdAt: number;
  undone: boolean;
  sealed: boolean;
  sealedReason: string | null;
}

interface HelmAuditEntry {
  ts: number;
  source: string;
  runId: string;
  tabId: number | null;
  url: string | null;
  tool: string;
  args: unknown;
  targetText: string | null;
  result: unknown;
  durationMs: number;
  screenshotPath: string | null;
  policyDecision: 'allow' | 'deny' | 'ask';
  grantScope: string | null;
  review: boolean;
  error: string | null;
}

interface HelmPolicyHook {
  snapshot: () => {
    locked: boolean;
    sites: { default: string; hosts: Record<string, string> };
    deny: { hosts: string[]; tools: string[] };
    tools: Record<string, string>;
    grants: { subject: string; host: string; scope: string; threadId?: string; grantedAt: number }[];
    /** M4c — 마법사에 저장 비밀번호 항목을 보여 줄지 */
    allowPasswordImport: boolean;
    /** M4c — 외부 브라우저 폴백을 허용할 호스트 화이트리스트 */
    externalLoginHosts: string[];
    retentionDays: number;
  };
  isLocked: () => boolean;
  listGrants: () => { subject: string; host: string; scope: string; grantedAt: number }[];
  setDeny: (hosts: string[], tools: string[]) => boolean;
  setSiteDecision: (host: string, decision: 'allow' | 'ask' | 'deny') => boolean;
  markVisited: (host: string) => void;
  hasVisited: (host: string) => boolean;
}

interface HelmUndoHook {
  list: (runId: string) => HelmUndoRecord[];
  undo: (
    runId: string,
    id?: string
  ) => Promise<
    { ok: true; record: HelmUndoRecord } | { ok: false; reason: string; message: string }
  >;
  seal: (runId: string, reason: string) => number;
  clear: (runId: string) => void;
}

interface HelmAuditHook {
  file: string;
  read: () => HelmAuditEntry[];
}

interface HelmAiState {
  threadId: string;
  status: 'idle' | 'running' | 'paused' | 'done';
  pauseReason: string | null;
  pausedTabId: number | null;
  aiTabIds: number[];
  overlayEnabled: boolean;
  mcpEndpoint: string | null;
}

interface HelmHandoffHook {
  pause: (threadId: string, tabId: number, reason: string) => void;
  resume: (threadId: string) => { resumed: true; note: string };
  takeOver: (threadId: string) => void;
  statusOf: (threadId: string) => string;
  isAiTab: (tabId: number) => boolean;
  ownerOf: (tabId: number) => string | null;
}

interface HelmOverlayBox {
  x: number;
  y: number;
  width: number;
  height: number;
  role?: string;
}

interface HelmOverlayState {
  badge?: string;
  boxes?: HelmOverlayBox[];
  cursor?: { x: number; y: number };
}

interface HelmOverlayHook {
  isVisible: () => boolean;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  show: (state: HelmOverlayState, holdMs?: number) => Promise<void>;
  hide: () => void;
  lastState: () => { state: HelmOverlayState; at: number } | null;
  capture: () => Promise<{ base64: string; width: number; height: number } | null>;
}

interface HelmExtensionLoadResult {
  name: string;
  ok: boolean;
  manifestName: string | null;
  version: string | null;
  error: string | null;
  unsupportedPermissions: string[];
}

// ── M4a 지속성 ──

interface HelmThread {
  id: string;
  title: string;
  status: string;
  sessionName: string;
  stepCount: number;
  stepLimit: number;
  closedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

interface HelmThreadMessage {
  id: number;
  threadId: string;
  seq: number;
  role: string;
  text: string;
  tool: string | null;
  args: unknown;
  result: unknown;
  createdAt: number;
}

interface HelmCheckpoint {
  id: number;
  threadId: string;
  name: string;
  note: string;
  trigger: string;
  messageIndex: number;
  payload: {
    tabs: { url: string; sessionName: string; scrollY: number; tabId?: number; title?: string }[];
    results: unknown[];
    noteVersions: { scope: string; version: number }[];
    cursor: Record<string, unknown>;
  };
  createdAt: number;
}

interface HelmInboxItem {
  id: number;
  kind: string;
  threadId: string | null;
  title: string;
  summary: string;
  evidencePath: string | null;
  createdAt: number;
  readAt: number | null;
}

interface HelmSessionInfo {
  name: string;
  partition: string;
  loginMethod: string | null;
  loggedInAt: number | null;
  createdAt: number;
  lastUsedAt: number;
}

interface HelmSessionStoreHook {
  list: () => HelmSessionInfo[];
  get: (name: string) => HelmSessionInfo | null;
  ensure: (name: string) => HelmSessionInfo | null;
  use: (name: string) => HelmSessionInfo | null;
  currentName: () => string;
  partitionOf: (name: string) => string;
  recordLogin: (name: string, method: string, verifiedHost?: string) => HelmSessionInfo | null;
  meta: (name: string) => { loginMethod: string | null; loggedInAt: number | null } | null;
}

interface HelmThreadStoreHook {
  create: (input: { id?: string; title?: string; sessionName?: string; stepLimit?: number }) => HelmThread;
  get: (id: string) => HelmThread | null;
  list: (limit?: number) => HelmThread[];
  setStatus: (id: string, status: string, closedReason?: string) => boolean;
  append: (
    threadId: string,
    input: { role: string; text?: string; tool?: string; args?: unknown; result?: unknown }
  ) => HelmThreadMessage;
  messages: (threadId: string, fromSeq?: number) => HelmThreadMessage[];
  messageCount: (threadId: string) => number;
  recoverInterrupted: () => number;
}

interface HelmCheckpointStoreHook {
  list: (threadId: string, limit?: number) => HelmCheckpoint[];
  get: (id: number) => HelmCheckpoint | null;
  latest: (threadId: string) => HelmCheckpoint | null;
  count: (threadId: string) => number;
}

interface HelmInboxHook {
  list: (options?: { unreadOnly?: boolean; threadId?: string; limit?: number }) => HelmInboxItem[];
  post: (input: { kind: string; title: string; threadId?: string; summary?: string }) => HelmInboxItem;
  unreadCount: () => number;
  markRead: (id: number) => boolean;
  markAllRead: () => number;
}

interface HelmNoteStoreHook {
  read: (scope: string) => { scope: string; version: number; text: string } | null;
  history: (scope: string) => { scope: string; version: number; text: string }[];
  append: (scope: string, text: string) => { ok: boolean; reason?: string; truncated?: boolean };
  scopes: () => string[];
  latestVersion: (scope: string) => number;
}

interface HelmChangeTrackerHook {
  snapshot: (
    url: string,
    title: string,
    text: string
  ) => { snapshot: { id: number; bytes: number; truncated: boolean }; created: boolean };
  history: (url: string, limit?: number) => { id: number; capturedAt: number; bytes: number }[];
  count: (url: string) => number;
  diff: (
    url: string,
    fromId?: number,
    toId?: number
  ) => { changedWords: number; addedWords: number; removedWords: number; coarse: boolean } | null;
  trackedUrls: () => { url: string; snapshots: number }[];
}

interface HelmBookmarkMetaHook {
  get: (bookmarkId: number) => {
    intent: string;
    expectedContent: string;
    keyFields: string[];
    agentHints: string;
  } | null;
  set: (
    bookmarkId: number,
    input: { intent?: string; expectedContent?: string; keyFields?: string[]; agentHints?: string }
  ) => { ok: boolean; reason?: string };
}

// ── M5 검증 계층 ──

interface HelmWorkflowListItem {
  id: string;
  version: number;
  description: string | null;
  file: string;
  error: string | null;
}

interface HelmWorkflowOutcome {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  inputs: Record<string, unknown>;
  verdict: 'PASS' | 'REVIEW' | 'FAIL' | 'ADAPTER_BROKEN';
  status: string;
  sources: { step: string; adapter: string | null; source: string; note: string | null }[];
  outputs: Record<string, unknown>;
  oracles: { rule: string; ruleVersion: number; verdict: string; ok: boolean; message: string }[];
  evidence: { runId: string; dir: string; files: string[]; maskedFields: number; screenshots: number };
  durationMs: number;
}

interface HelmScheduleEntry {
  id: string;
  workflowId: string;
  cron: string;
  lastRunAt: number | null;
  lastVerdict: string | null;
  runCount: number;
}

interface HelmSchedulerHook {
  list: () => HelmScheduleEntry[];
  add: (input: { id: string; workflowId: string; cron: string; inputs?: Record<string, unknown> }) => HelmScheduleEntry;
  remove: (id: string) => boolean;
  fire: (id: string) => Promise<HelmWorkflowOutcome | null>;
  stopAll: () => void;
}

interface HelmWorkflowDraft {
  yaml: string;
  workflowId: string;
  todo: string[];
  skipped: { tool: string; reason: string }[];
  steps: { id: string; adapter?: string; op?: string; as: string }[];
  inputs: string[];
}

interface HelmAgentOutcome {
  status: 'done' | 'failed' | 'paused' | 'handoff' | 'stopped';
  steps: number;
  llmCalls: number;
  macroHits: number;
  rows: number;
  duplicates: number;
  summary: string;
  reason: string | null;
}

interface HelmE2EHook {
  // M0/M1
  getTabManager: () => HelmTabManagerHook | null;
  getWindow: () => Electron.BaseWindow | null;
  getShell: () => Electron.WebContentsView | null;
  getShellState: () => { panel: string; find: unknown; theme: string; darkMode: boolean };
  getHistory: () => { clear: () => void; count: () => number } | null;
  getBookmarks: () => { count: () => number } | null;
  getAutofill: () => { count: () => number } | null;
  getDownloads: () => {
    list: () => { id: number; fileName: string; state: string; savePath: string }[];
  } | null;
  getSession: () => Electron.Session;
  setPanel: (panel: string) => void;
  loadExtensionsFrom: (dirs: { name: string; path: string }[]) => Promise<HelmExtensionLoadResult[]>;
  downloadDir: string;
  sessionPartition: string;
  layout: Record<string, number>;

  // M2
  getOverlay: () => HelmOverlayHook | null;
  overlayCapture: () => Promise<{ base64: string; width: number; height: number } | null>;
  overlayLastState: () => { state: HelmOverlayState; at: number } | null;
  getHandoff: () => HelmHandoffHook | null;
  getAiState: () => HelmAiState;
  getMcpEndpoint: () => { url: string; port: number; token: string; addCommand: string } | null;
  callTool: (threadId: string, name: string, args: unknown) => Promise<unknown>;
  toolNames: () => Promise<string[]>;
  pendingPrompts: () => HelmPendingPrompt[];
  answerPrompt: (id: string, answer: string) => boolean;

  // M3
  getPolicy: () => HelmPolicyHook | null;
  getUndo: () => HelmUndoHook | null;
  undoActiveRunId: () => string;
  getAudit: () => HelmAuditHook | null;
  runId: string;
  approvalQueue: () => HelmApprovalRequest[];
  answerApproval: (id: string, scope: 'once' | 'thread' | 'domain' | null) => boolean;
  submittedDocs: () => Promise<string[]>;
  resetSubmitted: () => Promise<void>;
  piiSamples: () => Promise<{ employeeNo: string; phone: string; email: string }[]>;
  portalTeams: () => Promise<string[]>;
  wikiDefects: () => Promise<string[]>;

  // M4b
  agentInfo: () => {
    available: boolean;
    provider: 'openai' | 'anthropic' | null;
    model: string | null;
    macros: number;
  };
  runAgent: (
    threadId: string,
    instruction: string,
    options?: { keyColumns?: string[]; expectedCount?: number | null }
  ) => Promise<HelmAgentOutcome | null>;
  stopAgent: (threadId: string) => boolean;
  clearMacros: () => void;
  noteProposal: () => { threadId: string; host: string; text: string } | null;
  acceptNoteProposal: () => unknown;

  // M4a
  getSessionStore: () => HelmSessionStoreHook | null;
  getThreadStore: () => HelmThreadStoreHook | null;
  getCheckpointStore: () => HelmCheckpointStoreHook | null;
  getInbox: () => HelmInboxHook | null;
  getNoteStore: () => HelmNoteStoreHook | null;
  getBookmarkMeta: () => HelmBookmarkMetaHook | null;
  getChangeTracker: () => HelmChangeTrackerHook | null;
  exportResults: (
    threadId: string,
    format: 'csv' | 'md' | 'json'
  ) => { filePath: string; rows: number; bytes: number } | null;
  getResults: (threadId: string) => unknown[];
  saveCheckpointFor: (
    threadId: string,
    input: {
      name: string;
      trigger: string;
      note?: string;
      cursor?: Record<string, unknown>;
      results?: unknown[];
    }
  ) => Promise<HelmCheckpoint>;
  restoreCheckpointFor: (
    id: number
  ) => Promise<{ tabs: { tabId: number; url: string; sessionName: string }[] }>;
  approvalDocs: () => Promise<{ id: string; title: string; amount: number }[]>;

  // M5
  evidenceBaseDir: string;
  listWorkflows: () => HelmWorkflowListItem[];
  runWorkflow: (
    workflowId: string,
    inputs: Record<string, unknown>,
    runId?: string
  ) => Promise<HelmWorkflowOutcome | null>;
  workflowRuns: () => unknown[];
  promoteThreadDraft: (threadId: string) => HelmWorkflowDraft | null;
  checkWorkflowDraft: (source: string) => { ok: boolean; issues: string[]; id: string | null };
  getScheduler: () => HelmSchedulerHook | null;
  addSchedule: (input: {
    id: string;
    workflowId: string;
    cron: string;
    inputs?: Record<string, unknown>;
  }) => HelmScheduleEntry | null;
  fireSchedule: (id: string) => Promise<unknown | null>;
  setSettleApi: (enabled: boolean) => Promise<boolean>;
}

declare global {
  var __helm: HelmE2EHook | undefined;
}

export {};
