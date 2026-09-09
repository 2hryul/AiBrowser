/**
 * IPC 채널 화이트리스트. preload는 이 목록에 없는 채널을 노출하지 않는다.
 * 문자열을 여기 한 곳에만 두어 메인/preload 양쪽의 오타를 컴파일 단계에서 잡는다.
 */
export const IPC = {
  /** 렌더러 → 메인 (invoke) */
  tabsCreate: 'helm:tabs:create',
  tabsClose: 'helm:tabs:close',
  tabsSelect: 'helm:tabs:select',
  tabsNavigate: 'helm:tabs:navigate',
  tabsGoBack: 'helm:tabs:go-back',
  tabsGoForward: 'helm:tabs:go-forward',
  tabsReload: 'helm:tabs:reload',
  stateGet: 'helm:state:get',
  /** 메인 → 렌더러 (send) */
  stateChanged: 'helm:state:changed',
  focusOmnibox: 'helm:shell:focus-omnibox'
} as const;

export type IpcInvokeChannel =
  | typeof IPC.tabsCreate
  | typeof IPC.tabsClose
  | typeof IPC.tabsSelect
  | typeof IPC.tabsNavigate
  | typeof IPC.tabsGoBack
  | typeof IPC.tabsGoForward
  | typeof IPC.tabsReload
  | typeof IPC.stateGet;
