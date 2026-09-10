import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 도구 단위 테스트 (`npm run test:tools`).
 *
 * CDP 에 의존하는 도구는 실제 Electron 안에서만 검증할 수 있어 Playwright 로 앱을 띄운다.
 * 규칙 매칭처럼 순수한 부분은 vitest(`npm run test:unit`)에서 따로 본다.
 *
 * 검증 대상(GOAL-M2 성공 조건 2):
 *   - 스키마 검증
 *   - password 마스킹: read_page · get_page_text · screenshot 픽셀
 *   - read_page iframe 평탄화 (포털 C)
 *   - NetTap 패턴 매칭 · 256KB 상한 (포털 B)
 *   - find 규칙 매칭 5건
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm2');
const PROFILE = path.join(ROOT, '.tools-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.tools-downloads');

const THREAD = 'test-tools';

let app: ElectronApplication;

/** 도구 호출. 메인에서 실행되고 결과는 JSON 으로 건너온다. */
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const raw = await app.evaluate(
    async (_e, input) => {
      const hook = globalThis.__helm;
      if (!hook) throw new Error('[tool-tests] __helm 훅 없음');
      const result = await hook.callTool(input.thread, input.name, input.args);
      return JSON.stringify(result ?? null);
    },
    { thread: THREAD, name, args }
  );
  return JSON.parse(raw) as T;
}

/** 도구 호출이 실패하기를 기대할 때. 에러 메시지를 문자열로 받는다. */
async function callExpectError(name: string, args: Record<string, unknown> = {}): Promise<string> {
  return app.evaluate(
    async (_e, input) => {
      const hook = globalThis.__helm;
      if (!hook) throw new Error('[tool-tests] __helm 훅 없음');
      try {
        await hook.callTool(input.thread, input.name, input.args);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    },
    { thread: THREAD, name, args }
  );
}

async function openPortal(url: string): Promise<number> {
  const started = await call<{ tabId: number }>('preview_start', { url });
  await call('navigate', { tabId: started.tabId, url });
  return started.tabId;
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
      // 도구 테스트에서는 MCP 를 띄우지 않는다 — 포트 충돌을 피한다.
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
});

test.afterAll(async () => {
  await app?.close();
});

// ─────────────────────────────────────────────────────────────

test('[도구] 레지스트리와 스키마', async () => {
  const names = await app.evaluate(() => globalThis.__helm?.toolNames() ?? []);

  // Claude Browser 호환 이름이 모두 있어야 한다.
  for (const expected of [
    'tabs_context',
    'tabs_create',
    'tabs_select',
    'tabs_close',
    'preview_start',
    'navigate',
    'get_page_text',
    'read_page',
    'find',
    'computer',
    'form_input',
    'javascript',
    'read_network_requests',
    'read_console_messages',
    'download',
    'upload',
    'ask_user',
    'request_access'
  ]) {
    expect(names, `${expected} 누락`).toContain(expected);
  }

  // 없는 도구
  expect(await callExpectError('nope')).toContain('없는 도구');

  // 필수 인자 누락
  expect(await callExpectError('navigate', {})).toContain('인자 검증 실패');

  // 타입 불일치
  expect(await callExpectError('navigate', { url: 42 })).toContain('인자 검증 실패');

  // 스키마에 없는 인자
  expect(await callExpectError('read_page', { bogus: 1 })).toContain('인자 검증 실패');

  // enum 위반
  expect(await callExpectError('computer', { action: 'teleport' })).toContain('인자 검증 실패');

  // 범위 위반
  expect(await callExpectError('read_page', { maxNodes: 0 })).toContain('인자 검증 실패');
});

test('[마스킹] read_page·get_page_text·screenshot 에서 비밀번호가 새지 않는다', async () => {
  // 포털 A 로그인 페이지에는 값이 채워진 password 입력이 있다.
  const tabId = await openPortal('app://portal-a/login');

  const page = await call<{ nodes: { role: string; name: string; value?: string }[] }>('read_page', {
    tabId
  });
  const serialized = JSON.stringify(page);
  expect(serialized, 'read_page 에 비밀번호 원문이 있습니다').not.toContain('sample-not-real');
  expect(serialized).toContain('***');

  const text = await call<{ text: string }>('get_page_text', { tabId });
  expect(text.text, 'get_page_text 에 비밀번호 원문이 있습니다').not.toContain('sample-not-real');

  const article = await call<{ text: string }>('get_page_text', { tabId, mode: 'article' });
  expect(article.text).not.toContain('sample-not-real');

  // 스크린샷: password 입력 영역이 실제로 덮였는지 픽셀로 확인한다.
  const shot = await call<{ image: string; width: number; height: number; maskedRegions: number }>(
    'computer',
    { tabId, action: 'screenshot' }
  );
  expect(shot.maskedRegions, '가려진 비밀번호 영역이 없습니다').toBeGreaterThan(0);

  fs.writeFileSync(path.join(ARTIFACTS, 'masked-login.png'), Buffer.from(shot.image, 'base64'));

  // 마스킹 색(40,40,40)이 이미지에 실제로 존재하는지 확인한다.
  const pixels = await app.evaluate(
    ({ nativeImage }, input) => {
      const image = nativeImage.createFromBuffer(Buffer.from(input.base64, 'base64'));
      const bitmap = image.toBitmap();
      let hits = 0;
      for (let i = 0; i < bitmap.length; i += 4) {
        if (bitmap[i] === 40 && bitmap[i + 1] === 40 && bitmap[i + 2] === 40) hits += 1;
      }
      return { hits, total: bitmap.length / 4 };
    },
    { base64: shot.image }
  );

  // 입력창 하나를 덮으면 최소 수백 픽셀은 된다.
  expect(pixels.hits, '마스킹 색 픽셀이 너무 적습니다').toBeGreaterThan(300);
});

test('[read_page] 포털 C 의 iframe 을 평탄화한다', async () => {
  const tabId = await openPortal('app://portal-c/');

  const page = await expect
    .poll(
      async () => {
        const result = await call<{ frames: number; nodes: { name: string; frameId?: string }[] }>(
          'read_page',
          { tabId }
        );
        return result.frames >= 3 ? result : null;
      },
      { message: 'iframe 두 개가 로드되기를 대기' }
    )
    .not.toBeNull()
    .then(() => call<{ frames: number; nodes: { name: string; frameId?: string }[] }>('read_page', { tabId }));

  // 메인 + 트리 iframe + 목록 iframe
  expect(page.frames).toBeGreaterThanOrEqual(3);

  const names = page.nodes.map((node) => node.name);
  expect(names.some((name) => name.includes('인사규정')), '트리 iframe 노드 없음').toBe(true);
  expect(
    names.some((name) => name.includes('규정 제1호')),
    '목록 iframe 노드 없음'
  ).toBe(true);

  // iframe 안쪽 노드는 frameId 가 붙어 경계를 알 수 있다.
  expect(page.nodes.some((node) => node.frameId !== undefined)).toBe(true);
});

test('[NetTap] 포털 B 의 JSON 응답을 패턴으로 골라 읽는다', async () => {
  const tabId = await openPortal('app://portal-b/');

  // 도청을 먼저 켠다 — 조회 후에 켜면 응답을 놓친다.
  await call('read_network_requests', { tabId, urlPattern: '/api/incidents' });

  // 필터를 설정하고 조회한다.
  const found = await call<{ matches: { ref: string; name: string }[] }>('find', {
    tabId,
    query: '조회',
    role: 'button'
  });
  expect(found.matches.length).toBeGreaterThan(0);
  await call('computer', { tabId, action: 'left_click', ref: found.matches[0]?.ref });

  const captured = await expect
    .poll(
      async () => {
        const result = await call<{
          requests: { url: string; body: string | null; mimeType: string | null }[];
        }>('read_network_requests', { tabId, urlPattern: '/api/incidents' });
        return result.requests.filter((entry) => entry.body !== null).length;
      },
      { message: 'incidents JSON 응답이 잡히기를 대기' }
    )
    .toBeGreaterThan(0)
    .then(() =>
      call<{
        requests: { url: string; body: string | null }[];
        bodyLimitBytes: number;
        bodyBytesUsed: number;
      }>('read_network_requests', { tabId, urlPattern: '/api/incidents' })
    );

  // 패턴에 맞는 것만 왔는지
  expect(captured.requests.every((entry) => entry.url.includes('/api/incidents'))).toBe(true);

  const withBody = captured.requests.find((entry) => entry.body !== null);
  expect(withBody, 'JSON 본문이 없습니다').toBeDefined();

  const parsed = JSON.parse(withBody?.body ?? '{}') as { total: number; items: unknown[] };
  expect(parsed.total).toBeGreaterThan(0);
  expect(Array.isArray(parsed.items)).toBe(true);

  // 상한 값이 그대로 노출되는지 (256KB)
  expect(captured.bodyLimitBytes).toBe(256 * 1024);
  expect(captured.bodyBytesUsed).toBeLessThanOrEqual(captured.bodyLimitBytes);

  // 패턴이 맞지 않으면 빈 목록
  const none = await call<{ requests: unknown[] }>('read_network_requests', {
    tabId,
    urlPattern: '/api/does-not-exist'
  });
  expect(none.requests).toEqual([]);
});

test('[NetTap] 본문 총량이 256KB 를 넘으면 오래된 본문부터 버린다', async () => {
  const tabId = await openPortal('app://portal-b/');
  await call('read_network_requests', { tabId, urlPattern: '/api/incidents' });

  // size 를 키워 큰 응답을 여러 번 받는다. 137건 전체 JSON 이 대략 20KB 이므로 20회면 상한을 넘는다.
  await call('javascript', {
    tabId,
    code: `
      for (let i = 0; i < 20; i += 1) {
        await fetch('app://portal-b/api/incidents?page=1&size=200&round=' + i);
      }
      return 'done';
    `
  });

  // 본문 수집은 loadingFinished 이후 비동기로 이뤄진다. 폐기가 실제로 일어날 때까지 기다린다.
  await expect
    .poll(
      async () => {
        const result = await call<{ bodiesEvicted: number }>('read_network_requests', {
          tabId,
          urlPattern: '/api/incidents',
          limit: 300
        });
        return result.bodiesEvicted;
      },
      { message: '본문 상한을 넘겨 폐기가 일어나기를 대기', timeout: 30_000 }
    )
    .toBeGreaterThan(0);

  const stats = await call<{
    bodyBytesUsed: number;
    bodiesEvicted: number;
    bodyLimitBytes: number;
    requests: { bodyEvicted: boolean }[];
  }>('read_network_requests', { tabId, urlPattern: '/api/incidents', limit: 300 });

  expect(stats.bodyLimitBytes).toBe(256 * 1024);

  // 상한을 절대 넘지 않는다.
  expect(stats.bodyBytesUsed).toBeLessThanOrEqual(256 * 1024);

  // 20회 × 137건 JSON 이면 상한을 확실히 넘으므로 폐기가 일어나야 한다.
  expect(stats.bodiesEvicted, '상한을 넘겼는데 폐기가 없습니다').toBeGreaterThan(0);
  // 폐기된 본문은 메타데이터만 남고 표시가 붙는다.
  expect(stats.requests.some((entry) => entry.bodyEvicted)).toBe(true);
});

test('[find] 규칙 5종이 각각 동작한다', async () => {
  const tabId = await openPortal('app://portal-a/login');

  const cases: { query: string; expectRule: string; note: string }[] = [
    { query: '로그인', expectRule: 'exact', note: '버튼 이름과 정확히 일치' },
    { query: '사', expectRule: 'prefix', note: '"사번" 의 접두' },
    { query: '번', expectRule: 'substring', note: '"사번" 의 부분' },
    { query: '로 그 인', expectRule: 'normalized', note: '공백을 무시하면 "로그인"' },
    { query: '10012345', expectRule: 'value', note: '입력의 현재 값으로 찾기' }
  ];

  const rules: string[] = [];

  for (const testCase of cases) {
    const result = await call<{ matches: { rule: string; name: string; value?: string }[] }>('find', {
      tabId,
      query: testCase.query
    });

    const match = result.matches.find((item) => item.rule === testCase.expectRule);
    expect(
      match,
      `"${testCase.query}" → ${testCase.expectRule} 규칙으로 못 찾음 (${testCase.note}). ` +
        `실제: ${JSON.stringify(result.matches.slice(0, 3))}`
    ).toBeDefined();

    rules.push(testCase.expectRule);
  }

  expect(new Set(rules).size).toBe(5);

  // 규칙에 맞지 않으면 빈 결과. 추론으로 억지 매칭하지 않는다(M2 는 1차 규칙만).
  const nothing = await call<{ matches: unknown[] }>('find', { tabId, query: '존재하지않는문구zzz' });
  expect(nothing.matches).toEqual([]);
});

test('[승인] request_access·ask_user 가 사람에게 묻고 답을 받는다', async () => {
  // 도구는 사람 답을 기다리므로, 답을 넣어 주는 쪽을 먼저 예약한다.
  const answering = app.evaluate(async () => {
    const hook = globalThis.__helm;
    if (!hook) throw new Error('훅 없음');

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const pending = hook.pendingPrompts();
      const target = pending.find((prompt) => prompt.kind === 'request_access');
      if (target) {
        hook.answerPrompt(target.id, '허용');
        return { question: target.question, options: target.options };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  });

  const granted = await call<{ granted: boolean; host: string; scope: string }>('request_access', {
    host: 'portal-x.example.co.kr',
    reason: '공지 목록을 읽기 위해'
  });

  const prompt = await answering;
  expect(prompt, '사람에게 묻지 않았습니다').not.toBeNull();
  expect(prompt?.question).toContain('portal-x.example.co.kr');
  expect(prompt?.options).toEqual(['허용', '거부']);
  expect(granted.granted).toBe(true);
  expect(granted.scope).toBe('once');

  // 거부도 그대로 전달된다.
  const denying = app.evaluate(async () => {
    const hook = globalThis.__helm;
    if (!hook) return false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const target = hook.pendingPrompts().find((prompt) => prompt.kind === 'ask_user');
      if (target) {
        hook.answerPrompt(target.id, '아니오');
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  });

  const answered = await call<{ answer: string; answered: boolean }>('ask_user', {
    question: '계속할까요?',
    options: ['예', '아니오']
  });

  expect(await denying).toBe(true);
  expect(answered.answer).toBe('아니오');
});

test('[탭 소유권] AI 는 사람 소유 탭을 선택·닫지 않는다', async () => {
  // 시작 탭(탭 1)은 사람 소유다.
  const humanTabId = 1;

  expect(await callExpectError('tabs_select', { tabId: humanTabId })).toContain('사람 소유');
  expect(await callExpectError('tabs_close', { tabId: humanTabId })).toContain('사람 소유');

  const context = await call<{ tabs: { tabId: number; owner: string; origin: string }[] }>(
    'tabs_context'
  );
  expect(context.tabs.some((tab) => tab.owner === 'ai')).toBe(true);
  expect(context.tabs.find((tab) => tab.tabId === humanTabId)?.owner).toBe('human');
  // origin 을 함께 주어 페이지가 정한 제목에 속지 않게 한다.
  expect(context.tabs.every((tab) => typeof tab.origin === 'string')).toBe(true);
});

test('[upload] 다운로드 폴더 밖 경로는 거부한다', async () => {
  const tabId = await openPortal('app://portal-a/login');
  const page = await call<{ nodes: { ref: string; role: string }[] }>('read_page', { tabId });
  const anyRef = page.nodes[0]?.ref ?? 'ref_1';

  const message = await callExpectError('upload', {
    tabId,
    ref: anyRef,
    filePath: '../../secret.txt'
  });
  expect(message).toContain('다운로드 폴더 밖');
});
