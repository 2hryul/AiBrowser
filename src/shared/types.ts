/**
 * 셸(렌더러)과 메인이 주고받는 최소 타입.
 * M0 범위: 탭 목록과 활성 탭만 공유한다. AI/도구 관련 필드는 여기 넣지 않는다.
 */

/** 탭 소유자. M0에서는 항상 'human'이지만, 배지 렌더링 경로를 미리 열어둔다. */
export type TabOwner = 'human' | 'ai';

export interface TabState {
  id: number;
  title: string;
  url: string;
  /** 주소창에 표시할 값. 사용자가 타이핑 중이면 렌더러가 별도 관리한다. */
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  owner: TabOwner;
  /** Named Session 이름. M0은 'default' 고정. */
  sessionName: string;
}

export interface BrowserState {
  tabs: TabState[];
  activeTabId: number | null;
}

/** 홈 화면 주소. 외부 네트워크 없이 번들 리소스로 서비스한다. */
export const HOME_URL = 'app://home/';

/**
 * 셸 레이아웃 상수 — 메인(웹 콘텐츠 뷰 bounds 계산)과 렌더러(CSS)가 같은 값을 써야
 * 사이드바/툴바와 웹 콘텐츠가 정확히 맞물린다. 단일 출처로 여기에만 둔다.
 */
export const LAYOUT = {
  sidebarWidth: 240,
  toolbarHeight: 48
} as const;
