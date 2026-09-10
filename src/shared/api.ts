import type {
  Bookmark,
  BrowserState,
  DownloadItem,
  ExtensionLoadResult,
  FindState,
  HistoryEntry,
  OmniboxSuggestion,
  ProfileImportResult,
  ReaderPayload,
  ShellPanel,
  TabStripOrientation,
  ThemeSource
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

  // 구독 — 반환값을 호출하면 해제된다.
  onStateChanged(listener: (state: BrowserState) => void): () => void;
  onShellChanged(listener: (state: ShellState) => void): () => void;
  onBookmarksChanged(listener: (bookmarks: Bookmark[]) => void): () => void;
  onDownloadsChanged(listener: (downloads: DownloadItem[]) => void): () => void;
  onFocusOmnibox(listener: () => void): () => void;
  onFocusFindBar(listener: () => void): () => void;
}
