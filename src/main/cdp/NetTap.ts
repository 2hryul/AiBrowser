import type { WebContents } from 'electron';
import { enableDomain, onEvent, send } from './Debugger';

/**
 * 네트워크 도청 — read_network_requests 의 뒷단.
 *
 * SPA 는 화면에 12행만 그려도 JSON 에는 137건이 들어 있다. DOM 을 긁는 대신 XHR 응답을 읽는 편이
 * 정확하고 싸다. 응답 본문은 요청 시점에 받아 두지 않으면 사라지므로 링버퍼에 담아 둔다.
 */

/** 본문 총량 상한. 넘으면 오래된 항목의 본문부터 버린다(메타데이터는 남긴다). */
export const NET_BODY_LIMIT_BYTES = 256 * 1024;

/** 보관할 요청 개수 상한. */
const MAX_ENTRIES = 300;

export interface NetEntry {
  requestId: string;
  url: string;
  method: string;
  status: number | null;
  mimeType: string | null;
  /** 응답 본문. 상한을 넘겨 버려졌으면 null. */
  body: string | null;
  bodyBytes: number;
  startedAt: number;
  finishedAt: number | null;
  /** 본문이 상한 때문에 버려졌는지 */
  bodyEvicted: boolean;
}

interface Tap {
  entries: NetEntry[];
  totalBodyBytes: number;
  dispose: () => void;
}

const taps = new Map<number, Tap>();

/** 본문을 받아 둘 가치가 있는 타입만. 이미지·폰트까지 담으면 상한이 금방 찬다. */
const CAPTURED_MIME = /^(application\/json|application\/.*\+json|text\/)/i;

/**
 * 탭에 네트워크 도청을 건다. 이미 걸려 있으면 그대로 둔다.
 * AI 가 쓰기 시작할 때(도구 첫 호출) 켜고, 탭이 사라지면 정리한다.
 */
export async function startTap(wc: WebContents): Promise<void> {
  if (taps.has(wc.id)) return;

  await enableDomain(wc, 'Network');

  const tap: Tap = { entries: [], totalBodyBytes: 0, dispose: () => undefined };

  const pending = new Map<string, NetEntry>();

  const off = onEvent(wc, (method, params) => {
    const data = params as Record<string, unknown>;

    if (method === 'Network.requestWillBeSent') {
      const request = data['request'] as { url?: string; method?: string } | undefined;
      const entry: NetEntry = {
        requestId: String(data['requestId']),
        url: request?.url ?? '',
        method: request?.method ?? 'GET',
        status: null,
        mimeType: null,
        body: null,
        bodyBytes: 0,
        startedAt: Date.now(),
        finishedAt: null,
        bodyEvicted: false
      };
      pending.set(entry.requestId, entry);
      push(tap, entry);
      return;
    }

    if (method === 'Network.responseReceived') {
      const entry = pending.get(String(data['requestId']));
      const response = data['response'] as { status?: number; mimeType?: string } | undefined;
      if (entry && response) {
        entry.status = response.status ?? null;
        entry.mimeType = response.mimeType ?? null;
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(data['requestId']);
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      entry.finishedAt = Date.now();

      if (entry.mimeType && CAPTURED_MIME.test(entry.mimeType)) {
        // 본문은 지금 받아 두지 않으면 사라진다.
        void captureBody(wc, tap, entry);
      }
      return;
    }

    if (method === 'Network.loadingFailed') {
      const entry = pending.get(String(data['requestId']));
      if (entry) {
        entry.finishedAt = Date.now();
        pending.delete(entry.requestId);
      }
    }
  });

  tap.dispose = off;
  taps.set(wc.id, tap);

  wc.once('destroyed', () => stopTap(wc));
}

async function captureBody(wc: WebContents, tap: Tap, entry: NetEntry): Promise<void> {
  try {
    const result = await send<{ body: string; base64Encoded: boolean }>(
      wc,
      'Network.getResponseBody',
      { requestId: entry.requestId }
    );

    const body = result.base64Encoded
      ? Buffer.from(result.body, 'base64').toString('utf-8')
      : result.body;

    entry.body = body;
    entry.bodyBytes = Buffer.byteLength(body, 'utf-8');
    tap.totalBodyBytes += entry.bodyBytes;
    evict(tap);
  } catch {
    // 이미 폐기된 응답(캐시·리다이렉트 등)은 본문을 못 얻는다. 메타데이터만 남긴다.
  }
}

function push(tap: Tap, entry: NetEntry): void {
  tap.entries.push(entry);
  while (tap.entries.length > MAX_ENTRIES) {
    const dropped = tap.entries.shift();
    if (dropped?.body) tap.totalBodyBytes -= dropped.bodyBytes;
  }
}

/** 본문 총량이 상한을 넘으면 오래된 것부터 본문만 비운다. 메타데이터는 남긴다. */
function evict(tap: Tap): void {
  for (const entry of tap.entries) {
    if (tap.totalBodyBytes <= NET_BODY_LIMIT_BYTES) return;
    if (entry.body === null) continue;
    tap.totalBodyBytes -= entry.bodyBytes;
    entry.body = null;
    entry.bodyEvicted = true;
  }
}

export function stopTap(wc: WebContents): void {
  const tap = taps.get(wc.id);
  if (!tap) return;
  tap.dispose();
  taps.delete(wc.id);
}

export interface NetQuery {
  /** URL 부분 문자열 또는 정규식 문자열 */
  urlPattern?: string;
  /** 본문을 함께 돌려줄지. false 면 메타데이터만. */
  includeBody?: boolean;
  limit?: number;
}

export function readRequests(wc: WebContents, query: NetQuery = {}): NetEntry[] {
  const tap = taps.get(wc.id);
  if (!tap) return [];

  const limit = query.limit ?? 50;
  let matcher: (url: string) => boolean = () => true;

  if (query.urlPattern) {
    const pattern = query.urlPattern;
    try {
      const regex = new RegExp(pattern);
      matcher = (url) => regex.test(url);
    } catch {
      // 정규식으로 못 읽으면 부분 문자열로 취급한다 — 호출자가 편한 쪽을 쓰게 한다.
      matcher = (url) => url.includes(pattern);
    }
  }

  return tap.entries
    .filter((entry) => matcher(entry.url))
    .slice(-limit)
    .map((entry) => (query.includeBody === false ? { ...entry, body: null } : { ...entry }));
}

/** 테스트가 상한 동작을 확인할 때 쓴다. */
export function tapStats(wc: WebContents): { entries: number; bodyBytes: number; evicted: number } {
  const tap = taps.get(wc.id);
  if (!tap) return { entries: 0, bodyBytes: 0, evicted: 0 };
  return {
    entries: tap.entries.length,
    bodyBytes: tap.totalBodyBytes,
    evicted: tap.entries.filter((entry) => entry.bodyEvicted).length
  };
}
