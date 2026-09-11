import { stringify as stringifyYaml } from 'yaml';
import type { ThreadMessage } from '../persistence/ThreadStore';
import { loadWorkflow, WorkflowLoadError, type WorkflowDoc } from './schema';

/**
 * 승격 — 스레드의 도구 호출 기록에서 워크플로우 초안 YAML 을 만든다.
 *
 * "한 번 손으로 해 본 절차" 와 "매일 돌릴 수 있는 절차" 사이의 간격을 메우는 자리다.
 * 만드는 것은 **초안**이고, 일부러 불완전하다:
 *
 *   - 수집 단계는 어댑터 이름으로 묶고, 인자에 나온 날짜는 `${inputs.date}` 로 바꾼다
 *   - 판정 단계(`oracles`)는 **비워 둔다**. 무엇이 "맞다" 인지는 도구 호출 기록에 없다.
 *     사람이 채워야 하고, 비면 로드가 거부되므로 빈 채로 저장할 수도 없다
 *
 * 자동으로 오라클을 붙이지 않는 이유가 이 계층의 전부다. 기록에서 짐작한 오라클은
 * 그날의 결과를 그대로 "정답" 으로 굳혀 버린다 — 처음 실행이 틀렸으면 그 틀림이 기준이 된다.
 */

/** 초안이 알아보는 도구 → 어댑터 후보. 모르는 도구는 주석으로만 남는다. */
const ADAPTER_HINTS: { match: (url: string) => boolean; adapter: string; note: string }[] = [
  {
    match: (url) => url.includes('portal-h-settle'),
    adapter: 'portal_settle_daily',
    note: '정산 포털 — API(network) 우선, 실패 시 화면(dom) 폴백'
  },
  {
    match: (url) => url.includes('portal-h-ledger'),
    adapter: 'portal_ledger_daily',
    note: '회계 시스템 — 화면(dom) + xlsx 대조'
  }
];

/** 날짜처럼 보이는 인자는 입력으로 끌어올린다 — 그러지 않으면 그날만 도는 워크플로우가 된다. */
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/;

export interface PromoteInput {
  threadId: string;
  title: string;
  messages: readonly ThreadMessage[];
}

export interface DraftStep {
  id: string;
  adapter?: string;
  op?: string;
  with: Record<string, unknown>;
  as: string;
}

export interface PromoteResult {
  /** 사람이 편집할 초안 YAML */
  yaml: string;
  /** 제안된 워크플로우 id */
  workflowId: string;
  /** 기록에서 알아본 수집 단계 */
  steps: DraftStep[];
  /** 초안이 끌어올린 입력 */
  inputs: string[];
  /** 사람이 해야 할 일 — UI 가 그대로 보여 준다 */
  todo: string[];
  /** 알아보지 못한 도구 호출(초안에 들어가지 않았다) */
  skipped: { tool: string; reason: string }[];
}

/**
 * 워크플로우 id 를 짓는다.
 *
 * id 규칙은 소문자로 시작하는 소문자·숫자·밑줄이다(schema.ts). 한국어 제목은 그 규칙을
 * 통과할 수 없으므로 **수집 대상 이름**으로 짓는다(`settle` + `ledger` → `settle_vs_ledger_daily`).
 * 제목을 음절 단위로 옮겨 적는 것보다 무엇을 대조하는지가 이름에 남는 편이 낫다.
 * 어느 쪽도 못 만들면 시각을 붙인다 — 사람이 텍스트에서 바로 고칠 수 있다.
 */
function draftId(title: string, collectors: readonly string[]): string {
  const fromTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (/^[a-z]/.test(fromTitle)) return fromTitle.slice(0, 48);
  if (collectors.length >= 2) return `${collectors.join('_vs_')}_daily`.slice(0, 48);
  if (collectors.length === 1) return `${collectors[0] as string}_daily`;

  return `workflow_${Date.now().toString(36)}`;
}

/** 도구 호출 인자에서 주소를 찾는다. navigate·tabs_create·download 가 각각 다른 이름을 쓴다. */
function urlOf(args: unknown): string {
  if (args === null || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  return String(record['url'] ?? '');
}

export function promoteThread(input: PromoteInput): PromoteResult {
  const calls = input.messages.filter((message) => message.tool !== null);
  const steps: DraftStep[] = [];
  const skipped: { tool: string; reason: string }[] = [];
  const seenAdapters = new Set<string>();
  let dateValue: string | null = null;

  for (const call of calls) {
    const tool = call.tool as string;
    const url = urlOf(call.args);

    const found = DATE_PATTERN.exec(url) ?? DATE_PATTERN.exec(JSON.stringify(call.args ?? ''));
    if (found && dateValue === null) dateValue = found[0];

    const hint = ADAPTER_HINTS.find((candidate) => url !== '' && candidate.match(url));

    if (!hint) {
      // 같은 어댑터에 딸린 후속 호출(조회 클릭·본문 읽기)은 어댑터 안에 들어 있으므로 버린다.
      skipped.push({ tool, reason: url === '' ? '주소 없는 호출' : `어댑터로 묶이지 않는 주소: ${url}` });
      continue;
    }

    if (seenAdapters.has(hint.adapter)) continue;
    seenAdapters.add(hint.adapter);

    const name = hint.adapter.replace(/^portal_/, '').replace(/_daily$/, '');
    steps.push({
      id: `fetch_${name}`,
      adapter: hint.adapter,
      with: { date: '${inputs.date}' },
      as: name
    });
  }

  const names = steps.map((step) => step.as);
  const workflowId = draftId(input.title, names);

  // 수집이 둘 이상이면 대사 초안까지 붙인다. 하나뿐이면 사람이 무엇을 대조할지 정해야 한다.
  const opSteps: DraftStep[] =
    names.length >= 2
      ? [
          {
            id: 'normalize_left',
            op: 'normalize',
            with: {
              rows: `\${${names[0] as string}}`,
              fields: { txId: 'id', amount: 'amount', date: 'date' }
            },
            as: `${names[0] as string}_n`
          },
          {
            id: 'normalize_right',
            op: 'normalize',
            with: {
              rows: `\${${names[1] as string}}`,
              fields: { txId: 'id', amount: 'amount', date: 'date' }
            },
            as: `${names[1] as string}_n`
          },
          {
            id: 'match',
            op: 'reconcile',
            with: {
              left: `\${${names[0] as string}_n}`,
              right: `\${${names[1] as string}_n}`,
              key: 'txId',
              amountField: 'amount',
              tolerance: 0,
              fuzzyDistance: 1
            },
            as: 'recon'
          }
        ]
      : [];

  const draft = {
    id: workflowId,
    version: 1,
    description: `${input.title} — 스레드 ${input.threadId} 의 도구 호출 기록에서 승격한 초안`,
    inputs: {
      date: {
        type: 'date',
        required: true,
        description: dateValue === null ? '대상 영업일 (YYYY-MM-DD)' : `대상 영업일 (기록에서 본 값: ${dateValue})`
      }
    },
    steps: [...steps, ...opSteps].map((step) => ({
      id: step.id,
      ...(step.adapter === undefined ? {} : { adapter: step.adapter }),
      ...(step.op === undefined ? {} : { op: step.op }),
      with: step.with,
      as: step.as
    })),
    outputs:
      opSteps.length > 0
        ? {
            exact: 'recon.counts.exact',
            onlyLeftRows: 'recon.onlyLeft',
            onlyRightRows: 'recon.onlyRight',
            mismatchedRows: 'recon.mismatched'
          }
        : Object.fromEntries(names.map((name) => [name, name])),
    // 비어 있다. 사람이 채우기 전에는 로드되지 않는다 — 그게 이 칸의 목적이다.
    oracles: [] as unknown[],
    evidence: { screenshots: true, raw: true }
  };

  const header = [
    '# 승격 초안 — 그대로는 로드되지 않는다.',
    '#',
    '# `oracles` 가 비어 있기 때문이다(schema.ts 가 거부한다). 무엇이 "맞다" 인지는',
    '# 도구 호출 기록에 없으므로 사람이 정해야 한다. 붙일 수 있는 규칙:',
    '#   sum_equal · ratio_gte · empty · required_fields · format · cross_equal · date_order',
    '#',
    '# 예)',
    '#   - rule: sum_equal',
    '#     args: { left: left_total, right: right_total, tolerance: 0 }',
    '#     severity: fail',
    '',
    ...ADAPTER_HINTS.filter((hint) => seenAdapters.has(hint.adapter)).map(
      (hint) => `# ${hint.adapter}: ${hint.note}`
    ),
    ''
  ].join('\n');

  const todo = ['`oracles` 를 1개 이상 채운다 (비면 저장할 수 없다)'];
  if (steps.length === 0) todo.push('수집 단계를 알아보지 못했다 — 어댑터를 직접 적어야 한다');
  if (dateValue === null) todo.push('입력 `date` 가 기록에 없었다 — 입력 정의를 확인한다');
  if (opSteps.length === 0 && steps.length === 1) {
    todo.push('수집이 하나뿐이다 — 무엇과 대조할지 단계를 추가한다');
  }

  return {
    yaml: `${header}${stringifyYaml(draft, { lineWidth: 100 })}`,
    workflowId,
    steps: [...steps, ...opSteps],
    inputs: ['date'],
    todo,
    skipped
  };
}

export interface SaveCheck {
  ok: boolean;
  /** 로드가 통과하면 파싱된 워크플로우 */
  workflow: WorkflowDoc | null;
  issues: string[];
}

/**
 * 저장 전 검사. 실제 로더를 그대로 쓴다 — UI 전용 검사기를 따로 두면 둘이 어긋난다.
 * 사람이 오라클을 채웠는지, `prompt:` 를 넣지 않았는지가 여기서 걸린다.
 */
export function checkDraft(source: string): SaveCheck {
  try {
    return { ok: true, workflow: loadWorkflow(source, '(편집 중)'), issues: [] };
  } catch (error) {
    if (error instanceof WorkflowLoadError) {
      return { ok: false, workflow: null, issues: error.issues };
    }
    return { ok: false, workflow: null, issues: [(error as Error).message] };
  }
}
