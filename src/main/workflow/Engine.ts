import { classify, type ClassifyFallback } from './ops/classify';
import { lookup } from './ops/lookup';
import { normalizeRows, type NormalizeKind } from './ops/normalize';
import { reconcile } from './ops/reconcile';
import { isAdapterStep, type StepDoc, type WorkflowDoc } from './schema';
import { provenanced, type Provenanced, type ValueSource, type Verdict } from './types';
import { resolvePath } from './values';
import { verify, type VerifyResult } from './Verifier';

/**
 * Engine — 워크플로우를 단계대로 실행하고 오라클로 판정한다.
 *
 * 상태머신이라고 부를 만한 것은 단순하다: 단계 배열을 순서대로 밟고, 각 단계의 결과를
 * 이름으로 값 표에 넣는다. 중요한 것은 **멈추는 방식**이다.
 *
 *   - 어댑터가 깨지면(`AdapterBrokenError`) 즉시 멈추고 `ADAPTER_BROKEN` — 남은 단계를
 *     억지로 진행해 반쪽 데이터로 판정하지 않는다
 *   - 그 밖의 오류는 재시도 후 `FAIL`
 *   - 중단된 실행은 `RunState` 를 그대로 넘겨 `resume` 으로 이어간다(이미 끝난 단계는 다시
 *     돌지 않는다 — 바깥 시스템을 두 번 건드리면 안 된다)
 *
 * 값에는 출처가 붙는다. 연산 결과의 출처는 **입력 중 가장 약한 것**을 물려받는다 —
 * LLM 으로 뽑은 행을 정규화한다고 해서 그 값이 갑자기 믿을 만해지지 않는다.
 */

export class AdapterBrokenError extends Error {
  readonly adapter: string;

  constructor(adapter: string, message: string) {
    super(`[adapter:${adapter}] ${message}`);
    this.name = 'AdapterBrokenError';
    this.adapter = adapter;
  }
}

/** 어댑터 계약 (GOAL-M5: name, input, output, write, source, pii). */
export interface ToolContract {
  name: string;
  version: number;
  /** 입력 항목 이름 */
  input: string[];
  /** 출력 항목 이름 */
  output: string[];
  /** 바깥 시스템을 바꾸는가 — true 면 M3 Policy 승인 대상 */
  write: boolean;
  /** 어떤 경로로 값을 얻는가(사다리) */
  source: ValueSource;
  /** 개인정보 항목 경로 — 증거 팩에서 `***` 로 가려진다 */
  pii: string[];
}

export interface AdapterResult {
  value: unknown;
  /** 실제로 어느 경로로 얻었는지. 폴백하면 계약의 source 와 달라진다. */
  source: ValueSource;
  /** 원본 응답 — 증거 팩의 raw/ 에 남는다 */
  raw?: unknown;
  /** 스크린샷 파일 경로 */
  screenshot?: string;
  /** 사람이 읽을 한 줄 */
  note?: string;
}

export interface AdapterContext {
  inputs: Record<string, unknown>;
  /** 이 단계의 인자(치환 완료) */
  args: Record<string, unknown>;
  runId: string;
  stepId: string;
}

export interface Adapter {
  contract: ToolContract;
  run: (context: AdapterContext) => Promise<AdapterResult>;
}

export interface EngineOptions {
  adapters: Record<string, Adapter>;
  /** classify 의 LLM 폴백(M4b). 없으면 규칙만 쓴다. */
  classifyFallback?: ClassifyFallback;
  /** 재시도 대기. 테스트가 0 으로 줄인다. */
  sleep?: (ms: number) => Promise<void>;
}

export type RunStatus = 'running' | 'done' | 'failed' | 'adapter_broken';

export interface StepRecord {
  id: string;
  kind: 'adapter' | 'op';
  name: string;
  as: string;
  source: ValueSource;
  startedAt: number;
  durationMs: number;
  attempts: number;
  ok: boolean;
  error: string | null;
  screenshot: string | null;
  note: string | null;
}

export interface RunState {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  inputs: Record<string, unknown>;
  /** 다음에 실행할 단계 인덱스 */
  cursor: number;
  values: Record<string, Provenanced<unknown>>;
  steps: StepRecord[];
  status: RunStatus;
  adapterBroken: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface RunResult {
  state: RunState;
  verdict: Verdict;
  verification: VerifyResult;
  outputs: Record<string, unknown>;
  /** 어댑터 이름 → 버전. 실행 기록에 동봉한다(FIXED DECISIONS). */
  adapterVersions: Record<string, number>;
}

const SOURCE_WEIGHT: Record<ValueSource, number> = {
  const: 0,
  api: 1,
  network: 2,
  file: 3,
  dom: 4,
  llm: 5
};

/** 여러 입력에서 나온 값의 출처 — 가장 약한 것을 물려받는다. */
export function weakestSource(sources: readonly ValueSource[]): ValueSource {
  if (sources.length === 0) return 'const';
  return sources.reduce((worst, current) =>
    SOURCE_WEIGHT[current] > SOURCE_WEIGHT[worst] ? current : worst
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export class Engine {
  private readonly options: EngineOptions;

  constructor(options: EngineOptions) {
    this.options = options;
  }

  /** 새 실행을 시작한다. */
  start(workflow: WorkflowDoc, inputs: Record<string, unknown>, runId: string): RunState {
    const missing = Object.entries(workflow.inputs)
      .filter(([name, spec]) => spec.required && inputs[name] === undefined)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(`[workflow] ${workflow.id}: 필수 입력 누락 — ${missing.join(', ')}`);
    }

    const now = Date.now();

    return {
      runId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      inputs,
      cursor: 0,
      values: Object.fromEntries(
        Object.entries(inputs).map(([name, value]) => [`inputs.${name}`, provenanced(value, 'const')])
      ),
      steps: [],
      status: 'running',
      adapterBroken: null,
      startedAt: now,
      updatedAt: now
    };
  }

  /** 처음부터 끝까지. */
  async run(
    workflow: WorkflowDoc,
    inputs: Record<string, unknown>,
    runId: string
  ): Promise<RunResult> {
    return this.resume(workflow, this.start(workflow, inputs, runId));
  }

  /**
   * 중단된 실행을 이어간다. `state.cursor` 부터 시작하므로 이미 끝난 단계는 다시 돌지 않는다.
   * 바깥 시스템을 두 번 건드리지 않는 것이 재개의 핵심이다.
   */
  async resume(workflow: WorkflowDoc, state: RunState): Promise<RunResult> {
    const working: RunState = { ...state, values: { ...state.values }, steps: [...state.steps] };
    const adapterVersions: Record<string, number> = {};

    for (const [name, adapter] of Object.entries(this.options.adapters)) {
      adapterVersions[name] = adapter.contract.version;
    }

    while (working.cursor < workflow.steps.length) {
      const step = workflow.steps[working.cursor];
      if (!step) break;

      const record = await this.runStep(workflow, step, working);
      working.steps.push(record);
      working.updatedAt = Date.now();

      if (!record.ok) {
        working.status = working.adapterBroken ? 'adapter_broken' : 'failed';
        break;
      }

      working.cursor += 1;
    }

    if (working.status === 'running') working.status = 'done';

    const verification = verify({
      values: working.values,
      oracles: workflow.oracles,
      adapterBroken: working.adapterBroken
    });

    // 단계가 실패했는데 오라클이 통과하는 일은 없어야 한다.
    const verdict: Verdict =
      working.status === 'adapter_broken'
        ? 'ADAPTER_BROKEN'
        : working.status === 'failed'
          ? 'FAIL'
          : verification.verdict;

    const outputs: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(workflow.outputs)) {
      outputs[name] = resolvePath(working.values, path);
    }

    return { state: working, verdict, verification, outputs, adapterVersions };
  }

  private async runStep(
    workflow: WorkflowDoc,
    step: StepDoc,
    state: RunState
  ): Promise<StepRecord> {
    const startedAt = Date.now();
    const sleep = this.options.sleep ?? defaultSleep;
    const maxAttempts = step.retry.max + 1;

    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < maxAttempts) {
      attempts += 1;

      try {
        const args = substitute(step.with, state.values) as Record<string, unknown>;

        if (isAdapterStep(step)) {
          const adapter = this.options.adapters[step.adapter];
          if (!adapter) throw new Error(`등록되지 않은 어댑터: ${step.adapter}`);

          const result = await adapter.run({
            inputs: state.inputs,
            args,
            runId: state.runId,
            stepId: step.id
          });

          state.values[step.as] = provenanced(result.value, result.source, {
            step: step.id,
            adapter: adapter.contract.name,
            adapterVersion: adapter.contract.version
          });

          if (result.raw !== undefined) {
            state.values[`${step.as}.__raw`] = provenanced(result.raw, result.source, {
              step: step.id
            });
          }

          return {
            id: step.id,
            kind: 'adapter',
            name: step.adapter,
            as: step.as,
            source: result.source,
            startedAt,
            durationMs: Date.now() - startedAt,
            attempts,
            ok: true,
            error: null,
            screenshot: result.screenshot ?? null,
            note: result.note ?? null
          };
        }

        const { value, source } = await this.runOp(step.op, args, state);
        state.values[step.as] = provenanced(value, source, { step: step.id });

        return {
          id: step.id,
          kind: 'op',
          name: step.op,
          as: step.as,
          source,
          startedAt,
          durationMs: Date.now() - startedAt,
          attempts,
          ok: true,
          error: null,
          screenshot: null,
          note: null
        };
      } catch (error) {
        lastError = error as Error;

        // 어댑터가 깨진 것은 재시도로 낫지 않는다 — 화면 구조가 바뀐 것이다.
        if (error instanceof AdapterBrokenError) {
          state.adapterBroken = error.message;
          break;
        }

        if (attempts < maxAttempts) await sleep(step.retry.delayMs);
      }
    }

    return {
      id: step.id,
      kind: isAdapterStep(step) ? 'adapter' : 'op',
      name: isAdapterStep(step) ? step.adapter : step.op,
      as: step.as,
      source: 'const',
      startedAt,
      durationMs: Date.now() - startedAt,
      attempts,
      ok: false,
      error: lastError?.message ?? `알 수 없는 실패 (${workflow.id})`,
      screenshot: null,
      note: null
    };
  }

  private async runOp(
    op: 'normalize' | 'reconcile' | 'classify' | 'lookup' | 'aggregate',
    args: Record<string, unknown>,
    state: RunState
  ): Promise<{ value: unknown; source: ValueSource }> {
    // 인자로 들어온 값들의 출처를 모아 가장 약한 것을 결과에 물려준다.
    const source = weakestSource(collectSources(args, state.values));

    switch (op) {
      case 'normalize': {
        const rows = asRows(args['rows'], 'normalize.rows');
        const fields = (args['fields'] ?? {}) as Record<string, NormalizeKind>;
        return { value: normalizeRows(rows, { fields }), source };
      }

      case 'reconcile': {
        const left = asRows(args['left'], 'reconcile.left');
        const right = asRows(args['right'], 'reconcile.right');

        return {
          value: reconcile(left, right, {
            key: String(args['key'] ?? ''),
            ...(args['amountField'] === undefined
              ? {}
              : { amountField: String(args['amountField']) }),
            tolerance: Number(args['tolerance'] ?? 0),
            fuzzyDistance: Number(args['fuzzyDistance'] ?? 0)
          }),
          source
        };
      }

      case 'classify': {
        const outcome = await classify(args['value'], {
          allowed: (args['allowed'] ?? []) as string[],
          rules: (args['rules'] ?? []) as never,
          ...(this.options.classifyFallback ? { fallback: this.options.classifyFallback } : {})
        });

        // 분류가 LLM 에서 왔으면 값의 출처도 llm 이다 — 그래야 PASS 가 강등된다.
        return { value: outcome, source: outcome.source === 'llm' ? 'llm' : source };
      }

      case 'lookup': {
        const rows = asRows(args['rows'], 'lookup.rows');
        return {
          value: lookup(rows, {
            field: String(args['field'] ?? ''),
            as: String(args['as'] ?? 'value'),
            table: (args['table'] ?? {}) as Record<string, string>,
            ...(args['fallback'] === undefined ? {} : { fallback: String(args['fallback']) })
          }),
          source
        };
      }

      case 'aggregate': {
        // sum_equal 같은 규칙에 넣을 스칼라를 만든다. 규칙이 컬렉션을 다루지 않게 하려는 것이다.
        const rows = asRows(args['rows'], 'aggregate.rows');
        const field = String(args['field'] ?? '');
        const fn = String(args['fn'] ?? 'sum');

        if (fn === 'count') return { value: rows.length, source };

        const numbers = rows.map((row) => {
          const raw = row[field];
          const parsed = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/,/g, ''));
          if (!Number.isFinite(parsed)) {
            throw new Error(`aggregate: ${field} 를 숫자로 읽을 수 없습니다 (${String(raw)})`);
          }
          return parsed;
        });

        if (fn === 'sum') return { value: numbers.reduce((total, n) => total + n, 0), source };
        if (fn === 'min') return { value: Math.min(...numbers), source };
        if (fn === 'max') return { value: Math.max(...numbers), source };

        throw new Error(`aggregate: 알 수 없는 함수 ${fn}`);
      }

      default:
        throw new Error(`알 수 없는 연산: ${String(op)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 치환 — `${이름.경로}` 만 지원한다(식 계산은 없다)
// ─────────────────────────────────────────────────────────────

export { resolvePath } from './values';

const REFERENCE = /^\$\{([^}]+)\}$/;

/**
 * 인자 안의 `${...}` 를 값으로 바꾼다.
 *
 * **식을 계산하지 않는다.** 경로 참조만 된다. 워크플로우에 작은 언어를 심으면
 * 그 언어의 버그가 판정의 버그가 되고, YAML 을 읽어서는 무슨 일이 일어나는지 알 수 없게 된다.
 * 합계 같은 계산은 `aggregate` 단계로 드러내 놓는다.
 */
export function substitute(
  input: unknown,
  values: Record<string, Provenanced<unknown>>
): unknown {
  if (typeof input === 'string') {
    const match = REFERENCE.exec(input.trim());
    return match ? resolvePath(values, match[1] as string) : input;
  }

  if (Array.isArray(input)) return input.map((item) => substitute(item, values));

  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      out[key] = substitute(item, values);
    }
    return out;
  }

  return input;
}

/** 치환된 인자가 어떤 값들에서 왔는지 — 출처 물려주기에 쓴다. */
function collectSources(
  args: Record<string, unknown>,
  values: Record<string, Provenanced<unknown>>
): ValueSource[] {
  const sources: ValueSource[] = [];

  // 인자에 실제로 들어온 값(치환 후)이 어느 항목에서 왔는지는 알 수 없으므로,
  // 값 표에서 같은 참조를 가진 항목을 찾는다. 참조 동일성으로 비교하면 정확하다.
  for (const value of Object.values(args)) {
    for (const entry of Object.values(values)) {
      if (entry.value === value) {
        sources.push(entry.source);
        break;
      }
    }
  }

  return sources;
}

function asRows(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label}: 목록이 아닙니다`);
  return value as Record<string, unknown>[];
}
