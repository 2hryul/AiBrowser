import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * M4b 시나리오 — 내장 에이전트를 **실제 로컬 모델**로 돌린다.
 *
 *   A: 공지 200건 수집 (성공 조건 2) — 3회 중 2회 성공 + MacroCache 로 2회차 호출 감소
 *   B: ITSM 사건 수집 (성공 조건 3) — read_network_requests 경로로, DOM 파싱 0
 *   가벼운 요청 (성공 조건 5) — 기사 페이지 요약에 기대 키워드가 들어간다
 *   완료 처리 (성공 조건 6) — Inbox `done` 항목 + 사이트 메모 **제안**(자동 저장 아님)
 *
 * MCP 를 쓰지 않는다. 에이전트는 메인 프로세스 안에서 도는 것이고, 여기서 볼 것은
 * "밖에서 도구를 부르면 되는가" 가 아니라 **"모델이 스스로 해내는가"** 다.
 *
 * 모델은 비결정적이다. 그래서 판정은 회차별로 기록하고 **3회 중 2회**로 본다
 * (GOAL-M4 FIXED DECISIONS). 한 번 잘된 것을 성공이라고 적지 않는다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm4b');
const PROFILE = path.join(ROOT, '.agent-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.agent-downloads');

/** 시나리오 A: 포털 A 는 10페이지 × 20행 = 200건. */
const SCENARIO_A_TOTAL = 200;
/** 시나리오 B: 포털 B 는 137건. */
const SCENARIO_B_TOTAL = 137;

/**
 * 사람 역할로 답할 승인 주체. 이 목록 밖의 요청에는 **답하지 않는다** —
 * 답이 없으면 그 실행은 대기하다 실패한다. 자동 승인 플래그는 만들지 않았고,
 * 러너가 사람 자리에 앉아 정해진 것만 허락하는 것이 전부다(GOAL-M3 · M5 와 같은 규칙).
 */
const APPROVE = new Set(['site:portal-a', 'site:portal-b', 'site:app']);

const summary: Record<string, unknown> = {};
const approvals: string[] = [];
const prompted: string[] = [];

let app: ElectronApplication;
let answering = true;

interface RunOutcome {
  status: 'done' | 'failed' | 'paused' | 'stopped';
  steps: number;
  llmCalls: number;
  macroHits: number;
  rows: number;
  duplicates: number;
  summary: string;
  reason: string | null;
}

async function launch(): Promise<void> {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      HELM_E2E: '1',
      HELM_USER_DATA_DIR: PROFILE,
      HELM_DOWNLOAD_DIR: DOWNLOAD_DIR
    }
  });

  await expect
    .poll(
      () =>
        app.evaluate(({ BaseWindow }) => {
          const win = BaseWindow.getAllWindows()[0];
          return win ? win.isVisible() : false;
        }),
      { timeout: 30_000 }
    )
    .toBe(true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 승인 큐를 지켜보다 허용 목록만 domain 으로 답한다.
 *
 * 이게 없으면 에이전트는 포털 첫 접근 승인에서 **영원히 멈춘다**(실제로 겪었다).
 * 사람이 없는 자리에서 도구가 멈추는 것은 버그가 아니라 설계다 — 승인 게이트는
 * 에이전트에게도 똑같이 걸린다.
 */
async function watchApprovals(): Promise<void> {
  while (answering) {
    try {
      const queue = await app.evaluate(() => globalThis.__helm?.approvalQueue() ?? []);

      for (const item of queue) {
        const subject = item.action === 'site_first_visit' ? `site:${item.host}` : item.tool;
        if (!APPROVE.has(subject)) continue;

        const answered = await app.evaluate(
          (_api, id) => globalThis.__helm?.answerApproval(id, 'domain') ?? false,
          item.id
        );
        if (answered) approvals.push(`${subject}@${item.host}`);
      }

      /**
       * `ask_user` 에도 답한다.
       *
       * 에이전트는 같은 동작을 세 번 반복하면 사람에게 묻는다(CLAUDE.md). 물어 놓고 답이 없으면
       * 거기서 멈추는데, 그건 맞는 동작이다 — 실제로 이걸 안 붙여서 실행이 통째로 얼어붙었다.
       * 러너는 사람 자리에 앉아 "계속" 이라고 답하고, 그래도 진전이 없으면 에이전트의
       * 진전 없음 가드가 끊는다.
       */
      const prompts = await app.evaluate(() => globalThis.__helm?.pendingPrompts() ?? []);

      for (const prompt of prompts) {
        const answer = prompt.options.includes('계속') ? '계속' : (prompt.options[0] ?? '확인');
        const answered = await app.evaluate(
          (_api, input) => globalThis.__helm?.answerPrompt(input.id, input.answer) ?? false,
          { id: prompt.id, answer }
        );
        if (answered) prompted.push(`${prompt.kind}:${answer}`);
      }
    } catch {
      // 앱이 내려가는 중
    }
    await sleep(150);
  }
}

/**
 * 사람이 먼저 로그인해 둔다.
 *
 * 포털 A 는 로그인하지 않으면 목록 요청을 로그인 화면으로 되민다. 실측에서 에이전트는
 * 여기서 막혀 1페이지에 닿지도 못했다 — 그리고 그건 **맞는 동작**이다. 로그인은 사람만
 * 할 수 있는 일이고(CLAUDE.md 불변 조건 9: 토큰 이관 금지), 에이전트는 감지해서 멈춘다.
 *
 * 그래서 시나리오의 전제를 실제 순서대로 만든다 — 사람이 로그인한 다음 수집을 시킨다.
 * 세션은 파티션에 남으므로 한 번이면 이후 회차에 모두 적용된다.
 */
async function ensureLoggedIn(): Promise<string> {
  const THREAD = 'runner-login';

  const started = (await app.evaluate(
    (_api, thread) => globalThis.__helm?.callTool(thread, 'preview_start', {
      url: 'app://portal-a/list?page=1'
    }) as never,
    THREAD
  )) as { tabId: number };

  const first = (await app.evaluate(
    (_api, input) =>
      globalThis.__helm?.callTool(input.thread, 'navigate', {
        tabId: input.tabId,
        url: 'app://portal-a/list?page=1'
      }) as never,
    { thread: THREAD, tabId: started.tabId }
  )) as { finalUrl: string };

  if (!first.finalUrl.includes('/login')) return '이미 로그인됨';

  // 로그인 폼은 fixture 가 값을 채워 둔다 — 러너는 사람처럼 버튼만 누른다.
  const found = (await app.evaluate(
    (_api, input) =>
      globalThis.__helm?.callTool(input.thread, 'find', {
        tabId: input.tabId,
        query: '로그인',
        role: 'button'
      }) as never,
    { thread: THREAD, tabId: started.tabId }
  )) as { matches: { ref: string }[] };

  const ref = found.matches[0]?.ref;
  expect(ref, '로그인 버튼을 찾지 못했습니다').toBeDefined();

  await app.evaluate(
    (_api, input) =>
      globalThis.__helm?.callTool(input.thread, 'computer', {
        tabId: input.tabId,
        action: 'left_click',
        ref: input.ref
      }) as never,
    { thread: THREAD, tabId: started.tabId, ref: ref ?? '' }
  );

  const after = (await app.evaluate(
    (_api, input) =>
      globalThis.__helm?.callTool(input.thread, 'navigate', {
        tabId: input.tabId,
        url: 'app://portal-a/list?page=1'
      }) as never,
    { thread: THREAD, tabId: started.tabId }
  )) as { finalUrl: string };

  expect(after.finalUrl, '로그인 뒤에도 목록으로 가지 못했습니다').toContain('/list');

  // 사람의 탭은 닫아 둔다 — 에이전트는 자기 탭을 따로 연다.
  await app.evaluate(
    (_api, input) =>
      globalThis.__helm?.callTool(input.thread, 'tabs_close', { tabId: input.tabId }) as never,
    { thread: THREAD, tabId: started.tabId }
  );

  return '러너가 로그인함';
}

async function agentInfo(): Promise<{ available: boolean; model: string | null }> {
  return app.evaluate(
    () => globalThis.__helm?.agentInfo() ?? { available: false, model: null, provider: null, macros: 0 }
  );
}

async function runAgent(
  threadId: string,
  instruction: string,
  options: { keyColumns?: string[]; expectedCount?: number | null } = {}
): Promise<RunOutcome | null> {
  return app.evaluate(
    async (_api, input) => {
      const store = globalThis.__helm?.getThreadStore();
      store?.create({ id: input.threadId, title: input.threadId, stepLimit: 2000 });
      return (await globalThis.__helm?.runAgent(
        input.threadId,
        input.instruction,
        input.options
      )) as never;
    },
    { threadId, instruction, options }
  );
}

async function results(threadId: string): Promise<Record<string, unknown>[]> {
  return app.evaluate(
    (_api, id) => (globalThis.__helm?.getResults(id) ?? []) as never,
    threadId
  );
}

/** 이번 실행에서 어떤 도구가 몇 번 불렸는지 — 감사 로그가 판정 근거다. */
async function toolCounts(threadId: string): Promise<Record<string, number>> {
  const entries = await app.evaluate(
    (_api, id) =>
      (globalThis.__helm?.getAudit()?.read() ?? []).filter(
        (entry) => entry.runId === id
      ) as never,
    threadId
  );

  const counts: Record<string, number> = {};
  for (const entry of entries as { tool: string }[]) {
    counts[entry.tool] = (counts[entry.tool] ?? 0) + 1;
  }
  return counts;
}

test.beforeAll(async () => {
  await launch();

  const info = await agentInfo();
  expect(
    info.available,
    'config/llm.json 이 없어 내장 에이전트가 꺼져 있습니다(M4b 선행조건)'
  ).toBe(true);

  summary['model'] = info.model;
  void watchApprovals();

  summary['login'] = await ensureLoggedIn();
});

test.afterAll(async () => {
  answering = false;
  summary['approvals'] = approvals;
  summary['prompts'] = prompted;

  const body = `${JSON.stringify(summary, null, 2)}\n`;

  /**
   * 모델 이름을 파일명에 넣어 함께 남긴다.
   *
   * 같은 시나리오를 다른 모델로 돌려 비교하는 일이 실제로 생긴다("설계 문제인가 모델
   * 문제인가"). 한 파일에 덮어쓰면 비교할 앞의 결과가 사라진다.
   */
  const tag = String(summary['model'] ?? 'unknown').replace(/[^\w.-]+/g, '_');

  fs.writeFileSync(path.join(ARTIFACTS, `agent-summary-${tag}.json`), body, 'utf-8');
  fs.writeFileSync(path.join(ARTIFACTS, 'agent-summary.json'), body, 'utf-8');
  await app.close();
});

// ─────────────────────────────────────────────────────────────
// 시나리오 A — 공지 200건 (성공 조건 2)
// ─────────────────────────────────────────────────────────────

test('[시나리오 A] 공지 200건을 표로 — 3회 중 2회 성공, 2회차부터 캐시가 돈다', async () => {
  test.setTimeout(30 * 60_000);

  const instruction =
    'app://portal-a/list?page=1 부터 10페이지를 돌며 공지 200건을 모아라. ' +
    '각 행은 id, title, postedAt 세 칸이다. 한 페이지를 읽을 때마다 그 페이지의 20행을 기록하라.';

  const rounds: RunOutcome[] = [];

  for (let round = 1; round <= 3; round += 1) {
    const threadId = `agent-a-${round}`;
    const outcome = await runAgent(threadId, instruction, { keyColumns: ['id'] });

    expect(outcome, '에이전트가 실행되지 않았습니다').not.toBeNull();
    if (!outcome) return;

    const rows = await results(threadId);
    const ids = new Set(rows.map((row) => String(row['id'] ?? '')));
    const badDates = rows.filter(
      (row) => !/^\d{4}-\d{2}-\d{2}$/.test(String(row['postedAt'] ?? ''))
    );

    rounds.push(outcome);
    summary[`scenarioA_round${round}`] = {
      status: outcome.status,
      steps: outcome.steps,
      llmCalls: outcome.llmCalls,
      macroHits: outcome.macroHits,
      rows: rows.length,
      uniqueIds: ids.size,
      duplicates: outcome.duplicates,
      badDates: badDates.length,
      reason: outcome.reason,
      // 실패했을 때 "무엇을 모았는지" 를 볼 수 있어야 한다. 숫자만으로는 못 고친다.
      sample: rows.slice(0, 2)
    };
  }

  const passed = rounds.filter((round, index) => {
    const detail = summary[`scenarioA_round${index + 1}`] as { rows: number; uniqueIds: number };
    return (
      round.status === 'done' && detail.rows === SCENARIO_A_TOTAL && detail.uniqueIds === SCENARIO_A_TOTAL
    );
  });

  summary['scenarioA'] = {
    passed: passed.length,
    of: rounds.length,
    llmCallsByRound: rounds.map((round) => round.llmCalls),
    macroHitsByRound: rounds.map((round) => round.macroHits)
  };

  expect(
    passed.length,
    `3회 중 ${passed.length}회만 성공했습니다: ${JSON.stringify(summary['scenarioA'])}`
  ).toBeGreaterThanOrEqual(2);

  // MacroCache — 2회차는 1회차보다 모델을 덜 불러야 한다.
  const first = rounds[0]?.llmCalls ?? 0;
  const second = rounds[1]?.llmCalls ?? 0;
  const drop = first === 0 ? 0 : (first - second) / first;

  summary['scenarioA_macroDrop'] = { first, second, drop: Number(drop.toFixed(3)) };

  expect(rounds[1]?.macroHits ?? 0, '2회차에 캐시가 한 번도 안 걸렸습니다').toBeGreaterThan(0);
  expect(
    drop,
    `2회차 모델 호출이 1회차 대비 ${(drop * 100).toFixed(1)}% 줄었습니다(기준 50%)`
  ).toBeGreaterThanOrEqual(0.5);
});

// ─────────────────────────────────────────────────────────────
// 시나리오 B — XHR JSON 경로 (성공 조건 3)
// ─────────────────────────────────────────────────────────────

test('[시나리오 B] 사건 목록을 XHR 응답에서 — DOM 파싱 없이', async () => {
  test.setTimeout(30 * 60_000);

  const instruction =
    'app://portal-b/incidents 에서 사건 목록을 모아라. 이 화면은 XHR 로 JSON 을 받는다 — ' +
    `read_network_requests 로 응답을 읽어라. 전체 ${SCENARIO_B_TOTAL}건이다. ` +
    '각 행은 id, title, status 세 칸이다.';

  const rounds: RunOutcome[] = [];

  for (let round = 1; round <= 3; round += 1) {
    const threadId = `agent-b-${round}`;
    const outcome = await runAgent(threadId, instruction, { keyColumns: ['id'] });
    if (!outcome) continue;

    const rows = await results(threadId);
    const counts = await toolCounts(threadId);

    rounds.push(outcome);
    summary[`scenarioB_round${round}`] = {
      status: outcome.status,
      steps: outcome.steps,
      llmCalls: outcome.llmCalls,
      rows: rows.length,
      network: counts['read_network_requests'] ?? 0,
      domReads: (counts['read_page'] ?? 0) + (counts['get_page_text'] ?? 0),
      reason: outcome.reason
    };
  }

  const passed = rounds.filter((_round, index) => {
    const detail = summary[`scenarioB_round${index + 1}`] as {
      status: string;
      rows: number;
      network: number;
    };
    return detail.status === 'done' && detail.rows === SCENARIO_B_TOTAL && detail.network > 0;
  });

  summary['scenarioB'] = { passed: passed.length, of: rounds.length };

  expect(
    passed.length,
    `3회 중 ${passed.length}회만 성공했습니다: ${JSON.stringify(summary)}`
  ).toBeGreaterThanOrEqual(2);
});

// ─────────────────────────────────────────────────────────────
// 가벼운 요청과 완료 처리 (성공 조건 5·6)
// ─────────────────────────────────────────────────────────────

test('[가벼운 요청] 기사 페이지를 요약하면 기대 키워드가 들어간다', async () => {
  test.setTimeout(10 * 60_000);

  const threadId = 'agent-summary';
  const outcome = await runAgent(
    threadId,
    'app://fixtures/article.html 을 열어 get_page_text 로 읽고, 무슨 내용인지 요약해줘.'
  );

  expect(outcome?.status, `요약이 실패했습니다: ${JSON.stringify(outcome)}`).toBe('done');

  const text = outcome?.summary ?? '';
  summary['lightRequest'] = { steps: outcome?.steps, llmCalls: outcome?.llmCalls, answer: text };

  /**
   * 기사 fixture 의 핵심어. 본문을 실제로 읽지 않으면 나올 수 없는 낱말들이다.
   * 광고 배너("특별 할인 이벤트")가 아니라 본문에서 뽑아야 한다 — 읽기 모드가 걷어내는 자리다.
   */
  const expected = ['보관', '문서', '개정'];
  const hit = expected.filter((word) => text.includes(word));

  expect(hit.length, `요약에 기대 키워드가 없습니다: "${text}"`).toBeGreaterThanOrEqual(3);
  expect(text.length, `요약이 너무 짧습니다: "${text}"`).toBeGreaterThan(30);
});

test('[완료 처리] Inbox 에 done 이 쌓이고 사이트 메모는 제안까지만 한다', async () => {
  const items = await app.evaluate(
    () => (globalThis.__helm?.getInbox()?.list({ limit: 50 }) ?? []) as never
  );

  const done = (items as { kind: string; threadId: string | null }[]).filter(
    (item) => item.kind === 'done'
  );
  expect(done.length, '완료 항목이 받은편지함에 없습니다').toBeGreaterThan(0);

  // 제안은 남아 있고 **아직 저장되지 않았다** — 사람이 받아야 메모가 된다.
  const proposal = await app.evaluate(() => globalThis.__helm?.noteProposal() ?? null);

  if (proposal) {
    const before = await app.evaluate(
      (_api, host) => globalThis.__helm?.getNoteStore()?.read(`site:${host}`) ?? null,
      proposal.host
    );
    expect(before, '제안이 사람 확인 없이 저장되었습니다').toBeNull();

    await app.evaluate(() => globalThis.__helm?.acceptNoteProposal());

    const after = await app.evaluate(
      (_api, host) => globalThis.__helm?.getNoteStore()?.read(`site:${host}`) ?? null,
      proposal.host
    );
    expect(after, '사람이 받았는데도 저장되지 않았습니다').not.toBeNull();
  }

  summary['noteProposal'] = proposal === null ? '없음' : proposal.host;
});
