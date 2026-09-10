import { create } from 'zustand';
import type { ShellState } from '../../shared/api';
import type {
  AiState,
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
