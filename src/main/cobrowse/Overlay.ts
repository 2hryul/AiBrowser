import { WebContentsView, type BaseWindow, type Rectangle } from 'electron';

/**
 * 코브라우징 오버레이 — AI 가 무엇을 건드리는지 사람이 보게 한다.
 *
 * 페이지 DOM 에 아무것도 주입하지 않는다(GOAL-M2 CONSTRAINTS). 별도의 투명 WebContentsView 를
 * 웹 콘텐츠 위에 얹고, 그 안에서만 그린다. 오버레이 페이지는 우리 번들(app://overlay/)이라
 * preload 없이 executeJavaScript 로 제어한다.
 *
 * 평소에는 숨겨 둔다. WebContentsView 에는 마우스 통과(pointer pass-through) API 가 없어서
 * 계속 띄워 두면 사람이 페이지를 클릭할 수 없기 때문이다. AI 동작 순간에만 잠깐 보인다.
 */

export interface HighlightBox {
  x: number;
  y: number;
  width: number;
  height: number;
  role?: string;
}

export interface OverlayState {
  badge?: string;
  boxes?: HighlightBox[];
  cursor?: { x: number; y: number };
}

/** 하이라이트를 띄워 두는 시간. 사람이 인지할 만큼 짧게. */
export const OVERLAY_HOLD_MS = 220;

export class Overlay {
  private readonly window: BaseWindow;
  private view: WebContentsView | null = null;
  private ready = false;
  private hideTimer: NodeJS.Timeout | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  /** 오버레이 사용 여부. 설정에서 끌 수 있다(기본 켜짐). */
  private enabled = true;
  /** 마지막으로 그린 내용. "클릭 직전에 무엇을 표시했는가" 를 검증할 수 있게 남긴다. */
  private lastShown: { state: OverlayState; at: number } | null = null;

  constructor(window: BaseWindow) {
    this.window = window;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.hide();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 웹 콘텐츠 영역과 같은 사각형에 얹는다. 탭 레이아웃이 바뀌면 다시 호출한다. */
  setBounds(bounds: Rectangle): void {
    this.bounds = bounds;
    this.view?.setBounds(bounds);
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        transparent: true
      }
    });

    view.setBackgroundColor('#00000000');
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds);
    view.setVisible(false);

    view.webContents.once('did-finish-load', () => {
      this.ready = true;
    });
    void view.webContents.loadURL('app://overlay/');

    this.view = view;
    return view;
  }

  /** 오버레이를 탭 뷰보다 위로 올린다. 새 탭이 생기면 z-순서가 밀리므로 다시 부른다. */
  raise(): void {
    if (!this.view) return;
    this.window.contentView.removeChildView(this.view);
    this.window.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
  }

  /**
   * 상태를 그리고 잠깐 보여준다.
   * @param holdMs 유지 시간. 0 이면 명시적으로 hide 할 때까지 유지한다.
   */
  async show(state: OverlayState, holdMs = OVERLAY_HOLD_MS): Promise<void> {
    if (!this.enabled) return;

    const view = this.ensureView();
    await this.waitReady(view);

    try {
      await view.webContents.executeJavaScript(
        `window.helmOverlay && window.helmOverlay.render(${JSON.stringify(state)})`
      );
    } catch (error) {
      console.warn('[Overlay] 렌더 실패', error);
      return;
    }

    this.lastShown = { state, at: Date.now() };
    view.setVisible(true);
    this.raiseWithoutReset();

    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (holdMs > 0) {
      this.hideTimer = setTimeout(() => this.hide(), holdMs);
      this.hideTimer.unref?.();
    }
  }

  /** raise() 는 bounds 를 다시 세팅하는데, show 직후에는 그럴 필요가 없어 분리한다. */
  private raiseWithoutReset(): void {
    if (!this.view) return;
    this.window.contentView.removeChildView(this.view);
    this.window.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
  }

  hide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.view?.setVisible(false);
  }

  /** 스크린샷 검증용 — 지금 보이는지. */
  isVisible(): boolean {
    return this.view?.getVisible() ?? false;
  }

  /** 마지막으로 그린 내용. 도구가 클릭 직전에 무엇을 표시했는지 확인하는 데 쓴다. */
  lastState(): { state: OverlayState; at: number } | null {
    return this.lastShown;
  }

  /**
   * 오버레이 뷰만 캡처한다.
   * 오버레이는 별도 View 라 페이지 캡처에는 잡히지 않는다 — 하이라이트 픽셀을 세려면 이쪽을 봐야 한다.
   */
  async capture(): Promise<{ base64: string; width: number; height: number } | null> {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return null;

    const image = await view.webContents.capturePage();
    const size = image.getSize();
    return { base64: image.toPNG().toString('base64'), width: size.width, height: size.height };
  }

  private async waitReady(view: WebContentsView): Promise<void> {
    if (this.ready) return;
    // 로드가 끝나기 전에 그리면 조용히 사라진다. 짧게 기다린다.
    for (let attempt = 0; attempt < 40 && !this.ready; attempt += 1) {
      if (view.webContents.isDestroyed()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;

    const view = this.view;
    this.view = null;
    if (!view) return;

    // 창이 이미 파괴되었으면 자식 뷰도 함께 정리된 상태다(M1 에서 겪은 종료 지연 방지).
    if (!this.window.isDestroyed()) {
      this.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }
}
