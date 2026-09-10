/**
 * IPC 채널 화이트리스트. preload는 이 목록에 없는 채널을 노출하지 않는다.
 * 문자열을 여기 한 곳에만 두어 메인/preload 양쪽의 오타를 컴파일 단계에서 잡는다.
 */
export const IPC = {
  // ── 탭 ──────────────────────────────────────────────
  tabsCreate: 'helm:tabs:create',
  tabsClose: 'helm:tabs:close',
  tabsSelect: 'helm:tabs:select',
  tabsNavigate: 'helm:tabs:navigate',
  tabsGoBack: 'helm:tabs:go-back',
  tabsGoForward: 'helm:tabs:go-forward',
  tabsReload: 'helm:tabs:reload',
  tabsMove: 'helm:tabs:move',
  tabsSetPinned: 'helm:tabs:set-pinned',
  tabsSetMuted: 'helm:tabs:set-muted',
  tabsRestoreClosed: 'helm:tabs:restore-closed',
  tabsSetOrientation: 'helm:tabs:set-orientation',

  // ── 상태 ────────────────────────────────────────────
  stateGet: 'helm:state:get',
  stateChanged: 'helm:state:changed',
  shellGet: 'helm:shell:get',
  shellChanged: 'helm:shell:changed',

  // ── 주소창 ──────────────────────────────────────────
  omniboxSuggest: 'helm:omnibox:suggest',

  // ── 히스토리 ────────────────────────────────────────
  historyList: 'helm:history:list',
  historyRemove: 'helm:history:remove',
  historyClear: 'helm:history:clear',

  // ── 북마크 ──────────────────────────────────────────
  bookmarksList: 'helm:bookmarks:list',
  bookmarksAdd: 'helm:bookmarks:add',
  bookmarksRemove: 'helm:bookmarks:remove',
  bookmarksRemoveByUrl: 'helm:bookmarks:remove-by-url',
  bookmarksRename: 'helm:bookmarks:rename',
  bookmarksChanged: 'helm:bookmarks:changed',

  // ── 다운로드 ────────────────────────────────────────
  downloadsList: 'helm:downloads:list',
  downloadsCancel: 'helm:downloads:cancel',
  downloadsPause: 'helm:downloads:pause',
  downloadsResume: 'helm:downloads:resume',
  downloadsShowInFolder: 'helm:downloads:show-in-folder',
  downloadsOpen: 'helm:downloads:open',
  downloadsRemove: 'helm:downloads:remove',
  downloadsClearCompleted: 'helm:downloads:clear-completed',
  downloadsChanged: 'helm:downloads:changed',
  downloadStart: 'helm:downloads:start',

  // ── 읽기 모드 ───────────────────────────────────────
  readerRead: 'helm:reader:read',

  // ── 페이지 도구 ─────────────────────────────────────
  findStart: 'helm:find:start',
  findStop: 'helm:find:stop',
  pagePrint: 'helm:page:print',
  pageSavePdf: 'helm:page:save-pdf',
  pageToggleDevTools: 'helm:page:toggle-devtools',
  pageSetZoom: 'helm:page:set-zoom',

  // ── 테마 ────────────────────────────────────────────
  themeSet: 'helm:theme:set',
  themeCycle: 'helm:theme:cycle',

  // ── 셸 패널 ─────────────────────────────────────────
  panelOpen: 'helm:panel:open',

  // ── 프로필 가져오기 ─────────────────────────────────
  importDiscover: 'helm:import:discover',
  importRun: 'helm:import:run',

  // ── AI 코브라우징 / Handoff ─────────────────────────
  aiStateGet: 'helm:ai:state:get',
  aiStateChanged: 'helm:ai:state:changed',
  aiResume: 'helm:ai:resume',
  aiTakeOver: 'helm:ai:take-over',
  aiOverlayToggle: 'helm:ai:overlay-toggle',

  // ── 사람에게 묻기 (ask_user / request_access) ───────
  promptRequested: 'helm:prompt:requested',
  promptAnswer: 'helm:prompt:answer',

  // ── 승인 (Policy / Approval) ────────────────────────
  approvalRequested: 'helm:approval:requested',
  approvalQueueChanged: 'helm:approval:queue-changed',
  approvalAnswer: 'helm:approval:answer',
  approvalQueueGet: 'helm:approval:queue-get',

  // ── 정책 설정 화면 ──────────────────────────────────
  policyGet: 'helm:policy:get',
  policyRevokeGrant: 'helm:policy:revoke-grant',
  policySetDeny: 'helm:policy:set-deny',
  policySetSite: 'helm:policy:set-site',

  // ── 되돌리기 ────────────────────────────────────────
  undoGet: 'helm:undo:get',
  undoChanged: 'helm:undo:changed',
  undoApply: 'helm:undo:apply',

  // ── 감사 로그 재생 ──────────────────────────────────
  auditRead: 'helm:audit:read',
  auditOpenUrl: 'helm:audit:open-url',

  // ── 메인 → 렌더러 요청 ──────────────────────────────
  focusOmnibox: 'helm:shell:focus-omnibox',
  focusFindBar: 'helm:shell:focus-findbar'
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
