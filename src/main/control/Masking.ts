import type { WebContents } from 'electron';

/**
 * 개인정보 마스킹 — 도구 결과·저장(감사 로그)·스크린샷 3중 적용.
 *
 * 사내 인사 포털은 이름·사번·전화·이메일을 목록에 그대로 노출한다. AI 가 그 페이지를 읽으면
 * 개인정보가 도구 결과 → 로그 → 스크린샷으로 번진다. 세 곳 모두에서 같은 규칙으로 지운다.
 *
 * 규칙은 화이트리스트가 아니라 패턴이라 완벽할 수 없다. 그래서 마스킹과 함께 `review` 플래그를
 * 올려 "여기 개인정보가 있었다" 는 사실을 사람이 알 수 있게 한다.
 */

export type PiiKind = 'employeeNo' | 'phone' | 'email';

export interface PiiPattern {
  kind: PiiKind;
  regex: RegExp;
  /** 마스킹 후 남는 표기 */
  replace: (match: string) => string;
}

/**
 * 사번은 7자리 숫자다. 앞뒤가 숫자면 더 긴 수의 일부이므로 제외한다
 * (금액 1200000 같은 값이 사번으로 오인되지 않게 한다 — 그 값은 7자리지만 문맥이 다르다).
 *
 * 금액과 사번을 숫자 모양만으로 구분할 수는 없다. 그래서 사번 패턴은 "숫자만으로 이루어진
 * 독립된 7자리" 로 좁히고, 결재 금액은 시나리오 F 에서 숫자로 쓰이므로 마스킹 대상에서
 * 빠지도록 호출부가 `kinds` 로 범위를 정한다.
 */
export const PII_PATTERNS: readonly PiiPattern[] = [
  {
    kind: 'email',
    regex: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g,
    replace: (match) => {
      const at = match.indexOf('@');
      const local = match.slice(0, at);
      const head = local.slice(0, 2);
      return `${head}${'*'.repeat(Math.max(2, local.length - 2))}${match.slice(at)}`;
    }
  },
  {
    kind: 'phone',
    regex: /\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
    replace: (match) => {
      const digits = match.replace(/\D/g, '');
      return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
    }
  },
  {
    kind: 'employeeNo',
    regex: /(?<!\d)\d{7}(?!\d)/g,
    replace: (match) => `${match.slice(0, 2)}*****`
  }
];

export interface MaskResult {
  text: string;
  /** 종류별 적중 횟수 */
  hits: Record<PiiKind, number>;
  /** 하나라도 걸렸으면 true — 사람이 다시 봐야 한다는 표시 */
  review: boolean;
}

function emptyHits(): Record<PiiKind, number> {
  return { employeeNo: 0, phone: 0, email: 0 };
}

/**
 * 문자열에서 개인정보 패턴을 지운다.
 * @param kinds 적용할 종류. 생략하면 전부.
 */
export function maskText(value: string, kinds?: readonly PiiKind[]): MaskResult {
  const hits = emptyHits();
  let text = value;

  for (const pattern of PII_PATTERNS) {
    if (kinds && !kinds.includes(pattern.kind)) continue;

    text = text.replace(pattern.regex, (match) => {
      hits[pattern.kind] += 1;
      return pattern.replace(match);
    });
  }

  const review = Object.values(hits).some((count) => count > 0);
  return { text, hits, review };
}

/** 개인정보가 남아 있는지만 본다. 검증용. */
export function findPii(value: string): { kind: PiiKind; match: string }[] {
  const found: { kind: PiiKind; match: string }[] = [];

  for (const pattern of PII_PATTERNS) {
    // 전역 정규식은 lastIndex 가 남으므로 매번 새로 만든다.
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match = regex.exec(value);
    while (match) {
      found.push({ kind: pattern.kind, match: match[0] });
      match = regex.exec(value);
    }
  }

  return found;
}

export interface DeepMaskResult<T> {
  value: T;
  hits: Record<PiiKind, number>;
  review: boolean;
}

/**
 * 객체 안의 모든 문자열에 마스킹을 적용한다.
 * 도구 결과와 감사 로그가 같은 함수를 쓰게 해서 한쪽만 가려지는 일을 막는다.
 */
export interface MaskDeepOptions {
  kinds?: readonly PiiKind[];
  /**
   * 마스킹을 건너뛸 키.
   * 스크린샷 base64 는 우연히 이메일·전화 패턴과 겹칠 수 있어 마스킹하면 이미지가 깨진다.
   * 이미지 자체의 마스킹은 픽셀 단위로 따로 한다(computer 도구).
   */
  skipKeys?: readonly string[];
}

export function maskDeep<T>(value: T, options: MaskDeepOptions | readonly PiiKind[] = {}): DeepMaskResult<T> {
  const opts: MaskDeepOptions = Array.isArray(options) ? { kinds: options } : (options as MaskDeepOptions);
  const skip = new Set(opts.skipKeys ?? ['image']);
  const hits = emptyHits();

  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') {
      const result = maskText(input, opts.kinds);
      for (const kind of Object.keys(hits) as PiiKind[]) hits[kind] += result.hits[kind];
      return result.text;
    }

    if (Array.isArray(input)) return input.map(walk);

    if (input !== null && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        out[key] = skip.has(key) ? item : walk(item);
      }
      return out;
    }

    return input;
  };

  const masked = walk(value) as T;
  return { value: masked, hits, review: Object.values(hits).some((count) => count > 0) };
}

export interface PiiBox {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: PiiKind | 'password';
}

/**
 * 화면에서 가려야 할 사각형을 모은다 — 스크린샷 마스킹용.
 *
 * 텍스트 노드를 훑어 패턴에 걸리는 요소의 사각형을 돌려준다. 페이지 DOM 을 바꾸지 않고
 * 좌표만 읽는다(Range 로 측정하고 되돌린다).
 */
export async function collectMaskBoxes(wc: WebContents): Promise<PiiBox[]> {
  // 패턴을 페이지 안으로 넘겨 같은 규칙을 쓰게 한다 — 규칙이 두 곳으로 갈라지지 않게.
  const patternSource = PII_PATTERNS.map((pattern) => ({
    kind: pattern.kind,
    source: pattern.regex.source,
    flags: pattern.regex.flags
  }));

  const script = `(() => {
    const patterns = ${JSON.stringify(patternSource)}.map((p) => ({
      kind: p.kind,
      regex: new RegExp(p.source, p.flags)
    }));

    const boxes = [];

    // 비밀번호 입력은 값이 화면에 불릿으로 보이지만 영역 자체를 가린다.
    for (const el of document.querySelectorAll('input[type=password]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height, kind: 'password' });
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const text = node.nodeValue || '';
      if (text.trim() !== '') {
        for (const pattern of patterns) {
          pattern.regex.lastIndex = 0;
          let match = pattern.regex.exec(text);

          while (match) {
            // Range 로 그 부분만 정확히 측정한다. DOM 은 바꾸지 않는다.
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);

            for (const r of range.getClientRects()) {
              if (r.width > 0 && r.height > 0) {
                boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height, kind: pattern.kind });
              }
            }
            range.detach();

            if (!pattern.regex.global) break;
            match = pattern.regex.exec(text);
          }
        }
      }
      node = walker.nextNode();
    }

    return boxes;
  })()`;

  try {
    const boxes = (await wc.executeJavaScript(script)) as unknown;
    return Array.isArray(boxes) ? (boxes as PiiBox[]) : [];
  } catch (error) {
    console.warn('[collectMaskBoxes] 마스킹 영역 수집 실패', error);
    return [];
  }
}
