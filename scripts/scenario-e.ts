import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * 시나리오 E — 위키 400페이지 순회 중 **앱 강제 종료** 후 재개 (GOAL-M4a 성공 조건 3).
 *
 * 검증하는 것은 "중단이 정상 흐름" 이라는 불변 조건이다:
 *   1. 200페이지 지점까지 순회하고 진행 상태를 체크포인트에 남긴다
 *   2. SIGKILL — 정상 종료 훅이 돌지 않는다(전원이 꺼진 것과 같다)
 *   3. 재실행하면 스레드가 `paused` 로 복구되고, "이어서" 가 마지막 체크포인트로 되돌린다
 *   4. 남은 200페이지를 이어서 돌아 결함 50건을 정확히 채운다
 *
 * 같은 스레드에 붙기 위해 MCP 연결에 `X-Helm-Thread` 헤더를 준다. 이 헤더가 없으면 연결마다
 * 새 스레드가 만들어져 "이어가기" 자체가 불가능하다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm4a');
const PROFILE = path.join(ROOT, '.e-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.e-downloads');

const PORT = 3197;
const TOKEN = 'helm-dev-token-m4a';
const THREAD = 'scenario-e';

/** 강제 종료 지점 */
const KILL_AT = 200;
/** 체크포인트 간격(페이지) — 자동 체크포인트와 별개로 커서를 남긴다 */
const CHECKPOINT_EVERY = 25;

const TOTAL = 400;

interface Defect {
  pageId: number;
  kind: 'broken' | 'legacy';
  /** 몇 번째 단계에서 찾았는지 — ResultsTable 의 출처 표시 */
  step: number;
  url: string;
}

const summary: Record<string, unknown> = {};

let app: ElectronApplication;
let client: Client;

// ─────────────────────────────────────────────────────────────

/** 진행 표시 — 실패했을 때 "어디까지 갔는지" 를 알 수 있어야 한다. */
let lastCall = '(없음)';
let callCount = 0;

async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  callCount += 1;
  lastCall = `#${callCount} ${name} ${JSON.stringify(args).slice(0, 120)}`;

  const result = await client.callTool({ name, arguments: args }).catch((error: Error) => {
    throw new Error(`[mcp] ${lastCall} 실패: ${error.message}`);
  });

  const content = result.content as { type: string; text?: string }[] | undefined;
  const text = content?.[0]?.text ?? '{}';
  if (result.isError) throw new Error(`[mcp] ${lastCall} 오류: ${text}`);
  return JSON.parse(text) as T;
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      HELM_E2E: '1',
      HELM_USER_DATA_DIR: PROFILE,
      HELM_DOWNLOAD_DIR: DOWNLOAD_DIR,
      HELM_MCP_PORT: String(PORT),
      HELM_MCP_TOKEN: TOKEN
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

  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
        } catch {
          return false;
        }
      },
      { message: 'MCP health 대기', timeout: 20_000 }
    )
    .toBe(true);

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Helm-Thread': THREAD }
    }
  });
  client = new Client({ name: 'helm-scenario-e', version: '1.0.0' });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
}

interface AxNodeLike {
  ref: string;
  role: string;
  name: string;
}

/**
 * 한 문서를 읽고 결함을 뽑는다.
 *
 * href 를 보지 않는다 — 접근성 트리에는 주소가 없다. 사람이 화면에서 하는 것과 같이
 * **링크 문구**로 판단한다("관련 문서(이동 불가)" / "구 위키 원문").
 */
async function visit(tabId: number, pageId: number, step: number): Promise<Defect[]> {
  const url = `app://portal-e/page?id=${pageId}`;
  await callTool('navigate', { tabId, url });

  const page = await callTool<{ nodes: AxNodeLike[] }>('read_page', { tabId, filter: 'interactive' });
  const found: Defect[] = [];

  for (const node of page.nodes) {
    if (node.role !== 'link') continue;
    if (node.name.includes('이동 불가')) found.push({ pageId, kind: 'broken', step, url });
    else if (node.name.includes('구 위키 원문')) found.push({ pageId, kind: 'legacy', step, url });
  }

  return found;
}

interface NetEntryLike {
  url: string;
  body: string | null;
}

/**
 * 지연 로딩 목차를 펼쳐 문서 id 목록을 얻는다. 한 번에 다 오지 않는 것이 이 포털의 난관이다.
 *
 * 두 가지를 실측으로 배워 이 모양이 됐다:
 *   - **펼친 장은 다시 접는다.** 20장을 모두 펼치면 접근성 트리가 400개 링크로 불어나
 *     `read_page` 의 노드 상한에 걸려 뒤쪽 장 버튼이 잘려 나간다(9장에서 실패).
 *   - **id 는 DOM 이 아니라 `/tree` 응답에서 읽는다.** 화면 문구에는 문서 번호가 없다.
 *     응답 본문이 진짜 출처다(read_network_requests 를 먼저 켜 두어야 놓치지 않는다).
 */
async function loadToc(tabId: number): Promise<number[]> {
  await callTool('navigate', { tabId, url: 'app://portal-e/' });

  // 도청을 먼저 켠다 — 켜기 전에 오간 응답은 본문이 남지 않는다.
  await callTool('read_network_requests', { tabId, urlPattern: '/tree' });

  for (let section = 1; section <= 20; section += 1) {
    const found = await callTool<{ matches: { ref: string; name: string }[] }>('find', {
      tabId,
      query: `${section}장`,
      role: 'button'
    });
    const toggle = found.matches[0];
    expect(toggle, `${section}장 버튼을 찾지 못했습니다`).toBeDefined();

    // 펼친다 → 응답이 오기를 기다린다 → 다시 접어 트리를 작게 유지한다.
    await callTool('computer', { tabId, action: 'left_click', ref: toggle?.ref });

    await expect
      .poll(
        async () => {
          const tap = await callTool<{ requests: NetEntryLike[] }>('read_network_requests', {
            tabId,
            urlPattern: '/tree',
            limit: 300
          });
          return tap.requests.filter((entry) => entry.url.includes(`section=${section}`)).length;
        },
        { message: `${section}장 목차 응답 대기`, timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    await callTool('computer', { tabId, action: 'left_click', ref: toggle?.ref });
  }

  const tap = await callTool<{ requests: NetEntryLike[] }>('read_network_requests', {
    tabId,
    urlPattern: '/tree',
    limit: 300
  });

  const ids: number[] = [];
  for (const entry of tap.requests) {
    if (!entry.body) continue;
    try {
      const payload = JSON.parse(entry.body) as { pages?: { id: number }[] };
      for (const item of payload.pages ?? []) if (!ids.includes(item.id)) ids.push(item.id);
    } catch {
      // 목차가 아닌 응답이 섞였다면 무시한다.
    }
  }

  ids.sort((a, b) => a - b);
  return ids;
}

/**
 * 앱을 강제로 죽인다 — 전원이 꺼진 것과 같은 상황을 만든다.
 *
 * 주 프로세스만 죽이면 안 된다. 렌더러·GPU 자식 프로세스가 살아 있는 동안에는 단일 인스턴스
 * 잠금이 풀리지 않아 다음 실행이 곧바로 종료된다(실측: 두 번째 launch 가 exitCode 0 으로 끝났다).
 * 그래서 프로세스 **트리**를 함께 죽이고, 잠금이 실제로 풀렸는지 확인한 뒤 다시 띄운다.
 */
async function forceKill(): Promise<void> {
  const pid = app.process().pid;
  expect(pid, '프로세스 id 를 알 수 없습니다').toBeDefined();

  await client.close().catch(() => undefined);

  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    // 이미 죽었으면 taskkill 이 실패한다 — 그건 목적 달성이다.
  }

  app.process().kill('SIGKILL');
  await app.waitForEvent('close').catch(() => undefined);

  // MCP 포트가 닫혀야 잠금도 풀렸다고 볼 수 있다.
  await expect
    .poll(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${PORT}/health`);
          return true;
        } catch {
          return false;
        }
      },
      { message: '강제 종료 후 포트 해제 대기', timeout: 20_000 }
    )
    .toBe(false);
}

function threadStatus(): Promise<string | null> {
  return app.evaluate(
    (_electronApi, threadId) => globalThis.__helm?.getThreadStore()?.get(threadId)?.status ?? null,
    THREAD
  );
}

// ─────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

test.beforeAll(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  // 이 시나리오의 검증 대상은 지속성이다. 승인 흐름은 M3 가 이미 본다.
  fs.writeFileSync(
    path.join(PROFILE, 'policy.json'),
    `${JSON.stringify(
      {
        locked: false,
        sites: { default: 'allow', hosts: {} },
        deny: { hosts: [], tools: [] },
        tools: {},
        grants: [],
        retentionDays: 30
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
});

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'scenario-e-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
  await client?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
});

// ─────────────────────────────────────────────────────────────

test('[시나리오 E] 400페이지 순회 — 200페이지에서 강제 종료 후 이어서 완주', async () => {
  // ── 1차 실행 ──
  await launch();

  // AI 소유 탭에서 돈다 — 사람 탭에서 돌면 체크포인트에 담을 탭이 없고,
  // "탭 누수 0" 판정도 아무것도 증명하지 못한다.
  const started = await callTool<{ tabId: number }>('preview_start', {
    url: 'app://portal-e/'
  });
  const tabId = started.tabId;

  const ownerOfTab = await app.evaluate(
    (_electronApi, id) => globalThis.__helm?.getTabManager()?.ownerOf(id) ?? null,
    tabId
  );
  expect(ownerOfTab, 'AI 소유 탭이 아닙니다').toBe('ai');

  const ids = await loadToc(tabId);
  expect(ids).toHaveLength(TOTAL);

  const visited: number[] = [];
  const defects: Defect[] = [];
  let step = 0;

  for (const id of ids) {
    if (visited.length >= KILL_AT) break;

    step += 1;
    defects.push(...(await visit(tabId, id, step)));
    visited.push(id);

    if (visited.length % CHECKPOINT_EVERY === 0) {
      await callTool('checkpoint_save', {
        name: `${visited.length}페이지`,
        cursor: { nextIndex: visited.length, visited: visited.length },
        results: defects
      });
    }
  }

  expect(visited).toHaveLength(KILL_AT);

  const beforeKill = await app.evaluate(
    (_electronApi, threadId) => {
      const hook = globalThis.__helm;
      const latest = hook?.getCheckpointStore()?.latest(threadId) ?? null;
      return {
        status: hook?.getThreadStore()?.get(threadId)?.status ?? null,
        checkpoints: hook?.getCheckpointStore()?.count(threadId) ?? 0,
        cursor: latest?.payload.cursor ?? {},
        results: latest?.payload.results.length ?? 0,
        messages: hook?.getThreadStore()?.messageCount(threadId) ?? 0,
        aiTabs: (hook?.getTabManager()?.getState().tabs ?? []).filter(
          (tab) => tab.owner === 'ai'
        ).length
      };
    },
    THREAD
  );

  expect(beforeKill.status).toBe('running');
  expect(beforeKill.checkpoints, '체크포인트가 남지 않았습니다').toBeGreaterThan(0);
  expect(beforeKill.cursor['nextIndex']).toBe(KILL_AT);
  expect(beforeKill.aiTabs, '순회 중 AI 탭이 1개여야 한다').toBe(1);

  // ── 강제 종료 ──
  // close() 가 아니라 SIGKILL 이다. 정상 종료 훅이 돌지 않아야 "전원이 꺼진 상황" 이 된다.
  await forceKill();

  // ── 2차 실행 ──
  await launch();

  // 재시작 복구: running 이던 스레드는 paused 로 내려가 있어야 한다.
  expect(await threadStatus(), '재시작 후 상태가 paused 가 아닙니다').toBe('paused');

  const resumed = await app.evaluate(
    async (_electronApi, threadId) => {
      const hook = globalThis.__helm;
      const store = hook?.getCheckpointStore();
      const latest = store?.latest(threadId);
      if (!latest || !hook) return null;

      // 사람이 "이어서" 를 누른 것과 같은 경로(threadResume IPC 와 같은 동작).
      const restored = await hook.restoreCheckpointFor(latest.id);
      hook.getThreadStore()?.setStatus(threadId, 'running');

      return {
        checkpointId: latest.id,
        cursor: latest.payload.cursor,
        results: latest.payload.results,
        tabs: restored.tabs
      };
    },
    THREAD
  );

  expect(resumed, '체크포인트를 복원하지 못했습니다').not.toBeNull();
  expect(await threadStatus()).toBe('running');

  const restoredCursor = (resumed?.cursor ?? {}) as { nextIndex?: number };
  const resumeIndex = restoredCursor.nextIndex ?? 0;
  expect(resumeIndex, '재개 지점이 없습니다').toBeGreaterThan(0);

  const restoredDefects = (resumed?.results ?? []) as Defect[];

  // 체크포인트에 담겨 있던 AI 탭이 실제로 다시 열려야 한다.
  expect(resumed?.tabs.length, '복원된 탭이 없습니다').toBe(1);
  const resumedTab = resumed?.tabs[0];
  expect(resumedTab?.url, '복원된 탭의 주소가 다릅니다').toContain('portal-e');

  const resumedOwner = await app.evaluate(
    (_electronApi, id) => globalThis.__helm?.getTabManager()?.ownerOf(id) ?? null,
    resumedTab?.tabId ?? 0
  );
  expect(resumedOwner, '복원된 탭이 AI 소유가 아닙니다').toBe('ai');

  const tabId2 = resumedTab?.tabId ?? 0;

  // ── 남은 페이지 순회 ──
  const visited2 = ids.slice(0, resumeIndex);
  const defects2 = [...restoredDefects];
  let step2 = resumeIndex;

  for (const id of ids.slice(resumeIndex)) {
    step2 += 1;
    defects2.push(...(await visit(tabId2, id, step2)));
    visited2.push(id);

    if (visited2.length % CHECKPOINT_EVERY === 0) {
      await callTool('checkpoint_save', {
        name: `${visited2.length}페이지`,
        cursor: { nextIndex: visited2.length, visited: visited2.length },
        results: defects2
      });
    }
  }

  // ── 판정 ──
  expect(visited2, '방문 페이지 수가 400이 아닙니다').toHaveLength(TOTAL);
  expect(new Set(visited2).size, '중복 방문이 있습니다').toBe(TOTAL);

  const broken = defects2.filter((defect) => defect.kind === 'broken');
  const legacy = defects2.filter((defect) => defect.kind === 'legacy');

  expect(broken, '깨진 링크 30건이 아닙니다').toHaveLength(30);
  expect(legacy, '구 도메인 링크 20건이 아닙니다').toHaveLength(20);
  expect(defects2, '결함 50건이 아닙니다').toHaveLength(50);

  // fixture 의 기대값과 대조한다 — 우연히 개수만 맞는 것을 막는다.
  // (evaluate 안에서는 동적 import 가 막혀 있어 메인이 노출한 훅으로 받는다.)
  const expected = await app.evaluate(async () => (await globalThis.__helm?.wikiDefects()) ?? []);
  expect(expected).toHaveLength(50);
  expect([...defects2.map((defect) => `${defect.pageId}:${defect.kind}`)].sort()).toEqual(
    [...expected].sort()
  );

  // 탭 누수 0 — 400페이지를 돌아도 AI 탭이 쌓이지 않아야 한다.
  const aiTabs = await app.evaluate(
    () =>
      (globalThis.__helm?.getTabManager()?.getState().tabs ?? []).filter(
        (tab) => tab.owner === 'ai'
      ).length
  );
  expect(aiTabs, `AI 탭 ${aiTabs}개 — 누수`).toBeLessThanOrEqual(3);

  // 결과표를 저장해 두고 내보내기 검증(성공 조건 6)에서 쓴다.
  await callTool('checkpoint_save', {
    name: '완주',
    cursor: { nextIndex: TOTAL, visited: TOTAL, done: true },
    results: defects2
  });

  await callTool('inbox_post', {
    kind: 'done',
    title: '위키 결함 목록 50건',
    summary: `문서 ${TOTAL}개 순회, 깨진 링크 ${broken.length}건 · 구 도메인 ${legacy.length}건`
  });

  const finished = await app.evaluate(
    (_electronApi, threadId) => {
      const hook = globalThis.__helm;
      return {
        checkpoints: hook?.getCheckpointStore()?.count(threadId) ?? 0,
        messages: hook?.getThreadStore()?.messageCount(threadId) ?? 0,
        inboxUnread: hook?.getInbox()?.unreadCount() ?? 0,
        results: (hook?.getResults(threadId) ?? []).length
      };
    },
    THREAD
  );

  expect(finished.results).toBe(50);
  expect(finished.inboxUnread).toBeGreaterThan(0);

  summary['scenarioE'] = {
    total: TOTAL,
    visitedFirstRun: KILL_AT,
    killedAt: KILL_AT,
    statusAfterRestart: 'paused',
    resumeCheckpoint: resumed?.checkpointId,
    resumeIndex,
    restoredDefects: restoredDefects.length,
    restoredTabs: resumed?.tabs.length ?? 0,
    restoredTabUrl: resumedTab?.url,
    aiTabsDuringRun: beforeKill.aiTabs,
    visitedTotal: visited2.length,
    duplicates: visited2.length - new Set(visited2).size,
    broken: broken.length,
    legacy: legacy.length,
    defects: defects2.length,
    aiTabsAtEnd: aiTabs,
    checkpoints: finished.checkpoints,
    threadMessages: finished.messages,
    checkpointsBeforeKill: beforeKill.checkpoints
  };
});
