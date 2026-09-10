import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * MCP 시나리오 재생 (`npm run test:mcp`).
 *
 * LLM 을 붙이지 않고, MCP 클라이언트가 시나리오 A·B·C 의 도구 시퀀스를 스크립트로 재생한다.
 * 이것이 "Claude Code 로 시나리오 통과" 의 기계 판정 대체물이다(GOAL-M2 FIXED DECISIONS).
 *
 * 여기서 검증하는 것은 도구 표면이 실제 스크래핑 난관을 넘을 수 있는가다:
 *   A 서버 렌더링 페이지네이션 + 세션 만료 → ask_user → 복구 → 재개
 *   B 필터 폼 → XHR JSON 누적 (DOM 파싱 없이 전체 건수 확보)
 *   C iframe 중첩 → 팝업 새 탭 → 첨부 다운로드 → EUC-KR 디코딩
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm2');
const PROFILE = path.join(ROOT, '.mcp-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.mcp-downloads');

const PORT = 3199;
const TOKEN = 'helm-dev-token-m2';

let app: ElectronApplication;
let client: Client;

/** 시나리오별 실측값. REPORT.md 작성 근거로 남긴다. */
const summary: Record<string, unknown> = {};

/** 도구 호출 결과를 JSON 으로 받는다. MCP 는 텍스트 콘텐츠로 감싸 보낸다. */
async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[] | undefined;
  const text = content?.[0]?.text ?? '{}';

  if (result.isError) {
    throw new Error(`[mcp] ${name} 실패: ${text}`);
  }
  return JSON.parse(text) as T;
}

interface FindResult {
  matches: { ref: string; role: string; name: string; value?: string }[];
}

interface NavigateResult {
  tabId: number;
  finalUrl: string;
  title: string;
  redirected: boolean;
}

interface PageTextResult {
  tabId: number;
  url: string;
  text: string;
  frames: number;
}

/** 오버레이가 그린 내용. app.evaluate 로 건너보내려면 직렬화 가능한 형태여야 한다. */
interface OverlayStateLike {
  badge?: string;
  boxes?: { x: number; y: number; width: number; height: number; role?: string }[];
  cursor?: { x: number; y: number };
}

/** 이름으로 요소를 찾아 클릭한다. 실패하면 무엇을 못 찾았는지 알려 준다. */
async function clickByName(
  tabId: number,
  query: string,
  role?: string
): Promise<{ ref: string; name: string }> {
  const found = await callTool<FindResult>('find', {
    tabId,
    query,
    ...(role ? { role } : {})
  });

  const match = found.matches[0];
  expect(match, `"${query}"(${role ?? '역할 무관'}) 를 찾지 못했습니다`).toBeDefined();

  await callTool('computer', { tabId, action: 'left_click', ref: match?.ref });
  return { ref: match?.ref ?? '', name: match?.name ?? '' };
}

/** 사람 답이 필요한 물음에 자동으로 답한다 — 사람 대신 테스트가 대답하는 역할. */
function autoAnswer(expectKind: 'ask_user' | 'request_access', answer: string): Promise<string | null> {
  return app.evaluate(
    async (_e, input) => {
      const hook = globalThis.__helm;
      if (!hook) return null;

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const target = hook.pendingPrompts().find((prompt) => prompt.kind === input.kind);
        if (target) {
          hook.answerPrompt(target.id, input.answer);
          return target.question;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    },
    { kind: expectKind, answer }
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

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

  // MCP 가 뜰 때까지 기다린다.
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${PORT}/health`);
          return response.ok;
        } catch {
          return false;
        }
      },
      { message: 'MCP health 대기', timeout: 20_000 }
    )
    .toBe(true);

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
  });
  client = new Client({ name: 'helm-scenario-runner', version: '1.0.0' });
  // SDK 의 Transport 는 optional 콜백을 `() => void` 로 선언해 우리 쪽
  // exactOptionalPropertyTypes 와 어긋난다. 외부 라이브러리 경계에서만 좁혀 준다.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
});

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'mcp-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
  await client?.close().catch(() => undefined);
  await app?.close();
});

// ─────────────────────────────────────────────────────────────

test('[MCP] 토큰 없이는 붙을 수 없고, 도구 목록이 노출된다', async () => {
  const unauthorized = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  expect(unauthorized.status).toBe(401);

  const tools = await client.listTools();
  expect(tools.tools.length).toBeGreaterThanOrEqual(19);

  // 스키마가 그대로 실려 나가는지 — 클라이언트가 인자를 만들 수 있어야 한다.
  const navigateTool = tools.tools.find((tool) => tool.name === 'navigate');
  expect(navigateTool?.inputSchema).toBeDefined();
  expect(JSON.stringify(navigateTool?.inputSchema)).toContain('url');

  // 되돌릴 수 없는 도구는 설명에 표시된다.
  const javascriptTool = tools.tools.find((tool) => tool.name === 'javascript');
  expect(javascriptTool?.description).toContain('되돌릴 수 없음');

  summary['mcp'] = {
    endpoint: `http://127.0.0.1:${PORT}/mcp`,
    tools: tools.tools.length,
    unauthorizedStatus: unauthorized.status
  };
});

test('[시나리오 A] 공지 200건 수집 — 세션 만료 후 재개', async () => {
  const started = await callTool<{ tabId: number }>('preview_start', {
    url: 'app://portal-a/list?page=1'
  });
  const tabId = started.tabId;

  // 로그인 상태가 아니면 로그인 페이지로 밀려난다. 첫 진입에서 그 흐름을 그대로 겪는다.
  const first = await callTool<NavigateResult>('navigate', {
    tabId,
    url: 'app://portal-a/list?page=1'
  });

  if (first.finalUrl.includes('/login')) {
    const asked = autoAnswer('ask_user', '로그인함');
    const answer = await callTool<{ answer: string }>('ask_user', {
      question: '세션이 만료되어 로그인 페이지로 이동했습니다. 로그인해 주세요.',
      options: ['로그인함', '취소']
    });
    expect(await asked, '사람에게 묻지 않았습니다').not.toBeNull();
    expect(answer.answer).toBe('로그인함');

    // 로그인 폼을 채우고 제출한다. 비밀번호는 fixture 가 미리 채워 둔 값을 그대로 쓴다.
    await clickByName(tabId, '로그인', 'button');
    await expect
      .poll(async () => (await callTool<PageTextResult>('get_page_text', { tabId })).url)
      .toContain('/list');
  }

  // read_page 로 페이지 구조를 먼저 본다(무엇을 클릭할지 판단하는 자리).
  const structure = await callTool<{ nodes: { role: string; name: string }[] }>('read_page', {
    tabId,
    filter: 'interactive'
  });
  expect(structure.nodes.some((node) => node.role === 'link' && node.name === '2')).toBe(true);

  interface Row {
    id: number;
    title: string;
    postedAt: string;
  }

  const rows: Row[] = [];
  const visitedUrls: string[] = [];
  let expiredOnce = false;

  /** 목록 텍스트에서 행을 뽑는다. 탭으로 구분된 서버 렌더링 표다. */
  const parseRows = (text: string): Row[] => {
    const out: Row[] = [];
    for (const line of text.split('\n')) {
      const cells = line.split('\t');
      if (cells.length < 6) continue;
      const id = Number(cells[0]);
      if (!Number.isInteger(id) || id <= 0) continue;
      out.push({ id, title: cells[1] ?? '', postedAt: cells[4] ?? '' });
    }
    return out;
  };

  for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
    // 5페이지를 읽은 뒤 세션 만료 버튼을 눌러 리다이렉트를 유발한다.
    if (pageNumber === 6 && !expiredOnce) {
      expiredOnce = true;
      await clickByName(tabId, '세션 만료', 'button');

      const afterExpire = await callTool<NavigateResult>('navigate', {
        tabId,
        url: `app://portal-a/list?page=${pageNumber}`
      });

      // 리다이렉트가 감지되어야 한다 — 이게 세션 만료 신호다.
      expect(afterExpire.redirected, '세션 만료 후 리다이렉트가 감지되지 않았습니다').toBe(true);
      expect(afterExpire.finalUrl).toContain('/login');

      // AI 는 스스로 로그인하지 않고 사람에게 묻는다.
      const asked = autoAnswer('ask_user', '로그인함');
      const answer = await callTool<{ answer: string }>('ask_user', {
        question: '세션이 만료되었습니다. 로그인 후 계속할까요?',
        options: ['로그인함', '취소']
      });
      expect(await asked).not.toBeNull();
      expect(answer.answer).toBe('로그인함');

      await clickByName(tabId, '로그인', 'button');

      // 복구 후 끊긴 페이지에서 재개한다.
      await expect
        .poll(async () => (await callTool<PageTextResult>('get_page_text', { tabId })).url)
        .toContain('/list');
    }

    const navigated = await callTool<NavigateResult>('navigate', {
      tabId,
      url: `app://portal-a/list?page=${pageNumber}`
    });
    expect(navigated.finalUrl, `${pageNumber} 페이지에서 로그인으로 밀려남`).toContain(
      `page=${pageNumber}`
    );
    visitedUrls.push(navigated.finalUrl);

    const text = await callTool<PageTextResult>('get_page_text', { tabId });
    const pageRows = parseRows(text.text);
    expect(pageRows, `${pageNumber} 페이지 행 수`).toHaveLength(20);
    rows.push(...pageRows);
  }

  // 200행, 중복 0
  expect(rows).toHaveLength(200);
  expect(new Set(rows.map((row) => row.id)).size, '중복 행이 있습니다').toBe(200);
  // 방문한 페이지 주소도 서로 달라야 한다(같은 페이지를 두 번 읽지 않았다).
  expect(new Set(visitedUrls).size).toBe(10);

  // 게시일 형식 검증
  const badDates = rows.filter((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.postedAt));
  expect(badDates, `게시일 형식이 어긋난 행: ${JSON.stringify(badDates.slice(0, 3))}`).toHaveLength(0);

  // 제목이 빈 행도 없어야 한다.
  expect(rows.filter((row) => row.title.trim() === '')).toHaveLength(0);

  const shot = await callTool<{ image: string }>('computer', { tabId, action: 'screenshot' });
  fs.writeFileSync(path.join(ARTIFACTS, 'scenario-a.png'), Buffer.from(shot.image, 'base64'));

  summary['scenarioA'] = {
    rows: rows.length,
    uniqueIds: new Set(rows.map((row) => row.id)).size,
    pages: visitedUrls.length,
    sessionExpiredAndRecovered: expiredOnce,
    firstRow: rows[0],
    lastRow: rows[rows.length - 1],
    screenshot: 'scenario-a.png'
  };
});

test('[시나리오 B] 필터 → XHR JSON 누적, DOM 파싱 없이 전체 건수 확보', async () => {
  const started = await callTool<{ tabId: number }>('preview_start', { url: 'app://portal-b/' });
  const tabId = started.tabId;
  await callTool('navigate', { tabId, url: 'app://portal-b/' });

  // 도청을 먼저 켠다 — 조회 후에 켜면 첫 응답을 놓친다.
  await callTool('read_network_requests', { tabId, urlPattern: '/api/incidents' });

  // 필터: P1·P2 체크, 기간 = 최근 1분기
  const checkboxes = await callTool<{ nodes: { ref: string; role: string; name: string }[] }>(
    'read_page',
    { tabId, filter: 'interactive' }
  );

  const p1 = checkboxes.nodes.find((node) => node.role === 'checkbox' && node.name.includes('P1'));
  const p2 = checkboxes.nodes.find((node) => node.role === 'checkbox' && node.name.includes('P2'));
  const period = checkboxes.nodes.find((node) => node.role === 'combobox');

  expect(p1, 'P1 체크박스 없음').toBeDefined();
  expect(p2, 'P2 체크박스 없음').toBeDefined();
  expect(period, '기간 셀렉트 없음').toBeDefined();

  await callTool('form_input', { tabId, ref: p1?.ref, value: true });
  await callTool('form_input', { tabId, ref: p2?.ref, value: true });
  await callTool('form_input', { tabId, ref: period?.ref, value: 'quarter' });

  // 설정이 실제로 반영됐는지 확인한다.
  const afterFilter = await callTool<{ nodes: { ref: string; role: string; name: string; checked?: boolean }[] }>(
    'read_page',
    { tabId, filter: 'interactive' }
  );
  const checkedCount = afterFilter.nodes.filter((node) => node.checked === true).length;
  expect(checkedCount, 'P1·P2 체크가 반영되지 않았습니다').toBe(2);

  await clickByName(tabId, '조회', 'button');

  // 조회가 실제로 실행됐는지 먼저 확인한다 — 여기서 막히면 응답 수집을 볼 필요가 없다.
  await expect
    .poll(
      async () => {
        const probe = await callTool<{ value: unknown }>('javascript', {
          tabId,
          code: `return document.getElementById('summary').textContent;`
        });
        return String(probe.value ?? '');
      },
      { message: '조회 결과 요약이 갱신되기를 대기' }
    )
    .toContain('전체');

  interface Incident {
    id: string;
    priority: string;
  }

  const collected = new Map<string, Incident>();
  let total = -1;

  /** 도청 버퍼에서 JSON 을 꺼내 누적한다. DOM 은 보지 않는다. */
  const drain = async (): Promise<void> => {
    const net = await callTool<{
      requests: { url: string; body: string | null }[];
    }>('read_network_requests', { tabId, urlPattern: '/api/incidents', limit: 300 });

    for (const request of net.requests) {
      if (!request.body) continue;
      try {
        const parsed = JSON.parse(request.body) as { total: number; items: Incident[] };
        total = parsed.total;
        for (const item of parsed.items) collected.set(item.id, item);
      } catch {
        // JSON 이 아닌 응답은 무시한다.
      }
    }
  };

  // 무한 스크롤: 바닥에 닿을 때마다 다음 페이지를 받는다.
  const viewport = afterFilter.nodes.find((node) => node.role === 'region');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await drain();
    if (total > 0 && collected.size >= total) break;

    await callTool('computer', {
      tabId,
      action: 'scroll',
      scrollDirection: 'down',
      scrollAmount: 10,
      ...(viewport ? { ref: viewport.ref } : {})
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await drain();

  if (total <= 0) {
    const all = await callTool<{
      requests: { url: string; status: number | null; mimeType: string | null; body: string | null; bodyBytes: number }[];
      bodyBytesUsed: number;
    }>('read_network_requests', { tabId, limit: 300 });
    console.warn(
      '[진단] 전체 요청',
      JSON.stringify(
        all.requests.map((r) => ({
          url: r.url.slice(0, 70),
          status: r.status,
          mime: r.mimeType,
          hasBody: r.body !== null,
          bytes: r.bodyBytes
        })),
        null,
        1
      )
    );
  }

  expect(total, 'total 필드를 못 받았습니다').toBeGreaterThan(0);
  expect(collected.size, `누적 ${collected.size} vs total ${total}`).toBe(total);

  // 필터가 실제로 걸렸는지 — P3 는 섞여 있지 않아야 한다.
  expect([...collected.values()].every((item) => item.priority !== 'P3')).toBe(true);

  // DOM 에는 전체가 없다는 사실을 함께 확인한다(가상 스크롤).
  const domText = await callTool<PageTextResult>('get_page_text', { tabId });
  const domRows = domText.text.split('\n').filter((line) => line.startsWith('INC')).length;
  expect(domRows, 'DOM 에 전체 행이 그려져 있으면 이 시나리오의 의미가 없다').toBeLessThan(total);

  const shot = await callTool<{ image: string }>('computer', { tabId, action: 'screenshot' });
  fs.writeFileSync(path.join(ARTIFACTS, 'scenario-b.png'), Buffer.from(shot.image, 'base64'));

  summary['scenarioB'] = {
    total,
    collected: collected.size,
    domRowsVisible: domRows,
    filters: { priorities: ['P1', 'P2'], period: 'quarter' },
    screenshot: 'scenario-b.png'
  };
});

test('[시나리오 C] iframe 트리 → 팝업 새 탭 → 첨부 다운로드, EUC-KR 깨짐 0', async () => {
  const started = await callTool<{ tabId: number }>('preview_start', { url: 'app://portal-c/' });
  const tabId = started.tabId;
  await callTool('navigate', { tabId, url: 'app://portal-c/' });

  // iframe 이 모두 로드될 때까지 기다린다.
  await expect
    .poll(async () => (await callTool<{ frames: number }>('read_page', { tabId })).frames, {
      message: 'iframe 로드 대기'
    })
    .toBeGreaterThanOrEqual(3);

  const downloaded: string[] = [];
  const popupTabIds: number[] = [];
  let replacementChars = 0;
  let totalChars = 0;

  for (const category of ['인사규정', '보안규정']) {
    // 좌측 트리 iframe 의 분류를 누른다. read_page 가 평탄화해 준 ref 를 그대로 쓴다.
    await clickByName(tabId, category, 'link');

    await expect
      .poll(async () => {
        const text = await callTool<PageTextResult>('get_page_text', { tabId });
        return text.text.includes(category);
      })
      .toBe(true);

    // 목록 iframe 에서 규정 행을 훑는다.
    const list = await callTool<{ nodes: { ref: string; role: string; name: string }[] }>(
      'read_page',
      { tabId }
    );
    const ruleLinks = list.nodes.filter(
      (node) => node.role === 'link' && node.name.startsWith('규정 제')
    );
    expect(ruleLinks.length, `${category} 목록에 규정 링크가 없습니다`).toBe(5);

    for (const link of ruleLinks) {
      const before = await callTool<{ tabs: { tabId: number }[] }>('tabs_context');

      // window.open 팝업 → 새 탭으로 잡힌다.
      await callTool('computer', { tabId, action: 'left_click', ref: link.ref });

      const popupId = await expect
        .poll(
          async () => {
            const after = await callTool<{ tabs: { tabId: number; url: string }[] }>('tabs_context');
            const fresh = after.tabs.find(
              (tab) => !before.tabs.some((old) => old.tabId === tab.tabId)
            );
            return fresh?.tabId ?? null;
          },
          { message: `${link.name} 팝업 탭 대기` }
        )
        .not.toBeNull()
        .then(async () => {
          const after = await callTool<{ tabs: { tabId: number }[] }>('tabs_context');
          const fresh = after.tabs.find(
            (tab) => !before.tabs.some((old) => old.tabId === tab.tabId)
          );
          return fresh?.tabId as number;
        });

      popupTabIds.push(popupId);

      // 상세 본문을 읽는다. 3번 문서는 EUC-KR 이다.
      const detail = await callTool<PageTextResult>('get_page_text', { tabId: popupId });
      totalChars += detail.text.length;
      replacementChars += (detail.text.match(/�/g) ?? []).length;
      expect(detail.text.length, `${link.name} 본문이 비었습니다`).toBeGreaterThan(20);

      // 첨부 PDF 를 받는다.
      const attachment = await callTool<{ fileName: string; savePath: string; state: string; bytes: number }>(
        'download',
        { tabId: popupId, url: detail.url.replace('/doc?', '/attachment?') }
      );
      expect(attachment.state).toBe('completed');
      expect(attachment.bytes).toBeGreaterThan(0);
      expect(fs.existsSync(attachment.savePath)).toBe(true);
      downloaded.push(attachment.fileName);

      await callTool('tabs_close', { tabId: popupId });
    }
  }

  // 10건 반복
  expect(popupTabIds).toHaveLength(10);
  expect(downloaded).toHaveLength(10);

  // EUC-KR 깨짐: 치환문자 비율 1% 미만
  const ratio = totalChars === 0 ? 1 : replacementChars / totalChars;
  expect(ratio, `치환문자 ${replacementChars}/${totalChars}`).toBeLessThan(0.01);

  // 구형 인코딩 문서의 본문 표식이 실제로 읽혔는지 직접 확인한다.
  const euckrTab = await callTool<{ tabId: number }>('tabs_create', {
    url: 'app://portal-c/doc?id=3'
  });
  await callTool('navigate', { tabId: euckrTab.tabId, url: 'app://portal-c/doc?id=3' });
  const euckr = await callTool<PageTextResult>('get_page_text', { tabId: euckrTab.tabId });
  expect(euckr.text, 'EUC-KR 본문 표식을 못 읽었습니다').toContain('구형인코딩본문표식');
  expect(euckr.text).not.toContain('�');

  const shot = await callTool<{ image: string }>('computer', {
    tabId: euckrTab.tabId,
    action: 'screenshot'
  });
  fs.writeFileSync(path.join(ARTIFACTS, 'scenario-c.png'), Buffer.from(shot.image, 'base64'));
  await callTool('tabs_close', { tabId: euckrTab.tabId });

  summary['scenarioC'] = {
    popups: popupTabIds.length,
    downloads: downloaded.length,
    replacementChars,
    totalChars,
    replacementRatio: Number(ratio.toFixed(6)),
    screenshot: 'scenario-c.png'
  };
});

test('[Handoff] 조작 중 사람이 키를 누르면 {paused:true} 를 돌려준다', async () => {
  const started = await callTool<{ tabId: number }>('preview_start', {
    url: 'app://portal-a/list?page=1'
  });
  const tabId = started.tabId;
  await callTool('navigate', { tabId, url: 'app://portal-a/list?page=1' });

  // 사람이 AI 탭에 키를 입력한 것과 같은 상황을 만든다.
  const injected = await app.evaluate((_e, id) => {
    const hook = globalThis.__helm;
    const manager = hook?.getTabManager();
    const wc = manager?.getWebContents(id);
    if (!wc) return false;

    // before-input-event 로 감지되는 실제 입력 경로를 그대로 쓴다.
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
    return true;
  }, tabId);
  expect(injected).toBe(true);

  // 일시정지 상태가 되고, 이후 도구 호출은 {paused:true} 를 돌려준다.
  const paused = await expect
    .poll(
      async () => {
        const result = await callTool<{ paused?: boolean; reason?: string }>('get_page_text', {
          tabId
        });
        return result.paused === true ? result : null;
      },
      { message: '도구 호출이 paused 를 돌려주기를 대기' }
    )
    .not.toBeNull()
    .then(() => callTool<{ paused?: boolean; reason?: string; tabId: number | null }>('get_page_text', { tabId }));

  expect(paused.paused).toBe(true);
  expect(paused.reason).toContain('사람이');

  const aiState = await app.evaluate(() => globalThis.__helm?.getAiState());
  expect(aiState?.status).toBe('paused');

  // 셸에 PauseResumeBar 가 실제로 떴는지 확인한다.
  const barVisible = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) return '';
    return (await shell.webContents.executeJavaScript(
      `JSON.stringify({
         bar: !!document.querySelector('[data-ai-status="paused"]'),
         resume: !!document.querySelector('[data-ai-resume]'),
         takeover: !!document.querySelector('[data-ai-takeover]')
       })`
    )) as string;
  });
  expect(JSON.parse(barVisible)).toEqual({ bar: true, resume: true, takeover: true });

  // "이어서" — 호출자에게 개입 사실을 알리고 계속한다.
  const resumed = await app.evaluate(() => {
    const hook = globalThis.__helm;
    const state = hook?.getAiState();
    if (!hook || !state) return null;
    return hook.getHandoff()?.resume(state.threadId) ?? null;
  });
  expect(resumed).toEqual({ resumed: true, note: 'user intervened' });

  // 이어서 누른 뒤에는 도구가 정상 동작한다.
  const afterResume = await callTool<PageTextResult>('get_page_text', { tabId });
  expect(afterResume.text).toContain('공지사항');

  summary['handoff'] = {
    pausedReason: paused.reason,
    resumeResult: resumed,
    resumedAndContinued: true
  };
});

test('[Overlay] 클릭 직전 프레임에 대상 bbox 하이라이트 픽셀이 있다', async () => {
  const started = await callTool<{ tabId: number }>('preview_start', {
    url: 'app://portal-a/list?page=1'
  });
  const tabId = started.tabId;
  await callTool('navigate', { tabId, url: 'app://portal-a/list?page=1' });

  // 클릭할 대상과 그 화면 사각형을 먼저 구한다.
  const found = await callTool<FindResult>('find', { tabId, query: '세션 만료', role: 'button' });
  const ref = found.matches[0]?.ref;
  expect(ref, '대상 버튼을 찾지 못했습니다').toBeDefined();

  const rectRaw = await callTool<{ value: unknown }>('javascript', {
    tabId,
    code: `
      const el = document.getElementById('expire-session');
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    `
  });
  const expected = JSON.parse(String(rectRaw.value)) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  // 실제 클릭 경로를 그대로 태운다. computer 가 클릭 직전에 오버레이를 그린다.
  await callTool('computer', { tabId, action: 'left_click', ref });

  // 1) 도구가 클릭 직전에 "무엇을" 표시했는지 — 대상 요소의 사각형과 일치해야 한다.
  const shown = await app.evaluate(() => globalThis.__helm?.overlayLastState() ?? null);
  expect(shown, '오버레이가 그려지지 않았습니다').not.toBeNull();

  const box = shown?.state.boxes?.[0];
  expect(box, '하이라이트 bbox 가 없습니다').toBeDefined();
  expect(Math.abs((box?.x ?? -1) - expected.x)).toBeLessThan(3);
  expect(Math.abs((box?.y ?? -1) - expected.y)).toBeLessThan(3);
  expect(Math.abs((box?.width ?? -1) - expected.width)).toBeLessThan(3);
  expect(shown?.state.cursor, '커서 표시가 없습니다').toBeDefined();

  // 2) 그 상태가 실제 픽셀로 칠해지는지 — 같은 내용을 다시 그려 오버레이 뷰를 캡처한다.
  const capture = await app.evaluate(async (_e, state) => {
    const overlay = globalThis.__helm?.getOverlay();
    if (!overlay) return null;
    await overlay.show(state, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shot = await overlay.capture();
    overlay.hide();
    return shot;
  }, shown?.state as OverlayStateLike);

  expect(capture, '오버레이 캡처 실패').not.toBeNull();

  // 하이라이트 색은 #ff3b30 계열이다. 그 계열 픽셀이 충분히 있어야 한다.
  const pixels = await app.evaluate(
    ({ nativeImage }, input) => {
      const image = nativeImage.createFromBuffer(Buffer.from(input.base64, 'base64'));
      const bitmap = image.toBitmap(); // BGRA
      let highlight = 0;

      for (let i = 0; i < bitmap.length; i += 4) {
        const b = bitmap[i] ?? 0;
        const g = bitmap[i + 1] ?? 0;
        const r = bitmap[i + 2] ?? 0;
        const a = bitmap[i + 3] ?? 0;
        // 붉고, 초록·파랑이 낮고, 불투명한 픽셀
        if (a > 40 && r > 120 && g < 110 && b < 110) highlight += 1;
      }

      return { highlight, total: bitmap.length / 4 };
    },
    { base64: capture?.base64 ?? '' }
  );

  // 220×40 테두리 + 반투명 채움 + 커서면 최소 수천 픽셀이다.
  expect(pixels.highlight, `하이라이트 픽셀 ${pixels.highlight}개`).toBeGreaterThan(500);

  fs.writeFileSync(
    path.join(ARTIFACTS, 'overlay-highlight.png'),
    Buffer.from(capture?.base64 ?? '', 'base64')
  );

  summary['overlay'] = {
    targetRect: expected,
    shownBox: box,
    cursor: shown?.state.cursor,
    highlightPixels: pixels.highlight,
    totalPixels: pixels.total,
    screenshot: 'overlay-highlight.png'
  };
});
