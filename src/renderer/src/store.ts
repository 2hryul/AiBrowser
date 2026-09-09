import { create } from 'zustand';
import type { BrowserState, TabState } from '../../shared/types';

interface ShellStore {
  tabs: TabState[];
  activeTabId: number | null;
  /** 주소창 입력값. 사용자가 타이핑 중이면 실제 URL 대신 이 값을 보여준다. */
  omniboxDraft: string | null;
  /** 정규화 실패 등 주소창 오류 표시. */
  omniboxError: boolean;
  apply: (state: BrowserState) => void;
  setDraft: (value: string | null) => void;
  setError: (value: boolean) => void;
}

export const useShellStore = create<ShellStore>((set) => ({
  tabs: [],
  activeTabId: null,
  omniboxDraft: null,
  omniboxError: false,
  // 메인이 보낸 상태로 갈아끼울 때, 타이핑 중인 초안은 지운다(탭이 바뀌었을 수 있음).
  apply: (state) => set({ tabs: state.tabs, activeTabId: state.activeTabId, omniboxDraft: null }),
  setDraft: (value) => set({ omniboxDraft: value, omniboxError: false }),
  setError: (value) => set({ omniboxError: value })
}));

export function selectActiveTab(store: ShellStore): TabState | null {
  return store.tabs.find((t) => t.id === store.activeTabId) ?? null;
}
