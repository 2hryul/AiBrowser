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
  createTab: (url?: string, owner?: 'human' | 'ai') => number;
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
}

declare global {
  var __helm: HelmE2EHook | undefined;
}

export {};
