import type { BrowserState } from './types';

/**
 * preload 가 `window.helm` 으로 노출하는 표면.
 * 메인/preload(Node)와 렌더러(DOM)가 서로의 소스를 참조하지 않도록 계약만 여기 둔다.
 */
export interface HelmApi {
  getState(): Promise<BrowserState>;
  createTab(url?: string): Promise<number>;
  closeTab(id: number): Promise<boolean>;
  selectTab(id: number): Promise<boolean>;
  navigate(id: number, input: string): Promise<boolean>;
  goBack(id: number): Promise<boolean>;
  goForward(id: number): Promise<boolean>;
  reload(id: number): Promise<boolean>;
  /** 상태 구독. 반환값을 호출하면 구독을 해제한다. */
  onStateChanged(listener: (state: BrowserState) => void): () => void;
  /** Ctrl+L 등으로 메인이 주소창 포커스를 요청할 때. */
  onFocusOmnibox(listener: () => void): () => void;
}
