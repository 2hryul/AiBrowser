import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 검증 계층 E2E (`npm run test:workflow-e2e`) — GOAL-M5 성공 조건 4(승격 UI)·5(사다리)·8(예약).
 *
 * 여기서만 알 수 있는 것들을 본다:
 *
 *   - **사다리**: 진짜 XHR 에서 값을 얻고(`network`), 정산 API 를 끄면 화면으로 내려가며
 *     그 변화가 `source` 로 기록에 남는다. 가짜 IO 로는 "진짜 XHR 이 잡히는가" 를 볼 수 없다
 *   - **승격 UI**: 스레드 기록 → 초안 YAML → 오라클 없는 초안은 저장 거부 → 사람이 오라클을
 *     붙이면 저장 → 목록에 뜬다. 이 거부가 이 계층의 안전장치다
 *   - **예약**: 1분 뒤 cron 이 실제로 돌아 받은편지함에 판정·증거 경로가 들어온다
 *
 * 승인은 스펙이 사람 역할로 답한다(허용 목록만, `domain`). 자동 승인 플래그는 없다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm5');
const PROFILE = path.join(ROOT, '.w-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.w-downloads');

const WORKFLOW = 'settle_vs_ledger_daily';
const DATE = '2026-03-02';
const FALLBACK_DATE = '2026-03-03';

/** 스펙이 사람 대신 domain 으로 답하는 주체. 그 밖에는 답하지 않는다. */
const APPROVE = new Set(['site:portal-h-settle', 'site:portal-h-ledger', 'download']);

const summary: Record<string, unknown> = {};

let app: ElectronApplication;
let answering = true;
let approvalWatcher: Promise<void>;
const approvals: string[] = [];

// ─────────────────────────────────────────────────────────────

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      HELM_E2E: '1',
      HELM_USER_DATA_DIR: PROFILE,
      HELM_DOWNLOAD_DIR: DOWNLOAD_DIR,
      HELM_EVIDENCE_DIR: path.join(ARTIFACTS, 'e2e'),
      HELM_MCP_DISABLED: '1'
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

/** 승인 큐를 지켜보다 허용 목록만 domain 으로 답한다. 스펙이 도는 동안 계속 돈다. */
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
    } catch {
      // 앱이 내려가는 중
    }
    await sleep(120);
  }
}

async function captureShell(fileName: string): Promise<string> {
  const base64 = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) return '';
    return (await shell.webContents.capturePage()).toPNG().toString('base64');
  });

  if (base64 === '') return '';
  fs.writeFileSync(path.join(ARTIFACTS, fileName), Buffer.from(base64, 'base64'));
  return fileName;
}

/** 셸 DOM 을 들여다본다 — 승격 UI 가 실제로 그려졌는지 보는 통로. */
function shellEval(expression: string): Promise<string> {
  return app.evaluate(async (_api, expr) => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[workflow-e2e] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(expr)) as string;
  }, expression);
}

function runWorkflow(date: string, runId: string): Promise<{
  verdict: string;
  sources: { adapter: string | null; source: string; note: string | null }[];
  evidence: { dir: string; screenshots: number; maskedFields: number };
} | null> {
  return app.evaluate(
    async (_api, input) =>
      (await globalThis.__helm?.runWorkflow(input.workflow, { date: input.date }, input.runId)) ?? null,
    { workflow: WORKFLOW, date, runId }
  );
}

// ─────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(ARTIFACTS, 'e2e'), { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  await launch();
  approvalWatcher = watchApprovals();
});

test.afterAll(async () => {
  answering = false;
  await approvalWatcher?.catch(() => undefined);
  await app?.close().catch(() => undefined);

  fs.writeFileSync(
    path.join(ARTIFACTS, 'workflow-e2e.json'),
    `${JSON.stringify({ ...summary, approvals }, null, 2)}\n`,
    'utf-8'
  );
});

// ── 성공 조건 5: 구조화 우선 사다리 ──────────────────────────

test('[사다리] 정산은 network 로, 회계는 dom(+xlsx) 로 얻는다', async () => {
  const enabled = await app.evaluate(() => globalThis.__helm?.setSettleApi(true) ?? false);
  expect(enabled).toBe(true);

  const result = await runWorkflow(DATE, 'e2e-network');
  expect(result, '워크플로우가 결과를 돌려주지 않았습니다').not.toBeNull();

  const settle = result?.sources.find((step) => step.adapter === 'portal_settle_daily');
  const ledger = result?.sources.find((step) => step.adapter === 'portal_ledger_daily');

  // 정산 화면은 표를 그리지만 진짜 출처는 XHR 이다. 화면에서 긁었으면 dom 이 찍힌다.
  expect(settle?.source, '정산을 network 로 얻지 못했습니다').toBe('network');
  expect(ledger?.source, '회계를 dom 으로 얻지 못했습니다').toBe('dom');
  expect(ledger?.note ?? '', 'xlsx 대조를 하지 않았습니다').toContain('xlsx');

  // 정상 20일치 중 하루 — 판정은 PASS 여야 한다.
  expect(result?.verdict).toBe('PASS');

  // 증거 팩에 실제 스크린샷이 들어갔는가(조건 7의 E2E 몫)
  expect(result?.evidence.screenshots ?? 0).toBeGreaterThan(0);
  expect(result?.evidence.maskedFields ?? 0).toBeGreaterThan(0);

  const extracted = JSON.parse(
    fs.readFileSync(path.join(result?.evidence.dir ?? '', 'extracted.json'), 'utf-8')
  ) as Record<string, { actualSource: string; fellBack: boolean; value: { approver?: string }[] }>;

  expect(extracted['settle']?.actualSource).toBe('network');
  expect(extracted['settle']?.fellBack).toBe(false);
  expect(extracted['settle']?.value[0]?.approver, '결재자가 마스킹되지 않았습니다').toBe('***');

  summary['ladder_network'] = {
    settle: settle?.source,
    ledger: ledger?.source,
    verdict: result?.verdict,
    screenshots: result?.evidence.screenshots
  };
});

test('[사다리] 정산 API 를 끄면 dom 으로 폴백하고 source 변경이 기록된다', async () => {
  const disabled = await app.evaluate(() => globalThis.__helm?.setSettleApi(false) ?? true);
  expect(disabled).toBe(false);

  try {
    const result = await runWorkflow(FALLBACK_DATE, 'e2e-fallback');
    expect(result).not.toBeNull();

    const settle = result?.sources.find((step) => step.adapter === 'portal_settle_daily');
    expect(settle?.source, 'API 가 죽었는데도 network 라고 말합니다').toBe('dom');
    expect(settle?.note ?? '').toContain('폴백');

    // 폴백해도 판정은 같아야 한다 — 값이 같기 때문이다. 경로만 달라진다.
    expect(result?.verdict).toBe('PASS');

    const extracted = JSON.parse(
      fs.readFileSync(path.join(result?.evidence.dir ?? '', 'extracted.json'), 'utf-8')
    ) as Record<string, { contractSource: string; actualSource: string; fellBack: boolean }>;

    expect(extracted['settle']?.contractSource).toBe('network');
    expect(extracted['settle']?.actualSource).toBe('dom');
    expect(extracted['settle']?.fellBack, '폴백 사실이 기록되지 않았습니다').toBe(true);

    const raw = JSON.parse(
      fs.readFileSync(path.join(result?.evidence.dir ?? '', 'raw', 'fetch_settle.json'), 'utf-8')
    ) as { fallback?: string; apiStatus?: number };

    expect(raw.fallback).toBe('dom');
    expect(raw.apiStatus, 'API 실패 상태가 남지 않았습니다').toBe(503);

    summary['ladder_fallback'] = {
      source: settle?.source,
      apiStatus: raw.apiStatus,
      verdict: result?.verdict
    };
  } finally {
    await app.evaluate(() => globalThis.__helm?.setSettleApi(true));
  }
});

// ── 성공 조건 4: 승격 UI ─────────────────────────────────────

test('[승격] 스레드 기록 → 초안 YAML → 오라클 없으면 저장 거부 → 붙이면 저장', async () => {
  // 자유 조작으로 대사를 한 번 해 본 스레드를 만든다(도구 호출 기록이 승격의 입력이다).
  const threadId = await app.evaluate((_api, date) => {
    const store = globalThis.__helm?.getThreadStore();
    if (!store) throw new Error('ThreadStore 없음');

    const thread = store.create({ id: 'promote-source', title: '정산 회계 대사' });

    store.append(thread.id, { role: 'human', text: `${date} 정산과 회계를 맞춰 줘` });
    store.append(thread.id, {
      role: 'tool',
      tool: 'tabs_create',
      args: { url: `app://portal-h-settle/?date=${date}` },
      result: { tabId: 2 }
    });
    store.append(thread.id, { role: 'tool', tool: 'find', args: { query: '조회' }, result: { matches: 1 } });
    store.append(thread.id, {
      role: 'tool',
      tool: 'read_network_requests',
      args: { urlPattern: '/api/settlements' },
      result: { requests: 1 }
    });
    store.append(thread.id, {
      role: 'tool',
      tool: 'navigate',
      args: { url: `app://portal-h-ledger/?date=${date}&q=1` },
      result: { ok: true }
    });
    store.append(thread.id, {
      role: 'tool',
      tool: 'download',
      args: { url: `app://portal-h-ledger/download.xlsx?date=${date}` },
      result: { bytes: 4096 }
    });

    return thread.id;
  }, DATE);

  expect(threadId).toBe('promote-source');

  // ── 여기서부터는 실제 화면을 누른다. 승격은 UI 기능이므로 UI 로 확인한다. ──
  await app.evaluate(() => globalThis.__helm?.setPanel('threads'));
  await sleep(600);

  await shellEval(
    `(() => { document.querySelector('[data-thread-id="promote-source"]').click(); return 'ok'; })()`
  );
  await sleep(300);

  const promoted = await shellEval(
    `(() => {
       const button = document.querySelector('[data-thread-promote]');
       if (!button) return 'no-button';
       button.click();
       return 'ok';
     })()`
  );
  expect(promoted, '스레드에 "워크플로우로 승격" 버튼이 없습니다').toBe('ok');

  // 패널이 바뀌고 초안이 그려지기를 기다린다.
  await expect
    .poll(() => shellEval(`String(!!document.querySelector('[data-promote-draft]'))`), {
      message: '승격 초안 편집기 대기',
      timeout: 15_000
    })
    .toBe('true');

  summary['promote_draft_shot'] = await captureShell('promote-draft.png');

  const draftText = await shellEval(`document.querySelector('[data-promote-draft]').value`);
  const todoCount = await shellEval(
    `String(document.querySelector('[data-promote-todo]').getAttribute('data-promote-todo'))`
  );

  // 초안에는 수집 단계 2개와 대사 초안이 들어 있고, `prompt:` 는 없다.
  expect(draftText).toContain('adapter: portal_settle_daily');
  expect(draftText).toContain('adapter: portal_ledger_daily');
  expect(draftText).toContain('op: reconcile');
  expect(draftText).not.toContain('prompt:');
  expect(draftText).toContain('oracles: []');
  expect(Number(todoCount), '사람이 할 일 안내가 없습니다').toBeGreaterThan(0);

  // 기획 v0.2 6장 형식과 같은 최상위 키를 갖춘다.
  for (const key of ['id:', 'version:', 'inputs:', 'steps:', 'outputs:', 'oracles:', 'evidence:']) {
    expect(draftText, `초안에 ${key} 가 없습니다`).toContain(key);
  }

  // 승격이 붙인 id — 수집 대상 이름에서 나온다.
  expect(draftText).toContain('id: settle_vs_ledger_daily');

  // ── 오라클 없이 검사 → 거부 ──
  await shellEval(`(() => { document.querySelector('[data-promote-check-run]').click(); return 'ok'; })()`);
  await sleep(400);

  const rejected = await shellEval(
    `(() => {
       const box = document.querySelector('[data-promote-check]');
       return (box?.getAttribute('data-promote-check') ?? '') + '|' + (box?.textContent ?? '');
     })()`
  );

  expect(rejected.startsWith('error'), `오라클 없는 초안이 통과했습니다 (${rejected})`).toBe(true);
  expect(rejected).toContain('oracles');
  summary['promote_reject_shot'] = await captureShell('promote-reject.png');

  // ── 사람이 오라클을 붙인다 ──
  // 저장 id 는 바꾼다 — 실제 `settle_vs_ledger_daily.yaml` 을 시험 저장으로 덮으면 안 된다.
  const edited = `${draftText
    .replace('id: settle_vs_ledger_daily', 'id: settle_vs_ledger_promoted')
    .replace('oracles: []', '')}
oracles:
  - rule: empty
    args:
      target: recon.onlyLeft
    severity: fail
    note: 정산에 있는데 전표가 없는 거래
  - rule: ratio_gte
    args:
      numerator: recon.counts.exact
      denominator: recon.counts.left
      min: 1
    severity: review
    note: 거래번호가 정확히 맞지 않은 건은 사람이 확인한다
`;

  // React 제어 컴포넌트라 value 를 직접 넣고 input 이벤트를 흘려야 상태가 따라온다.
  await shellEval(
    `(() => {
       const area = document.querySelector('[data-promote-draft]');
       const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
       setter.call(area, ${JSON.stringify(edited)});
       area.dispatchEvent(new Event('input', { bubbles: true }));
       return 'ok';
     })()`
  );
  await sleep(200);

  await shellEval(`(() => { document.querySelector('[data-promote-save]').click(); return 'ok'; })()`);

  await expect
    .poll(
      () =>
        shellEval(
          `String(document.querySelector('[data-workflow-message]')?.textContent ?? '')`
        ),
      { message: '저장 결과 대기', timeout: 15_000 }
    )
    .toContain('settle_vs_ledger_promoted');

  summary['promote_saved_shot'] = await captureShell('promote-panel.png');

  // 파일이 실제로 생겼고, 목록에 로드 오류 없이 뜬다.
  const savedFile = path.join(ROOT, 'workflows', 'settle_vs_ledger_promoted.yaml');
  expect(fs.existsSync(savedFile), '저장 파일이 없습니다').toBe(true);

  const listed = await app.evaluate(() => globalThis.__helm?.listWorkflows() ?? []);
  const entry = listed.find((item) => item.id === 'settle_vs_ledger_promoted');

  expect(entry, '저장한 워크플로우가 목록에 없습니다').toBeTruthy();
  expect(entry?.error).toBeNull();

  // 저장된 것이 실제로 돌고, 판정도 나온다 — 승격이 "돌아가는 것" 을 만들었는지 본다.
  const promotedRun = await app.evaluate(
    async (_api, date) =>
      (await globalThis.__helm?.runWorkflow('settle_vs_ledger_promoted', { date }, 'e2e-promoted')) ?? null,
    DATE
  );
  expect(promotedRun?.verdict).toBe('PASS');

  await app.evaluate(() => globalThis.__helm?.setPanel('none'));

  // 시험용 워크플로우는 치운다 — 저장소에 남으면 eval 목록이 지저분해진다.
  fs.rmSync(savedFile, { force: true });

  summary['promote'] = {
    threadId,
    draftId: 'settle_vs_ledger_daily',
    savedId: 'settle_vs_ledger_promoted',
    rejected: rejected.split('|')[0],
    todo: Number(todoCount),
    promotedVerdict: promotedRun?.verdict
  };
});

// ── 성공 조건 8: 예약 실행 ───────────────────────────────────

test('[예약] 1분 뒤 cron 이 돌아 받은편지함에 판정·증거 경로가 들어온다', async () => {
  // 다음 분의 0초에 뜨도록 cron 을 만든다. "1분 뒤" 를 분 단위 cron 으로 표현하는 방법이다.
  const target = new Date(Date.now() + 60_000);
  const expression = `0 ${target.getMinutes()} ${target.getHours()} * * *`;

  const before = await app.evaluate(() => globalThis.__helm?.getInbox()?.list({ limit: 100 }).length ?? 0);

  const entry = await app.evaluate(
    (_api, input) =>
      globalThis.__helm?.addSchedule({
        id: 'm5-eval-minute',
        workflowId: input.workflow,
        cron: input.cron,
        inputs: { date: input.date }
      }) ?? null,
    { workflow: WORKFLOW, cron: expression, date: DATE }
  );

  expect(entry, '예약 등록에 실패했습니다').not.toBeNull();
  expect(entry?.cron).toBe(expression);

  // cron 이 뜰 때까지 기다린다(최대 100초). 예약은 사람이 없을 때 도는 것이 전부라
  // "지금 실행" 버튼으로 대체하지 않는다.
  const item = await expect
    .poll(
      async () =>
        app.evaluate(() => {
          const items = globalThis.__helm?.getInbox()?.list({ limit: 100 }) ?? [];
          const found = items.find((row) => row.threadId === 'schedule:m5-eval-minute');
          return found ? JSON.stringify(found) : '';
        }),
      { message: '예약 실행 결과가 받은편지함에 오기를 대기', timeout: 100_000, intervals: [2000] }
    )
    .not.toBe('')
    .then(() =>
      app.evaluate(() => {
        const items = globalThis.__helm?.getInbox()?.list({ limit: 100 }) ?? [];
        return items.find((row) => row.threadId === 'schedule:m5-eval-minute') ?? null;
      })
    );

  expect(item, '받은편지함 항목이 없습니다').not.toBeNull();
  expect(item?.kind).toBe('result');
  expect(item?.title ?? '').toContain('PASS');
  expect(item?.evidencePath ?? '', '증거 경로가 없습니다').not.toBe('');
  expect(fs.existsSync(path.join(item?.evidencePath ?? '', 'oracles.json'))).toBe(true);

  const after = await app.evaluate(() => globalThis.__helm?.getInbox()?.list({ limit: 100 }).length ?? 0);
  expect(after).toBeGreaterThan(before);

  const schedule = await app.evaluate(
    () => globalThis.__helm?.getScheduler()?.list().find((row) => row.id === 'm5-eval-minute') ?? null
  );
  expect(schedule?.runCount).toBeGreaterThanOrEqual(1);
  expect(schedule?.lastVerdict).toBe('PASS');

  await app.evaluate(() => globalThis.__helm?.setPanel('inbox'));
  await sleep(700);
  summary['inbox_shot'] = await captureShell('schedule-inbox.png');
  await app.evaluate(() => globalThis.__helm?.setPanel('none'));

  await app.evaluate(() => globalThis.__helm?.getScheduler()?.remove('m5-eval-minute'));

  summary['schedule'] = {
    cron: expression,
    kind: item?.kind,
    title: item?.title,
    evidencePath: item?.evidencePath,
    runCount: schedule?.runCount
  };
});

test('[승인] 워크플로우도 승인 게이트를 지난다 — 자동 승인 경로는 없다', () => {
  // 첫 실행에서 사이트 첫 접근·다운로드 승인이 실제로 올라왔어야 한다.
  expect(approvals.length, '승인 요청이 하나도 없었습니다').toBeGreaterThan(0);
  expect(approvals.some((item) => item.startsWith('site:portal-h-settle'))).toBe(true);
  expect(approvals.some((item) => item.startsWith('download'))).toBe(true);

  summary['approvals'] = approvals;
});
