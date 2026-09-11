import fs from 'node:fs';
import path from 'node:path';
import type { RunResult } from '../workflow/Engine';
import { isAdapterStep, type WorkflowDoc } from '../workflow/schema';

/**
 * 증거 팩 — 실행 하나가 남기는 폴더.
 *
 * ```
 * evidence/<runId>/
 *   steps/0001-fetch_settle-settle.png   단계 스크린샷
 *   raw/fetch_settle.json                어댑터가 받은 원본 응답
 *   extracted.json                       어댑터가 뽑은 값(출처·어댑터 버전 포함)
 *   normalized.json                      연산 결과(정규화·대사)
 *   oracles.json                         규칙 ID·버전·판정
 *   run.json                             실행 요약
 * ```
 *
 * 이 폴더가 있는 이유는 "왜 이 판정이 나왔나" 를 나중에 사람이 되짚을 수 있어야 하기 때문이다.
 * 그래서 원본과 정규화 결과를 **둘 다** 남긴다 — 정규화가 값을 바꿔 놓은 경우가 판정 분쟁의
 * 대부분이다.
 *
 * ## 마스킹
 *
 * 어댑터 계약의 `pii` 경로만 `***` 로 가린다. 전역 마스킹(`maskDeep`)을 쓰지 않는 것은
 * 의도적이다 — 사번 패턴(연속 7자리)이 `1250000` 같은 금액을 함께 가려 대사 근거를 망친다.
 * 무엇이 개인정보인지는 어댑터가 선언하고, 그 선언만 믿는다.
 */

export const MASK = '***';

/**
 * `rows[].approver` 꼴 경로의 값을 `***` 로 바꾼다.
 *
 * 경로 문법은 점으로 잇고, 배열을 훑을 자리에 `[]` 를 붙인다(`rows[].approver`).
 * 경로 뿌리는 어댑터 계약의 `output` 이름이다.
 * 없는 경로는 조용히 넘어간다 — 어댑터가 그 날 그 항목을 못 받았을 수 있다.
 */
export function maskAtPaths<T>(root: T, paths: readonly string[]): { value: T; masked: number } {
  const clone = structuredClone(root);
  let masked = 0;

  for (const spec of paths) {
    masked += applyPath(clone, spec.split('.'), 0);
  }

  return { value: clone, masked };
}

function applyPath(node: unknown, segments: readonly string[], index: number): number {
  const segment = segments[index];
  if (segment === undefined || node === null || typeof node !== 'object') return 0;

  const each = segment.endsWith('[]');
  const key = each ? segment.slice(0, -2) : segment;
  const last = index === segments.length - 1;

  // `[]` 만 있는 조각은 현재 노드 자체가 배열이라는 뜻이다.
  const target = key === '' ? node : (node as Record<string, unknown>)[key];

  if (each) {
    if (!Array.isArray(target)) return 0;

    let count = 0;
    for (let i = 0; i < target.length; i += 1) {
      if (last) {
        if (target[i] !== undefined) {
          target[i] = MASK;
          count += 1;
        }
      } else {
        count += applyPath(target[i], segments, index + 1);
      }
    }
    return count;
  }

  if (last) {
    if (key === '' || target === undefined) return 0;
    (node as Record<string, unknown>)[key] = MASK;
    return 1;
  }

  return applyPath(target, segments, index + 1);
}

/**
 * 이름으로 훑어 가리기 — 구조를 모를 때 쓴다.
 *
 * 연산 결과(대사 결과 등)는 어댑터 행을 `matches[].left` 처럼 임의 깊이로 품는다.
 * 경로 기반 마스킹은 그 모양을 다 적을 수 없으므로, 여기서는 `pii` 경로의 **마지막 조각**
 * (`rows[].approver` → `approver`)을 이름으로 보고 트리 전체에서 같은 이름의 속성을 가린다.
 * 덜 가리는 쪽보다 더 가리는 쪽이 안전하다.
 */
export function maskFieldsDeep<T>(root: T, fields: readonly string[]): { value: T; masked: number } {
  const names = new Set(fields);
  if (names.size === 0) return { value: root, masked: 0 };

  const clone = structuredClone(root);
  let masked = 0;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (names.has(key)) {
        record[key] = MASK;
        masked += 1;
      } else {
        walk(value);
      }
    }
  };

  walk(clone);
  return { value: clone, masked };
}

/** `rows[].approver` → `approver`. 이름 기반 마스킹이 볼 항목 이름들. */
export function piiFieldNames(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths
        .map((path) => path.split('.').pop() ?? '')
        .map((segment) => segment.replace(/\[\]$/, ''))
        .filter((segment) => segment !== '')
    )
  ];
}

/** 어댑터 출력값을 계약의 `pii` 경로 기준으로 가린다. 경로 뿌리는 출력 이름이다. */
export function maskAdapterValue(
  value: unknown,
  outputNames: readonly string[],
  piiPaths: readonly string[]
): { value: unknown; masked: number } {
  const rootName = outputNames[0];
  if (rootName === undefined || piiPaths.length === 0) return { value, masked: 0 };

  const result = maskAtPaths({ [rootName]: value } as Record<string, unknown>, piiPaths);

  return { value: result.value[rootName], masked: result.masked };
}

export interface EvidenceContract {
  name: string;
  version: number;
  output: string[];
  pii: string[];
  source: string;
  write: boolean;
}

export interface EvidenceWriteInput {
  workflow: WorkflowDoc;
  result: RunResult;
  /** 어댑터 이름 → 계약. 마스킹 경로와 버전이 여기서 온다. */
  contracts: Record<string, EvidenceContract>;
  finishedAt?: number;
}

export interface EvidenceSummary {
  runId: string;
  dir: string;
  files: string[];
  maskedFields: number;
  screenshots: number;
}

export class EvidencePack {
  readonly dir: string;
  readonly stepsDir: string;
  readonly rawDir: string;

  private shotCount = 0;

  constructor(baseDir: string, runId: string) {
    this.dir = path.join(baseDir, 'evidence', runId);
    this.stepsDir = path.join(this.dir, 'steps');
    this.rawDir = path.join(this.dir, 'raw');

    fs.mkdirSync(this.stepsDir, { recursive: true });
    fs.mkdirSync(this.rawDir, { recursive: true });
  }

  /**
   * 단계 스크린샷. 번호를 앞에 붙여 순서가 파일 이름만으로 드러나게 한다.
   * 실패해도 실행을 멈추지 않는다 — 증거가 하나 빠지는 것이 실행이 끊기는 것보다 낫다.
   */
  saveScreenshot(label: string, png: Buffer): string | null {
    this.shotCount += 1;
    const safe = label.replace(/[^\w.-]+/g, '-').slice(0, 60);
    const file = path.join(this.stepsDir, `${String(this.shotCount).padStart(4, '0')}-${safe}.png`);

    try {
      fs.writeFileSync(file, png);
      return file;
    } catch (error) {
      console.error(`[Evidence] 스크린샷 저장 실패 - 경로: ${file}`, error);
      return null;
    }
  }

  get screenshotCount(): number {
    return this.shotCount;
  }

  /** 실행이 끝난 뒤 한 번. JSON 4개와 raw/ 를 쓴다. */
  write(input: EvidenceWriteInput): EvidenceSummary {
    const { workflow, result, contracts } = input;
    const { state, verification } = result;
    let maskedFields = 0;

    const stepById = new Map(workflow.steps.map((step) => [step.id, step]));

    // ── extracted.json / raw/ ──
    const extracted: Record<string, unknown> = {};

    for (const record of state.steps) {
      const step = stepById.get(record.id);
      if (!step || !isAdapterStep(step)) continue;

      const contract = contracts[step.adapter];
      const entry = state.values[record.as];
      const masked = contract
        ? maskAdapterValue(entry?.value, contract.output, contract.pii)
        : { value: entry?.value, masked: 0 };
      maskedFields += masked.masked;

      extracted[record.as] = {
        step: record.id,
        adapter: step.adapter,
        adapterVersion: contract?.version ?? null,
        // 계약에 적힌 경로와 실제로 값을 얻은 경로. 다르면 폴백이 일어난 것이다.
        contractSource: contract?.source ?? null,
        actualSource: record.source,
        fellBack: contract !== undefined && contract.source !== record.source,
        piiPaths: contract?.pii ?? [],
        note: record.note,
        value: masked.value
      };

      const raw = state.values[`${record.as}.__raw`];
      if (raw !== undefined && workflow.evidence.raw) {
        const maskedRaw = contract
          ? maskAtPaths(raw.value, contract.pii)
          : { value: raw.value, masked: 0 };
        maskedFields += maskedRaw.masked;

        this.writeJson(path.join(this.rawDir, `${record.id}.json`), maskedRaw.value);
      }
    }

    // ── normalized.json ──
    const normalized: Record<string, unknown> = {};
    const piiFields = piiFieldNames(
      Object.values(contracts).flatMap((contract) => contract.pii)
    );

    for (const record of state.steps) {
      const step = stepById.get(record.id);
      if (!step || isAdapterStep(step)) continue;

      const entry = state.values[record.as];
      // 대사 결과는 어댑터 행을 `matches[].left` 처럼 품는다 — 경로가 아니라 이름으로 가린다.
      const masked = maskFieldsDeep(entry?.value, piiFields);
      maskedFields += masked.masked;

      normalized[record.as] = {
        step: record.id,
        op: step.op,
        source: entry?.source ?? null,
        value: masked.value
      };
    }

    // ── oracles.json ──
    const oracles = {
      verdict: result.verdict,
      composition: '최악값 (ADAPTER_BROKEN > FAIL > REVIEW > PASS)',
      adapterBroken: verification.adapterBroken,
      downgraded: verification.downgraded,
      outcomes: verification.outcomes.map((outcome, index) => ({
        rule: outcome.rule,
        ruleVersion: outcome.ruleVersion,
        severity: outcome.severity,
        verdict: outcome.verdict,
        ok: outcome.ok,
        message: outcome.message,
        note: workflow.oracles[index]?.note ?? null,
        args: workflow.oracles[index]?.args ?? {},
        sources: outcome.sources,
        downgraded: outcome.downgraded,
        detail: outcome.detail
      }))
    };

    // ── run.json ──
    const finishedAt = input.finishedAt ?? Date.now();
    const run = {
      runId: state.runId,
      workflowId: state.workflowId,
      workflowVersion: state.workflowVersion,
      adapterVersions: result.adapterVersions,
      ruleVersions: Object.fromEntries(
        verification.outcomes.map((outcome) => [outcome.rule, outcome.ruleVersion])
      ),
      inputs: state.inputs,
      status: state.status,
      verdict: result.verdict,
      adapterBroken: state.adapterBroken,
      startedAt: new Date(state.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - state.startedAt,
      steps: state.steps,
      // 출력 요약에도 어댑터 행이 섞여 든다(대사 매칭의 left/right). 같은 이름 마스킹을 건다 —
      // 실측으로 여기 결재자 이름이 남는 것을 잡았다(tests/evidence.test.ts).
      outputs: maskFieldsDeep(summarizeOutputs(result.outputs), piiFields).value,
      evidencePath: this.dir
    };

    this.writeJson(path.join(this.dir, 'extracted.json'), extracted);
    this.writeJson(path.join(this.dir, 'normalized.json'), normalized);
    this.writeJson(path.join(this.dir, 'oracles.json'), oracles);
    this.writeJson(path.join(this.dir, 'run.json'), run);

    return {
      runId: state.runId,
      dir: this.dir,
      files: fs.readdirSync(this.dir).sort(),
      maskedFields,
      screenshots: this.shotCount
    };
  }

  private writeJson(file: string, value: unknown): void {
    try {
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    } catch (error) {
      console.error(`[Evidence] 기록 실패 - 경로: ${file}`, error);
    }
  }
}

/** run.json 이 통째로 커지지 않게 목록형 출력은 건수와 앞 몇 건만 남긴다. */
function summarizeOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(outputs)) {
    out[name] = Array.isArray(value) ? { count: value.length, sample: value.slice(0, 3) } : value;
  }

  return out;
}
