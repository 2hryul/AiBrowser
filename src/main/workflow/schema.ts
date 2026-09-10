import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * 워크플로우 YAML 스키마.
 *
 * 로드는 **거절이 기본**이다. 빠진 키·모르는 키·빈 오라클은 전부 로드 실패다.
 * 잘못된 워크플로우가 조용히 돌다가 엉뚱한 PASS 를 내는 것보다, 뜨지 않는 편이 낫다.
 *
 * 특히 두 가지를 못박는다:
 *   - **`prompt:` 키는 존재하지 않는다.** 워크플로우는 결정적 절차다. 프롬프트를 넣는 순간
 *     같은 입력이 다른 결과를 내고, 골든셋이 의미를 잃는다(GOAL-M5 IN SCOPE).
 *   - **`oracles` 가 비면 거부.** 검증하지 않는 워크플로우는 "검증 계층" 이 아니다.
 */

export class WorkflowLoadError extends Error {
  readonly issues: string[];

  constructor(id: string, issues: string[]) {
    super(`[workflow] ${id} 로드 실패\n  ${issues.join('\n  ')}`);
    this.name = 'WorkflowLoadError';
    this.issues = issues;
  }
}

const InputSpec = z.object({
  type: z.enum(['string', 'number', 'date']),
  required: z.boolean().default(true),
  description: z.string().optional()
});

/** 어댑터 단계 — 바깥 시스템에서 값을 가져온다(ToolSurface 를 통한다). */
const AdapterStep = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  with: z.record(z.string(), z.unknown()).default({}),
  as: z.string().min(1),
  retry: z
    .object({ max: z.number().int().min(0).max(5).default(0), delayMs: z.number().int().min(0).default(200) })
    .default({ max: 0, delayMs: 200 })
});

/** 내장 연산 단계 — 결정적이다. */
const OpStep = z.object({
  id: z.string().min(1),
  op: z.enum(['normalize', 'reconcile', 'classify', 'lookup', 'aggregate']),
  with: z.record(z.string(), z.unknown()).default({}),
  as: z.string().min(1),
  retry: z
    .object({ max: z.number().int().min(0).max(5).default(0), delayMs: z.number().int().min(0).default(200) })
    .default({ max: 0, delayMs: 200 })
});

const Step = z.union([AdapterStep, OpStep]);

const Oracle = z.object({
  rule: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  severity: z.enum(['fail', 'review']).default('fail'),
  note: z.string().optional()
});

export const WorkflowSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, 'id 는 소문자·숫자·밑줄만 씁니다'),
    /** 정수 단조 증가. 실행 기록에 동봉된다(FIXED DECISIONS). */
    version: z.number().int().min(1),
    description: z.string().optional(),
    inputs: z.record(z.string(), InputSpec),
    steps: z.array(Step).min(1),
    outputs: z.record(z.string(), z.string()),
    oracles: z.array(Oracle).min(1, 'oracles 가 비어 있는 워크플로우는 로드할 수 없습니다'),
    evidence: z.object({
      screenshots: z.boolean().default(true),
      raw: z.boolean().default(true)
    })
  })
  .strict();

export type WorkflowDoc = z.infer<typeof WorkflowSchema>;
export type StepDoc = z.infer<typeof Step>;
export type OracleDoc = z.infer<typeof Oracle>;

export function isAdapterStep(step: StepDoc): step is z.infer<typeof AdapterStep> {
  return 'adapter' in step;
}

/** 필수 최상위 키 — 하나라도 없으면 로드 실패다(GOAL-M5). */
const REQUIRED_KEYS = ['id', 'version', 'inputs', 'steps', 'outputs', 'oracles', 'evidence'];

/**
 * YAML 문자열 → 워크플로우.
 * @param source 파일 내용
 * @param label 오류 메시지에 쓸 이름(경로 등)
 */
export function loadWorkflow(source: string, label = '(문자열)'): WorkflowDoc {
  let raw: unknown;

  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new WorkflowLoadError(label, [`YAML 구문 오류: ${(error as Error).message}`]);
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowLoadError(label, ['최상위가 객체가 아닙니다']);
  }

  const record = raw as Record<string, unknown>;
  const issues: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) issues.push(`필수 키 누락: ${key}`);
  }

  // prompt 는 어디에 있어도 거부한다 — 단계 안에 숨어 있어도 마찬가지다.
  if ('prompt' in record) issues.push('`prompt:` 키는 워크플로우에 존재하지 않습니다');

  if (Array.isArray(record['steps'])) {
    (record['steps'] as unknown[]).forEach((step, index) => {
      if (step !== null && typeof step === 'object' && 'prompt' in (step as object)) {
        issues.push(`steps[${index}]: \`prompt:\` 키는 워크플로우에 존재하지 않습니다`);
      }
    });
  }

  if (issues.length > 0) throw new WorkflowLoadError(label, issues);

  const parsed = WorkflowSchema.safeParse(record);
  if (!parsed.success) {
    throw new WorkflowLoadError(
      label,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(최상위)'}: ${issue.message}`)
    );
  }

  const doc = parsed.data;

  // 단계 id 와 결과 이름은 유일해야 한다 — 겹치면 앞 값이 조용히 덮인다.
  const stepIds = new Set<string>();
  const names = new Set<string>();
  const nameIssues: string[] = [];

  for (const step of doc.steps) {
    if (stepIds.has(step.id)) nameIssues.push(`중복 단계 id: ${step.id}`);
    stepIds.add(step.id);

    if (names.has(step.as)) nameIssues.push(`중복 결과 이름: ${step.as}`);
    names.add(step.as);
  }

  if (nameIssues.length > 0) throw new WorkflowLoadError(doc.id, nameIssues);

  return doc;
}
