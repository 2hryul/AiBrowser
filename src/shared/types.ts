/**
 * 셸(렌더러)과 메인이 주고받는 타입.
 * 메인 전용 구현 타입은 여기 두지 않는다. 여기 있는 것은 모두 IPC 로 직렬화되는 값이다.
 */

/** 탭 소유자. M1 까지는 항상 'human'. 'ai' 배지 경로는 M2 에서 쓰인다. */
export type TabOwner = 'human' | 'ai';

export interface TabState {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  owner: TabOwner;
  /** Named Session 이름. M1 은 'default' 고정. */
  sessionName: string;
  /** 고정 탭 — 닫기 버튼이 없고 항상 앞쪽에 모인다. */
  pinned: boolean;
  /** 음소거 상태 */
  muted: boolean;
  /** 지금 소리를 내는 중인지 */
  audible: boolean;
  /** 유휴 언로드된 탭 — 다시 선택하면 복구된다. */
  suspended: boolean;
  /** 읽기 모드로 볼 수 있는 페이지인지 (휴리스틱) */
  readerable: boolean;
  /** 확대 배율 (1 = 100%) */
  zoomFactor: number;
}

/** 세로/가로 탭바 전환 */
export type TabStripOrientation = 'vertical' | 'horizontal';

export interface BrowserState {
  tabs: TabState[];
  activeTabId: number | null;
  orientation: TabStripOrientation;
  /** Ctrl+Shift+T 로 복구할 탭이 있는지 */
  canRestoreClosedTab: boolean;
}

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
}

export interface HistorySuggestion {
  url: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
}

export interface Bookmark {
  id: number;
  title: string;
  url: string;
  /** 크롬에서 가져온 원본 폴더 경로. 직접 추가한 북마크는 빈 문자열. */
  folder: string;
  position: number;
  createdAt: number;
}

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadItem {
  id: number;
  fileName: string;
  savePath: string;
  url: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  /** 완료·취소·중단 시각 */
  endedAt: number | null;
}

/** 옴니박스 제안 한 줄. kind 로 아이콘과 정렬 우선순위가 갈린다. */
export type SuggestionKind = 'url' | 'bookmark' | 'history' | 'search';

export interface OmniboxSuggestion {
  kind: SuggestionKind;
  /** 실제로 이동할 주소 */
  url: string;
  /** 첫 줄에 보이는 값 */
  primary: string;
  /** 둘째 줄(설명) */
  secondary: string;
}

/** 읽기 모드 추출 결과 (Reader.ts 와 공용, get_page_text 가 M2 에서 재사용) */
export interface ReaderArticle {
  title: string;
  byline: string | null;
  excerpt: string | null;
  /** 정제된 본문 HTML */
  content: string;
  /** 태그를 걷어낸 본문 텍스트 */
  textContent: string;
  length: number;
  siteName: string | null;
  lang: string | null;
}

export type ReaderFailure = 'not-readerable' | 'extract-failed' | 'empty-html' | 'no-tab';

export interface ReaderPayload {
  tabId: number;
  url: string;
  article: ReaderArticle | null;
  reason: ReaderFailure | null;
}

/** 페이지 내 찾기 상태 */
export interface FindState {
  query: string;
  matches: number;
  activeMatchOrdinal: number;
}

export type ThemeSource = 'system' | 'light' | 'dark';

/** 셸이 띄우는 내부 화면. 웹 콘텐츠가 아니라 브라우저 크롬의 일부다(ADR 0005). */
export type ShellPanel =
  | 'none'
  | 'history'
  | 'downloads'
  | 'bookmarks'
  | 'reader'
  | 'undo'
  | 'audit'
  | 'policy';

/** 확장 로드 결과 — docs/extensions.md 기록용 */
export interface ExtensionLoadResult {
  name: string;
  path: string;
  ok: boolean;
  /** 로드된 확장의 manifest 이름·버전 */
  manifestName: string | null;
  version: string | null;
  error: string | null;
}

/** 프로필 가져오기 결과. 자격증명 항목이 없다는 것을 형태로 못박는다. */
export interface ProfileImportResult {
  sourceBrowser: 'chrome' | 'edge';
  sourceProfile: string;
  bookmarks: number;
  history: number;
  autofill: number;
  /** 읽으려고 시도조차 하지 않은 파일 목록 — 감사용 */
  skippedCredentialFiles: readonly string[];
  errors: readonly string[];
}

/** 홈 화면 주소. 외부 네트워크 없이 번들 리소스로 서비스한다. */
export const HOME_URL = 'app://home/';

/**
 * 셸 레이아웃 상수 — 메인(웹 콘텐츠 뷰 bounds 계산)과 렌더러(CSS)가 같은 값을 써야
 * 사이드바/툴바와 웹 콘텐츠가 정확히 맞물린다. 단일 출처로 여기에만 둔다.
 */
export const LAYOUT = {
  sidebarWidth: 240,
  toolbarHeight: 48,
  /** 북마크바 높이. 북마크가 하나도 없으면 감춘다. */
  bookmarksBarHeight: 32,
  /** 가로 탭바 높이 (orientation === 'horizontal') */
  horizontalTabStripHeight: 36,
  /** 페이지 내 찾기 바 높이 */
  findBarHeight: 40,
  /** AI 일시정지 띠 높이 */
  pauseBarHeight: 36
} as const;

/** 유휴 탭 언로드 임계 시간 — 30분 */
export const IDLE_UNLOAD_MS = 30 * 60 * 1000;

/** AI 작업 상태 — 셸의 PauseResumeBar 가 이것을 그린다. */
export type AiThreadStatus = 'idle' | 'running' | 'paused' | 'done';

export interface AiState {
  threadId: string;
  status: AiThreadStatus;
  /** 일시정지 사유. status === 'paused' 일 때만 채워진다. */
  pauseReason: string | null;
  pausedTabId: number | null;
  /** AI 가 소유한 탭 id 목록 — 탭바 배지에 쓴다. */
  aiTabIds: number[];
  overlayEnabled: boolean;
  /** MCP 서버 접속 주소. 사람이 Claude Code 에 붙일 때 쓴다. */
  mcpEndpoint: string | null;
}

/** ask_user / request_access 가 사람에게 띄우는 물음. */
export interface PendingPrompt {
  id: string;
  kind: 'ask_user' | 'request_access';
  question: string;
  /** 선택지. 비어 있으면 자유 입력 */
  options: string[];
  /** request_access 의 대상 호스트 */
  host?: string;
  createdAt: number;
}

// ── M3 제어 계층 ──

export type ApprovalActionKind =
  | 'write_click'
  | 'form_submit'
  | 'download'
  | 'upload'
  | 'javascript'
  | 'site_first_visit'
  | 'tool';

export type GrantScope = 'once' | 'thread' | 'domain';

/** 승인 다이얼로그가 그리는 요청. */
export interface ApprovalRequestView {
  id: string;
  subject: string;
  tool: string;
  action: ApprovalActionKind;
  host: string;
  reason: string;
  targetText: string | null;
  irreversible: boolean;
  runId: string;
  createdAt: number;
}

export interface UndoRecordView {
  id: string;
  runId: string;
  tool: string;
  describe: string;
  createdAt: number;
  undone: boolean;
  sealed: boolean;
  sealedReason: string | null;
}

export interface PolicyGrantView {
  subject: string;
  host: string;
  scope: GrantScope;
  threadId?: string;
  grantedAt: number;
}

export interface PolicyView {
  locked: boolean;
  sites: { default: 'allow' | 'ask' | 'deny'; hosts: Record<string, 'allow' | 'ask' | 'deny'> };
  deny: { hosts: string[]; tools: string[] };
  tools: Record<string, 'allow' | 'ask' | 'deny'>;
  grants: PolicyGrantView[];
  retentionDays: number;
}

/** 감사 로그 한 줄 — StepLogPlayer 가 그린다. */
export interface AuditEntryView {
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

/** 되돌리기 시도 결과 — 실패 사유를 사람이 읽을 문장으로 함께 돌려준다. */
export type UndoOutcomeView =
  | { ok: true; record: UndoRecordView }
  | { ok: false; reason: 'empty' | 'sealed' | 'not_found' | 'failed'; message: string };

export interface UndoStackView {
  runId: string;
  records: UndoRecordView[];
}

export interface AuditReadView {
  runId: string;
  file: string | null;
  entries: AuditEntryView[];
}
