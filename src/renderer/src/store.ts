import { create } from 'zustand';
import type { ShellState } from '../../shared/api';
import type {
  AiState,
  ApprovalRequestView,
  Bookmark,
  BrowserState,
  DownloadItem,
  OmniboxSuggestion,
  PendingPrompt,
  TabState
} from '../../shared/types';

const EMPTY_SHELL: ShellState = {
  panel: 'none',
  find: null,
  theme: 'system',
  darkMode: false,
  bookmarksBarVisible: false,
  extensions: []
};

const IDLE_AI: AiState = {
  threadId: '',
  status: 'idle',
  pauseReason: null,
  pausedTabId: null,
  aiTabIds: [],
  overlayEnabled: true,
  mcpEndpoint: null
};

interface ShellStore {
  tabs: TabState[];
  activeTabId: number | null;
  orientation: BrowserState['orientation'];
  canRestoreClosedTab: boolean;
  shell: ShellState;
  bookmarks: Bookmark[];
  downloads: DownloadItem[];
  ai: AiState;
  /** 사람 답을 기다리는 물음. 한 번에 하나만 띄운다. */
  prompts: PendingPrompt[];
  /** 승인 대기 큐. 메인이 진실이고 셸은 그대로 그린다. */
  approvals: ApprovalRequestView[];
  /** 관리자 잠금이면 승인 범위를 once 로 제한한다. */
  policyLocked: boolean;

  /**
   * 승격 대기 중인 스레드 id (M5).
   * 스레드 패널에서 "워크플로우로 승격" 을 누르면 여기에 담고 워크플로우 패널로 넘긴다.
   */
  promoteThreadId: string | null;

  /** 주소창 입력값. 타이핑 중이면 실제 URL 대신 이 값을 보여준다. */
  omniboxDraft: string | null;
  omniboxError: boolean;
  suggestions: OmniboxSuggestion[];
  /** 키보드로 고른 제안 인덱스. -1 이면 입력값 그대로 이동. */
  suggestionIndex: number;

  applyBrowserState: (state: BrowserState) => void;
  applyShellState: (state: ShellState) => void;
  setBookmarks: (bookmarks: Bookmark[]) => void;
  setAiState: (ai: AiState) => void;
  addPrompt: (prompt: PendingPrompt) => void;
  removePrompt: (id: string) => void;
  setApprovals: (queue: ApprovalRequestView[]) => void;
  addApproval: (request: ApprovalRequestView) => void;
  removeApproval: (id: string) => void;
  setPolicyLocked: (locked: boolean) => void;
  setPromoteThreadId: (threadId: string | null) => void;
  setDownloads: (downloads: DownloadItem[]) => void;
  setDraft: (value: string | null) => void;
  setError: (value: boolean) => void;
  setSuggestions: (suggestions: OmniboxSuggestion[]) => void;
  moveSuggestion: (delta: number) => void;
  resetOmnibox: () => void;
}

export const useShellStore = create<ShellStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  orientation: 'vertical',
  canRestoreClosedTab: false,
  shell: EMPTY_SHELL,
  bookmarks: [],
  downloads: [],
  ai: IDLE_AI,
  prompts: [],
  approvals: [],
  policyLocked: false,
  promoteThreadId: null,

  omniboxDraft: null,
  omniboxError: false,
  suggestions: [],
  suggestionIndex: -1,

  applyBrowserState: (state) =>
    set({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      orientation: state.orientation,
      canRestoreClosedTab: state.canRestoreClosedTab
    }),

  applyShellState: (state) => set({ shell: state }),
  setBookmarks: (bookmarks) => set({ bookmarks }),
  setAiState: (ai) => set({ ai }),
  addPrompt: (prompt) =>
    set((state) =>
      state.prompts.some((item) => item.id === prompt.id)
        ? state
        : { prompts: [...state.prompts, prompt] }
    ),
  removePrompt: (id) => set((state) => ({ prompts: state.prompts.filter((item) => item.id !== id) })),
  setApprovals: (queue) => set({ approvals: queue }),
  addApproval: (request) =>
    set((state) =>
      state.approvals.some((item) => item.id === request.id)
        ? state
        : { approvals: [...state.approvals, request] }
    ),
  removeApproval: (id) =>
    set((state) => ({ approvals: state.approvals.filter((item) => item.id !== id) })),
  setPolicyLocked: (locked) => set({ policyLocked: locked }),
  setPromoteThreadId: (threadId) => set({ promoteThreadId: threadId }),
  setDownloads: (downloads) => set({ downloads }),

  setDraft: (value) =>
    set({
      omniboxDraft: value,
      omniboxError: false,
      // 입력이 지워지면 제안도 함께 접는다.
      ...(value === null || value.trim() === '' ? { suggestions: [], suggestionIndex: -1 } : {})
    }),

  setError: (value) => set({ omniboxError: value }),
  setSuggestions: (suggestions) => set({ suggestions, suggestionIndex: -1 }),

  moveSuggestion: (delta) => {
    const { suggestions, suggestionIndex } = get();
    if (suggestions.length === 0) return;
    // -1(입력값 그대로) 과 제안 목록 사이를 순환한다.
    const span = suggestions.length + 1;
    const next = ((suggestionIndex + 1 + delta + span) % span) - 1;
    set({ suggestionIndex: next });
  },

  resetOmnibox: () => set({ omniboxDraft: null, omniboxError: false, suggestions: [], suggestionIndex: -1 })
}));

export function selectActiveTab(store: ShellStore): TabState | null {
  return store.tabs.find((t) => t.id === store.activeTabId) ?? null;
}
