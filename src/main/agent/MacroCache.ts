import fs from 'node:fs';
import path from 'node:path';

/**
 * MacroCache — 같은 사이트에서 같은 단계를 두 번 성공하면 세 번째부터는 모델에게 묻지 않는다.
 *
 * 반복 수집 작업의 대부분은 같은 모양의 되풀이다: 목록을 읽고 → 행을 기록하고 → 다음 페이지로.
 * 이 셋을 200번 도는 동안 매번 모델에게 "다음에 뭘 할까" 를 묻는 것은 낭비다.
 *
 * **무엇을 키로 잡는가** — (작업, 호스트, 경로, 직전 도구). 여기까지가 같으면 사람이 보기에
 * 같은 자리다. 쿼리스트링은 키에 넣지 않는다. `?page=3` 과 `?page=4` 는 같은 자리이고,
 * 다른 것은 인자뿐이기 때문이다.
 *
 * **인자를 어떻게 맞히는가** — 관찰된 호출들이 숫자 하나만 일정하게 늘어난다면 그 규칙을
 * 이어 간다(페이지 넘기기). 그 외에는 관찰값이 전부 같을 때만 재사용한다.
 * **모르면 제안하지 않는다.** 틀린 제안은 모델을 부르는 것보다 비싸다 —
 * 엉뚱한 페이지를 읽고, 그걸 고치느라 더 많은 단계를 쓴다.
 *
 * **실패하면 지운다** — 그 자리에서 한 번이라도 빗나가면 항목을 버리고 다시 배우지 않는다
 * (poisoned). 화면이 바뀐 자리를 계속 맞히려 드는 것이 가장 나쁜 실패다.
 */

export interface MacroState {
  /** 작업 구분 — 지시문을 정규화한 값 */
  task: string;
  host: string;
  /** 쿼리스트링을 뺀 경로 */
  routePath: string;
  /** 직전에 부른 도구(없으면 'start') */
  lastTool: string;
  /**
   * 지금 보고 있는 주소. **키에는 넣지 않는다** — 제안을 만들 때의 기준점이다.
   *
   * 이 필드가 있는 이유가 MacroCache 설계의 핵심이다. 매크로는 예전에 본 값을 다시 트는 것이
   * 아니라 **지금 자리에 거는 변환**이다. 1회차에 page 2·3·4 를 봤다고 2회차 첫 페이지에서
   * page 5 를 제안하면 안 된다 — 지금이 page 1 이면 다음은 page 2 다.
   */
  currentUrl?: string;
}

export interface MacroCall {
  tool: string;
  args: Record<string, unknown>;
}

interface MacroEntry {
  tool: string;
  /** 관찰된 인자들 — 최근 것이 뒤에 온다 */
  samples: Record<string, unknown>[];
  hits: number;
  poisoned: boolean;
}

interface MacroFile {
  version: 1;
  entries: [string, MacroEntry][];
}

/** 두 번 성공해야 쓴다(GOAL-M4 IN SCOPE). 한 번은 우연일 수 있다. */
const MIN_OBSERVATIONS = 2;
const MAX_SAMPLES = 4;

/**
 * 캐시가 대신 부를 수 있는 도구.
 *
 * 원칙 하나로 갈린다 — **"어디로 가서 무엇을 읽을지" 는 되풀이해도 되지만,
 * "무엇이 적혀 있었는지" 는 절대 되풀이하면 안 된다.**
 *
 * 그래서 이동·읽기·탭 조작만 넣는다. 빠진 것들의 이유:
 *   - `agent_extract_rows`: 지난번에 읽은 행을 다시 넣는 것은 데이터를 지어내는 일이다
 *   - `ask_user`: 사람의 답을 캐시가 대신할 수 없다
 *   - `computer`·`form_input`·`download`·`upload`: 쓰기다. 모델이 이번에 판단하지 않은
 *     클릭과 제출을 캐시가 재생하면, 승인 게이트는 지나더라도 "왜 눌렀는가" 가 사라진다
 */
const CACHEABLE_TOOLS = new Set([
  'navigate',
  'navigate_history',
  'get_page_text',
  'read_page',
  'read_network_requests',
  'read_console_messages',
  'find',
  'tabs_create',
  'tabs_select',
  'tabs_close',
  'tabs_context'
]);

export function isCacheable(tool: string): boolean {
  return CACHEABLE_TOOLS.has(tool);
}

export function macroKey(state: MacroState): string {
  return [state.task, state.host, state.routePath, state.lastTool].join('|');
}

/** URL 에서 호스트와 경로만 남긴다. `app://portal-a/list?page=3` → `portal-a` + `/list` */
export function routeOf(url: string): { host: string; routePath: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host || parsed.protocol.replace(':', ''), routePath: parsed.pathname };
  } catch {
    return { host: '(unknown)', routePath: url };
  }
}

/** 지시문을 키로 쓸 수 있게 다듬는다 — 공백·숫자 차이로 캐시가 갈라지지 않도록. */
export function taskKey(instruction: string): string {
  return instruction
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * 숫자 하나만 일정하게 늘어나는 규칙을 찾아 **지금 자리에 건다.**
 * 문자열 안의 숫자도 본다 — `app://portal-a/list?page=3` 의 3 이 그것이다.
 *
 * `currentUrl` 이 관찰값과 같은 모양이면 기준을 거기로 옮긴다. 예전 값에 이어 붙이면
 * 두 번째 실행에서 앞쪽 페이지를 통째로 건너뛴다.
 */
function extrapolate(
  samples: Record<string, unknown>[],
  currentUrl: string | undefined
): Record<string, unknown> | null {
  const last = samples[samples.length - 1];
  const previous = samples[samples.length - 2];
  if (!last || !previous) return null;

  const keys = Object.keys(last);
  if (keys.length !== Object.keys(previous).length) return null;

  const next: Record<string, unknown> = {};
  let movingFields = 0;

  for (const key of keys) {
    const a = previous[key];
    const b = last[key];

    if (typeof a === 'number' && typeof b === 'number') {
      if (a === b) {
        next[key] = b;
        continue;
      }
      const delta = b - a;
      if (!Number.isInteger(delta)) return null;
      next[key] = b + delta;
      movingFields += 1;
      continue;
    }

    if (typeof a === 'string' && typeof b === 'string') {
      if (a === b) {
        next[key] = b;
        continue;
      }

      // 지금 보고 있는 주소가 같은 모양이면 그것을 기준으로 민다.
      const base = currentUrl !== undefined && sameShape(b, currentUrl) ? currentUrl : b;
      const predicted = extrapolateNumberInString(a, b, base);
      if (predicted === null) return null;
      next[key] = predicted;
      movingFields += 1;
      continue;
    }

    if (JSON.stringify(a) !== JSON.stringify(b)) return null;
    next[key] = b;
  }

  // 움직이는 자리가 둘 이상이면 규칙이라고 볼 수 없다.
  return movingFields === 1 ? next : movingFields === 0 ? next : null;
}

/** 숫자만 빼면 같은 문자열인가 — `?page=1` 과 `?page=7` 은 같은 모양이다. */
function sameShape(a: string, b: string): boolean {
  return a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#');
}

/**
 * 두 관찰값이 숫자 한 자리만 다르면 그 간격을 `base` 에 건다.
 * `base` 는 보통 "지금 보고 있는 주소" 다 — 예전 값이 아니다.
 */
function extrapolateNumberInString(
  previous: string,
  last: string,
  base: string
): string | null {
  const pattern = /\d+/g;
  const previousNumbers = [...previous.matchAll(pattern)];
  const lastNumbers = [...last.matchAll(pattern)];
  const baseNumbers = [...base.matchAll(pattern)];

  if (previousNumbers.length !== lastNumbers.length || lastNumbers.length === 0) return null;
  if (!sameShape(previous, last)) return null;
  if (baseNumbers.length !== lastNumbers.length || !sameShape(base, last)) return null;

  let movingIndex = -1;
  let delta = 0;

  for (let i = 0; i < lastNumbers.length; i += 1) {
    const a = Number(previousNumbers[i]?.[0] ?? NaN);
    const b = Number(lastNumbers[i]?.[0] ?? NaN);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (a === b) continue;

    if (movingIndex >= 0) return null; // 두 자리가 동시에 움직이면 규칙이 아니다
    movingIndex = i;
    delta = b - a;
  }

  if (movingIndex < 0) return base;

  let cursor = 0;
  let out = '';
  for (let i = 0; i < baseNumbers.length; i += 1) {
    const match = baseNumbers[i];
    if (!match || match.index === undefined) return null;

    out += base.slice(cursor, match.index);
    out += i === movingIndex ? String(Number(match[0]) + delta) : match[0];
    cursor = match.index + match[0].length;
  }

  return out + base.slice(cursor);
}

export class MacroCache {
  private readonly entries = new Map<string, MacroEntry>();

  constructor(private readonly filePath: string | null = null) {
    this.load();
  }

  /** 성공한 단계를 기록한다. 두 번째 관찰부터 제안 대상이 된다. */
  observe(state: MacroState, call: MacroCall): void {
    if (!isCacheable(call.tool)) return;

    const key = macroKey(state);
    const existing = this.entries.get(key);

    if (!existing) {
      this.entries.set(key, { tool: call.tool, samples: [call.args], hits: 1, poisoned: false });
      return;
    }

    if (existing.poisoned) return;

    // 같은 자리에서 다른 도구를 골랐다면 규칙이 아니다 — 배움을 접는다.
    if (existing.tool !== call.tool) {
      existing.poisoned = true;
      return;
    }

    existing.samples.push(call.args);
    if (existing.samples.length > MAX_SAMPLES) existing.samples.shift();
    existing.hits += 1;
  }

  /** 이 자리에서 다음에 무엇을 할지 — 모르면 null 이고, 그러면 모델에게 묻는다. */
  suggest(state: MacroState): MacroCall | null {
    const entry = this.entries.get(macroKey(state));
    if (!entry || entry.poisoned || entry.hits < MIN_OBSERVATIONS) return null;

    const identical = entry.samples.every(
      (sample) => JSON.stringify(sample) === JSON.stringify(entry.samples[0])
    );

    if (identical) {
      const args = entry.samples[0];
      return args ? { tool: entry.tool, args: { ...args } } : null;
    }

    const args = extrapolate(entry.samples, state.currentUrl);
    return args === null ? null : { tool: entry.tool, args };
  }

  /** 빗나갔다. 이 자리는 다시 배우지 않는다 — 화면이 바뀐 것일 수 있다. */
  invalidate(state: MacroState): void {
    const key = macroKey(state);
    const entry = this.entries.get(key);
    if (entry) entry.poisoned = true;
    else this.entries.set(key, { tool: '', samples: [], hits: 0, poisoned: true });
  }

  /**
   * 캐시가 제안한 호출이 실제로 통했다.
   *
   * **관찰로 다시 넣지 않는다.** 재생한 값을 샘플에 넣으면 증분 규칙이 망가진다 —
   * 1회차에 page 2→3→4 를 배운 뒤 2회차에서 page 2 를 재생하면 마지막 두 샘플이
   * (4, 2) 가 되어 증분이 -2 로 뒤집히고, 다음 제안이 page 0 으로 간다(실제로 겪었다).
   * 제안은 지금 자리에 거는 변환이므로 샘플은 처음 배운 그대로 두면 된다.
   */
  confirm(state: MacroState, _call: MacroCall): void {
    const entry = this.entries.get(macroKey(state));
    if (entry && !entry.poisoned) entry.hits += 1;
  }

  get size(): number {
    return [...this.entries.values()].filter((entry) => !entry.poisoned).length;
  }

  clear(): void {
    this.entries.clear();
  }

  save(): void {
    if (!this.filePath) return;

    try {
      const payload: MacroFile = { version: 1, entries: [...this.entries.entries()] };
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(payload), 'utf-8');
    } catch (error) {
      console.warn(`[MacroCache] 저장 실패 - 경로: ${this.filePath}`, error);
    }
  }

  private load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as MacroFile;
      if (parsed.version !== 1) return;
      for (const [key, entry] of parsed.entries) this.entries.set(key, entry);
    } catch (error) {
      console.warn(`[MacroCache] 읽기 실패 - 경로: ${this.filePath}`, error);
    }
  }
}
