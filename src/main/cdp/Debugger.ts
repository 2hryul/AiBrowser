import type { WebContents } from 'electron';

/**
 * `webContents.debugger` 연결 관리.
 *
 * 페이지 제어는 CDP 로만 한다(GOAL-M2 FIXED DECISIONS). 탭마다 attach 상태와 이벤트 구독을
 * 여기서 한 곳에 모아, 도구들이 attach/detach 를 신경 쓰지 않게 한다.
 */

export type CdpEventHandler = (method: string, params: unknown) => void;

interface Attachment {
  wc: WebContents;
  handlers: Set<CdpEventHandler>;
  /** 활성화한 CDP 도메인 — 중복 enable 을 피한다. */
  enabled: Set<string>;
}

const attachments = new Map<number, Attachment>();

/** Electron 이 지원하는 CDP 프로토콜 버전. */
const PROTOCOL_VERSION = '1.3';

function keyOf(wc: WebContents): number {
  return wc.id;
}

/**
 * 탭에 디버거를 붙인다. 이미 붙어 있으면 그대로 쓴다.
 * 다른 도구(개발자도구)가 먼저 붙어 있으면 attach 가 실패하므로 그 사유를 그대로 올린다.
 */
export function attach(wc: WebContents): Attachment {
  const existing = attachments.get(keyOf(wc));
  if (existing && !existing.wc.isDestroyed()) return existing;

  if (!wc.debugger.isAttached()) {
    try {
      wc.debugger.attach(PROTOCOL_VERSION);
    } catch (error) {
      throw new Error(
        `[cdp.attach] 디버거 연결 실패 - webContents ${wc.id}: ${(error as Error).message}. ` +
          '개발자도구가 열려 있으면 닫고 다시 시도하세요.'
      );
    }
  }

  const attachment: Attachment = { wc, handlers: new Set(), enabled: new Set() };

  wc.debugger.on('message', (_event, method, params) => {
    for (const handler of attachment.handlers) {
      try {
        handler(method, params);
      } catch (error) {
        console.error(`[cdp] 이벤트 처리 실패 - ${method}`, error);
      }
    }
  });

  wc.debugger.on('detach', () => {
    attachments.delete(keyOf(wc));
  });

  wc.once('destroyed', () => {
    attachments.delete(keyOf(wc));
  });

  attachments.set(keyOf(wc), attachment);
  return attachment;
}

export function detach(wc: WebContents): void {
  attachments.delete(keyOf(wc));
  if (!wc.isDestroyed() && wc.debugger.isAttached()) {
    try {
      wc.debugger.detach();
    } catch (error) {
      console.warn(`[cdp.detach] 해제 실패 - webContents ${wc.id}`, error);
    }
  }
}

/** CDP 명령 1회. 반환 타입은 호출자가 좁힌다. */
export async function send<T = unknown>(
  wc: WebContents,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string
): Promise<T> {
  attach(wc);
  try {
    return (await wc.debugger.sendCommand(method, params, sessionId)) as T;
  } catch (error) {
    throw new Error(`[cdp.send] ${method} 실패: ${(error as Error).message}`);
  }
}

/** 도메인을 한 번만 enable 한다. */
export async function enableDomain(wc: WebContents, domain: string, params = {}): Promise<void> {
  const attachment = attach(wc);
  if (attachment.enabled.has(domain)) return;
  await send(wc, `${domain}.enable`, params);
  attachment.enabled.add(domain);
}

/** 이벤트 구독. 반환 함수를 호출하면 해제된다. */
export function onEvent(wc: WebContents, handler: CdpEventHandler): () => void {
  const attachment = attach(wc);
  attachment.handlers.add(handler);
  return () => attachment.handlers.delete(handler);
}

export function isAttached(wc: WebContents): boolean {
  return !wc.isDestroyed() && wc.debugger.isAttached();
}
