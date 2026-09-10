import type { WebContents } from 'electron';
import { enableDomain, onEvent, send } from '../cdp/Debugger';
import type { PausedResult } from '../tools/index';

/**
 * Handoff — 사람이 개입하면 AI 를 멈춘다.
 *
 * 불변 조건 3: 사람이 우선권을 가진다. AI 소유 탭에 사람 입력이 감지되면 즉시 일시정지하고,
 * 사람이 "이어서" 를 누를 때까지 도구 호출은 `{paused:true}` 를 돌려준다.
 *
 * 키보드는 `before-input-event` 로 잡는다. 마우스는 Electron 이 WebContentsView 수준의
 * 이벤트를 주지 않아 CDP 격리 월드의 리스너 + Runtime 바인딩으로 잡는다.
 * 페이지 DOM 을 바꾸지 않고 리스너만 단다.
 */

export type ThreadState = 'idle' | 'running' | 'paused' | 'done';

export interface PauseInfo {
  threadId: string;
  tabId: number;
  reason: string;
  at: number;
}

export interface HandoffEvents {
  /** 셸(PauseResumeBar)에 상태를 알린다. */
  onChange: (state: {
    threadId: string;
    status: ThreadState;
    pause: PauseInfo | null;
  }) => void;
}

/** 격리 월드가 보낸 보고. 옛 형식(문자열)도 받아 준다. */
function parseReport(payload: string | undefined): { kind: string; at: number } {
  if (!payload) return { kind: 'mouse', at: Date.now() };
  try {
    const parsed = JSON.parse(payload) as { kind?: string; at?: number };
    return { kind: parsed.kind ?? 'mouse', at: typeof parsed.at === 'number' ? parsed.at : Date.now() };
  } catch {
    return { kind: payload, at: Date.now() };
  }
}

/** 사람 입력으로 치지 않는 키 — 단독 수식키는 무시한다. */
const IGNORED_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock']);

export class Handoff {
  private readonly events: HandoffEvents;
  /** threadId → 상태 */
  private readonly status = new Map<string, ThreadState>();
  private readonly pauses = new Map<string, PauseInfo>();
  /** tabId → threadId. AI 소유 탭만 등록된다. */
  private readonly owners = new Map<number, string>();
  private readonly detachers = new Map<number, () => void>();
  /** 사람이 "여기까지" 를 누른 스레드 */
  private readonly stopped = new Set<string>();

  constructor(events: HandoffEvents) {
    this.events = events;
  }

  /** AI 가 탭을 잡는다. 이후 그 탭의 사람 입력은 개입으로 본다. */
  claimTab(tabId: number, threadId: string, wc: WebContents): void {
    if (this.owners.get(tabId) === threadId) return;

    this.owners.set(tabId, threadId);
    this.status.set(threadId, 'running');
    this.attachDetection(tabId, threadId, wc);
    this.emit(threadId);
  }

  releaseTab(tabId: number): void {
    this.owners.delete(tabId);
    this.detachers.get(tabId)?.();
    this.detachers.delete(tabId);
  }

  ownerOf(tabId: number): string | null {
    return this.owners.get(tabId) ?? null;
  }

  isAiTab(tabId: number): boolean {
    return this.owners.has(tabId);
  }

  private attachDetection(tabId: number, threadId: string, wc: WebContents): void {
    if (this.detachers.has(tabId)) return;

    const onInput = (_event: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown') return;
      if (IGNORED_KEYS.has(input.key)) return;
      this.pause(threadId, tabId, `사람이 키를 입력했습니다 (${input.key})`);
    };

    wc.on('before-input-event', onInput);

    // 마우스는 CDP 격리 월드에서 리스너로 잡는다. 실패해도 키보드 감지는 살아 있어야 한다.
    void this.attachMouseDetection(tabId, threadId, wc).catch((error) => {
      console.warn(`[Handoff] 마우스 감지 설치 실패 - 탭 ${tabId}`, error);
    });

    this.detachers.set(tabId, () => {
      if (!wc.isDestroyed()) wc.removeListener('before-input-event', onInput);
    });
  }

  private async attachMouseDetection(
    tabId: number,
    threadId: string,
    wc: WebContents
  ): Promise<void> {
    await enableDomain(wc, 'Runtime');
    await enableDomain(wc, 'Page');

    const BINDING = '__helmHumanInput';
    await send(wc, 'Runtime.addBinding', { name: BINDING });

    // 새 문서마다 다시 붙어야 한다. 격리 월드라 페이지 전역을 건드리지 않는다.
    await send(wc, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        if (window.__helmHandoffInstalled) return;
        window.__helmHandoffInstalled = true;
        const report = (kind) => {
          // 발생 시각을 함께 보낸다. 전달이 늦어도(특히 클릭이 페이지 이동을 일으킬 때)
          // "그때 AI 가 조작 중이었나" 를 시각으로 판정할 수 있다.
          try { ${BINDING}(JSON.stringify({ kind: kind, at: Date.now() })); } catch (e) { /* 바인딩이 아직 없으면 무시 */ }
        };
        window.addEventListener('mousedown', () => report('mousedown'), true);
        window.addEventListener('wheel', () => report('wheel'), { capture: true, passive: true });
      })();`,
      runImmediately: true
    });

    const off = onEvent(wc, (method, params) => {
      if (method !== 'Runtime.bindingCalled') return;
      const data = params as { name?: string; payload?: string };
      if (data.name !== BINDING) return;

      const report = parseReport(data.payload);
      // AI 자신의 CDP 입력도 격리 월드 리스너에 잡힌다. 이벤트가 **발생한 시각**이
      // 도구 조작 구간 안이면 우리 입력이다 — 전달이 늦게 와도 오인하지 않는다.
      if (this.wasActingAt(report.at)) return;

      this.pause(threadId, tabId, `사람이 페이지를 조작했습니다 (${report.kind})`);
    });

    const previous = this.detachers.get(tabId);
    this.detachers.set(tabId, () => {
      previous?.();
      off();
    });
  }

  /**
   * 도구가 CDP 입력을 보낸 구간. 자기 입력을 사람 개입으로 오인하지 않기 위한 기록이다.
   *
   * 단순 플래그로는 부족하다: 클릭이 페이지 이동을 일으키면 mousedown 보고가 새 문서 로드
   * 뒤에 도착해 플래그가 이미 내려간 상태로 들어온다(시나리오 F 에서 실측). 그래서
   * "언제 발생했는가" 를 구간과 비교한다.
   */
  private actingDepth = 0;
  private actingSince = 0;
  private readonly actingWindows: { from: number; to: number }[] = [];

  /** 보고 전달 지연 여유. 이벤트 발생 시각이 조작 종료 직후면 우리 입력으로 본다. */
  private static readonly ACTING_GRACE_MS = 400;

  async duringAction<T>(run: () => Promise<T>): Promise<T> {
    if (this.actingDepth === 0) this.actingSince = Date.now();
    this.actingDepth += 1;

    try {
      return await run();
    } finally {
      this.actingDepth -= 1;
      if (this.actingDepth === 0) {
        this.actingWindows.push({
          from: this.actingSince - 50,
          to: Date.now() + Handoff.ACTING_GRACE_MS
        });
        // 오래된 구간은 버린다 — 무한히 쌓이면 나중의 진짜 개입까지 무시하게 된다.
        if (this.actingWindows.length > 50) {
          this.actingWindows.splice(0, this.actingWindows.length - 50);
        }
      }
    }
  }

  /** 그 시각에 AI 가 조작 중이었는가. */
  private wasActingAt(at: number): boolean {
    if (this.actingDepth > 0 && at >= this.actingSince - 50) return true;
    return this.actingWindows.some((window) => at >= window.from && at <= window.to);
  }

  pause(threadId: string, tabId: number, reason: string): void {
    if (this.status.get(threadId) === 'paused') return;

    this.status.set(threadId, 'paused');
    this.pauses.set(threadId, { threadId, tabId, reason, at: Date.now() });
    this.emit(threadId);
  }

  /** "이어서" — 호출자에게 개입이 있었음을 알리고 계속한다. */
  resume(threadId: string): { resumed: true; note: string } {
    this.status.set(threadId, 'running');
    this.pauses.delete(threadId);
    this.emit(threadId);
    return { resumed: true, note: 'user intervened' };
  }

  /** "여기까지" — 스레드를 끝내고 탭 소유권을 사람에게 넘긴다. */
  takeOver(threadId: string): void {
    this.status.set(threadId, 'done');
    this.pauses.delete(threadId);
    this.stopped.add(threadId);

    for (const [tabId, owner] of [...this.owners]) {
      if (owner === threadId) this.releaseTab(tabId);
    }
    this.emit(threadId);
  }

  /** 도구 호출 진입에서 확인한다. 멈춰 있으면 그 사실을 결과로 돌려준다. */
  pausedState(threadId: string): PausedResult | null {
    if (this.stopped.has(threadId)) {
      return { paused: true, reason: '사람이 작업을 종료했습니다(여기까지)', tabId: null };
    }

    const status = this.status.get(threadId);
    if (status !== 'paused') return null;

    const info = this.pauses.get(threadId);
    return {
      paused: true,
      reason: info?.reason ?? '사람이 개입했습니다',
      tabId: info?.tabId ?? null
    };
  }

  statusOf(threadId: string): ThreadState {
    return this.status.get(threadId) ?? 'idle';
  }

  setStatus(threadId: string, status: ThreadState): void {
    this.status.set(threadId, status);
    if (status !== 'paused') this.pauses.delete(threadId);
    this.emit(threadId);
  }

  private emit(threadId: string): void {
    this.events.onChange({
      threadId,
      status: this.statusOf(threadId),
      pause: this.pauses.get(threadId) ?? null
    });
  }

  dispose(): void {
    for (const detach of this.detachers.values()) detach();
    this.detachers.clear();
    this.owners.clear();
  }
}
