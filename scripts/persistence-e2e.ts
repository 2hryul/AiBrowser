import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 지속성 E2E (`npm run test:persistence-e2e`) — GOAL-M4a 성공 조건 4·5·6.
 *
 *   4. 이름 붙인 세션: 두 세션에 각기 다른 쿠키 → 재시작 → 파티션별 유지·교차 없음 + 탭 배지
 *   5. 스레드 이어 말하기: 생성 → 종료 → 재실행 → 같은 스레드에 메시지 추가 → 히스토리 연속
 *   6. 결과표 내보내기: CSV / Markdown / JSON 파일 내용 검증
 *
 * 앱을 정상 종료(close)했다가 다시 띄운다. 시나리오 E 가 보는 것은 강제 종료였고,
 * 여기서는 "평범하게 껐다 켰다" 를 본다 — 둘 다 이어져야 한다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm4a');
const PROFILE = path.join(ROOT, '.p-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.p-downloads');

const THREAD = 'persistence-e2e';

/** 쿠키를 심을 주소 — app:// 는 쿠키를 가질 수 없어(M2 실측) https 주소를 쓴다. */
const ITSM_URL = 'https://itsm.example.co.kr/';
const GW_URL = 'https://gw.example.co.kr/';

const summary: Record<string, unknown> = {};

let app: ElectronApplication;

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
      // 이 스펙은 MCP 를 쓰지 않는다 — 포트를 열어 둘 이유가 없다.
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

async function relaunch(): Promise<void> {
  await app.close();
  await launch();
}

/** 셸 안에서 표현식을 평가한다. 반환값은 JSON 문자열이어야 한다. */
function shellEval(expression: string): Promise<string> {
  return app.evaluate(async (_electronApi, expr) => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[persistence-e2e] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(expr)) as string;
  }, expression);
}

async function captureShell(fileName: string): Promise<string> {
  const base64 = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) return '';
    const image = await shell.webContents.capturePage();
    return image.toPNG().toString('base64');
  });

  fs.writeFileSync(path.join(ARTIFACTS, fileName), Buffer.from(base64, 'base64'));
  return fileName;
}

/** 파티션에 쿠키를 심는다. 파티션이 진짜로 나뉘어 있는지 보는 가장 직접적인 방법이다. */
function setCookie(partition: string, url: string, name: string, value: string): Promise<boolean> {
  return app.evaluate(
    async ({ session }, input) => {
      try {
        await session.fromPartition(input.partition).cookies.set({
          url: input.url,
          name: input.name,
          value: input.value,
          expirationDate: Math.floor(Date.now() / 1000) + 3600
        });
        return true;
      } catch (error) {
        console.error('[persistence-e2e] 쿠키 설정 실패', error);
        return false;
      }
    },
    { partition, url, name, value }
  );
}

function readCookies(partition: string, url: string): Promise<{ name: string; value: string }[]> {
  return app.evaluate(
    async ({ session }, input) => {
      const found = await session.fromPartition(input.partition).cookies.get({ url: input.url });
      return found.map((cookie) => ({ name: cookie.name, value: cookie.value }));
    },
    { partition, url }
  );
}

// ─────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.beforeAll(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  await launch();
});

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'persistence-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
  await app?.close().catch(() => undefined);
});

// ─────────────────────────────────────────────────────────────

test('[세션] 두 세션의 쿠키가 재시작 후에도 파티션별로 유지되고 섞이지 않는다', async () => {
  const created = await app.evaluate(() => {
    const store = globalThis.__helm?.getSessionStore();
    return {
      itsm: store?.ensure('itsm')?.partition ?? null,
      gw: store?.ensure('gw')?.partition ?? null,
      default: store?.partitionOf('default') ?? null
    };
  });

  expect(created.itsm).toBe('persist:helm:itsm');
  expect(created.gw).toBe('persist:helm:gw');
  // 기본 세션의 파티션 이름은 M0 부터 쓰던 값을 그대로 지킨다 — 바꾸면 기존 로그인이 날아간다.
  expect(created.default).toBe('persist:helm');

  expect(await setCookie('persist:helm:itsm', ITSM_URL, 'helm_sid', 'itsm-1234')).toBe(true);
  expect(await setCookie('persist:helm:gw', GW_URL, 'helm_sid', 'gw-5678')).toBe(true);

  // 로그인 경로도 기록해 둔다(비밀번호·토큰은 저장하지 않는다).
  await app.evaluate(() => {
    const store = globalThis.__helm?.getSessionStore();
    store?.recordLogin('itsm', 'inapp', 'itsm.example.co.kr');
    store?.recordLogin('gw', 'oauth_modal', 'gw.example.co.kr');
  });

  // 각 세션의 탭을 열어 배지를 확인한다.
  const tabIds = await app.evaluate(() => {
    const manager = globalThis.__helm?.getTabManager();
    return {
      itsm: manager?.createTab('app://portal-a/list?page=1', 'human', 'itsm') ?? 0,
      gw: manager?.createTab('app://portal-b/', 'human', 'gw') ?? 0
    };
  });

  expect(tabIds.itsm).toBeGreaterThan(0);
  expect(tabIds.gw).toBeGreaterThan(0);

  const badges = JSON.parse(
    await shellEval(`(() => {
      const nodes = [...document.querySelectorAll('[data-session-badge]')];
      return JSON.stringify(nodes.map((el) => el.getAttribute('data-session-badge')));
    })()`)
  ) as string[];

  expect(badges.sort(), '탭 배지가 세션 이름을 보여주지 않습니다').toEqual(['gw', 'itsm']);

  await app.evaluate(() => globalThis.__helm?.setPanel('sessions'));
  await expect
    .poll(
      async () =>
        JSON.parse(
          await shellEval(
            `JSON.stringify(Number(document.querySelector('[data-session-count]')?.getAttribute('data-session-count') ?? 0))`
          )
        ) as number,
      { message: '세션 목록 대기', timeout: 15_000 }
    )
    .toBe(3);

  const sessionShot = await captureShell('sessions-and-badges.png');
  await app.evaluate(() => globalThis.__helm?.setPanel('none'));

  // ── 재시작 ──
  await relaunch();

  const itsmCookies = await readCookies('persist:helm:itsm', ITSM_URL);
  const gwCookies = await readCookies('persist:helm:gw', GW_URL);

  expect(itsmCookies, 'itsm 쿠키가 사라졌습니다').toEqual([
    { name: 'helm_sid', value: 'itsm-1234' }
  ]);
  expect(gwCookies, 'gw 쿠키가 사라졌습니다').toEqual([{ name: 'helm_sid', value: 'gw-5678' }]);

  // 교차 없음: 각 파티션은 상대 주소의 쿠키를 모른다.
  expect(await readCookies('persist:helm:itsm', GW_URL), 'itsm 이 gw 쿠키를 봅니다').toEqual([]);
  expect(await readCookies('persist:helm:gw', ITSM_URL), 'gw 가 itsm 쿠키를 봅니다').toEqual([]);
  expect(await readCookies('persist:helm', ITSM_URL), '기본 세션이 itsm 쿠키를 봅니다').toEqual([]);
  expect(await readCookies('persist:helm', GW_URL), '기본 세션이 gw 쿠키를 봅니다').toEqual([]);

  // 세션 메타(로그인 경로)도 재시작 후에 읽힌다 — safeStorage 로 암호화되어 있다.
  const meta = await app.evaluate(() => {
    const store = globalThis.__helm?.getSessionStore();
    return {
      itsm: store?.meta('itsm')?.loginMethod ?? null,
      gw: store?.meta('gw')?.loginMethod ?? null,
      names: (store?.list() ?? []).map((info) => info.name).sort()
    };
  });

  expect(meta.itsm).toBe('inapp');
  expect(meta.gw).toBe('oauth_modal');
  expect(meta.names).toEqual(['default', 'gw', 'itsm']);

  summary['namedSessions'] = {
    partitions: created,
    itsmCookies,
    gwCookies,
    crossOver: 0,
    loginMethods: { itsm: meta.itsm, gw: meta.gw },
    badges,
    shot: sessionShot
  };
});

test('[스레드] 앱을 껐다 켠 뒤 같은 스레드에 이어 말한다', async () => {
  const created = await app.evaluate(
    (_electronApi, threadId) => {
      const store = globalThis.__helm?.getThreadStore();
      const thread = store?.create({ id: threadId, title: '주간 공지 정리' });
      store?.append(threadId, { role: 'human', text: '지난주 공지 요약해줘' });
      store?.append(threadId, { role: 'ai', text: '공지 12건을 찾았습니다' });
      return thread ?? null;
    },
    THREAD
  );

  expect(created?.status).toBe('running');

  // ── 재시작 ──
  await relaunch();

  const after = await app.evaluate(
    (_electronApi, threadId) => {
      const store = globalThis.__helm?.getThreadStore();
      return {
        thread: store?.get(threadId) ?? null,
        messages: (store?.messages(threadId) ?? []).map((message) => ({
          seq: message.seq,
          role: message.role,
          text: message.text
        }))
      };
    },
    THREAD
  );

  // 재시작 복구: running 이던 스레드는 paused 로 내려간다.
  expect(after.thread?.status, '재시작 후 상태가 paused 가 아닙니다').toBe('paused');
  expect(after.thread?.title).toBe('주간 공지 정리');
  expect(after.messages).toHaveLength(2);
  expect(after.messages[0]?.text).toBe('지난주 공지 요약해줘');

  // 사이드바에서 사람이 한 마디 보탠다(스레드 화면의 실제 경로).
  await app.evaluate(() => globalThis.__helm?.setPanel('threads'));

  await expect
    .poll(
      async () =>
        JSON.parse(
          await shellEval(
            `JSON.stringify(Number(document.querySelector('[data-thread-count]')?.getAttribute('data-thread-count') ?? 0))`
          )
        ) as number,
      { message: '스레드 목록 대기', timeout: 15_000 }
    )
    .toBeGreaterThan(0);

  await shellEval(
    `JSON.stringify(Boolean(document.querySelector('[data-thread-id="${THREAD}"]')?.click() ?? true))`
  );

  await expect
    .poll(
      async () =>
        JSON.parse(
          await shellEval(
            `JSON.stringify(Number(document.querySelector('[data-message-count]')?.getAttribute('data-message-count') ?? 0))`
          )
        ) as number,
      { message: '메시지 목록 대기', timeout: 15_000 }
    )
    .toBe(2);

  const threadShot = await captureShell('threads-continued.png');

  // 입력칸에 값을 넣고 보내기 — 실제 UI 경로로 이어 말한다.
  await shellEval(`(() => {
    const input = document.querySelector('[data-thread-input]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '재시작 후에도 이어집니까?');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-thread-say]').click();
    return JSON.stringify(true);
  })()`);

  await expect
    .poll(
      () =>
        app.evaluate(
          (_electronApi, threadId) =>
            globalThis.__helm?.getThreadStore()?.messageCount(threadId) ?? 0,
          THREAD
        ),
      { message: '이어 말하기 반영 대기', timeout: 15_000 }
    )
    .toBe(3);

  const final = await app.evaluate(
    (_electronApi, threadId) =>
      (globalThis.__helm?.getThreadStore()?.messages(threadId) ?? []).map((message) => ({
        seq: message.seq,
        role: message.role,
        text: message.text
      })),
    THREAD
  );

  // 히스토리 연속: 번호가 1..3 으로 이어지고 앞의 대화가 그대로 남아 있다.
  expect(final.map((message) => message.seq)).toEqual([1, 2, 3]);
  expect(final[0]?.text).toBe('지난주 공지 요약해줘');
  expect(final[2]?.text).toBe('재시작 후에도 이어집니까?');
  expect(final[2]?.role).toBe('human');

  await app.evaluate(() => globalThis.__helm?.setPanel('none'));

  summary['threadContinuity'] = {
    threadId: THREAD,
    statusAfterRestart: after.thread?.status,
    messagesBefore: after.messages.length,
    messagesAfter: final.length,
    seqs: final.map((message) => message.seq),
    shot: threadShot
  };
});

test('[결과표] CSV·Markdown·JSON 내보내기 파일 내용이 맞다', async () => {
  // 쉼표·인용부호·줄바꿈·파이프가 든 값을 일부러 섞는다 — 이스케이프가 진짜 목적이다.
  const rows = [
    { pageId: 13, kind: 'broken', step: 13, url: 'app://portal-e/page?id=13' },
    { pageId: 20, kind: 'legacy', step: 20, url: 'app://portal-e/page?id=20' },
    {
      pageId: 260,
      kind: 'broken',
      step: 260,
      url: 'app://portal-e/page?id=260',
      note: '쉼표, 있음 "인용" | 파이프\n줄바꿈'
    }
  ];

  await app.evaluate(
    async (_electronApi, input) => {
      const hook = globalThis.__helm;
      await hook?.saveCheckpointFor(input.threadId, {
        name: '내보내기용',
        trigger: 'manual',
        results: input.rows
      });
    },
    { threadId: THREAD, rows }
  );

  expect(await app.evaluate((_e, id) => (globalThis.__helm?.getResults(id) ?? []).length, THREAD)).toBe(
    3
  );

  const exported = await app.evaluate(
    (_electronApi, threadId) => ({
      csv: globalThis.__helm?.exportResults(threadId, 'csv') ?? null,
      md: globalThis.__helm?.exportResults(threadId, 'md') ?? null,
      json: globalThis.__helm?.exportResults(threadId, 'json') ?? null
    }),
    THREAD
  );

  expect(exported.csv?.rows).toBe(3);
  expect(exported.md?.rows).toBe(3);
  expect(exported.json?.rows).toBe(3);

  // ── CSV ──
  const csv = fs.readFileSync(exported.csv?.filePath ?? '', 'utf-8');
  const csvLines = csv.split('\r\n').filter((line) => line !== '');

  expect(csvLines[0]).toBe('pageId,kind,step,url,note');
  expect(csvLines).toHaveLength(4);
  expect(csvLines[1]).toBe('13,broken,13,app://portal-e/page?id=13,');
  // RFC 4180: 쉼표·인용부호·줄바꿈이 있으면 감싸고 인용부호는 두 번 쓴다.
  expect(csvLines[3]).toContain('"쉼표, 있음 ""인용"" | 파이프');
  expect(csv).toContain('260,broken,260');

  // ── Markdown ──
  const md = fs.readFileSync(exported.md?.filePath ?? '', 'utf-8');
  const mdLines = md.split('\n').filter((line) => line !== '');

  expect(mdLines[0]).toBe('| pageId | kind | step | url | note |');
  expect(mdLines[1]).toBe('| --- | --- | --- | --- | --- |');
  expect(mdLines).toHaveLength(5);
  // 파이프는 이스케이프하고 줄바꿈은 공백으로 눕힌다 — 표가 깨지지 않아야 한다.
  expect(mdLines[4]).toContain('\\|');
  expect(mdLines[4]?.split('\n')).toHaveLength(1);

  // ── JSON ──
  const json = JSON.parse(fs.readFileSync(exported.json?.filePath ?? '', 'utf-8')) as typeof rows;
  expect(json).toHaveLength(3);
  expect(json[2]?.note).toBe('쉼표, 있음 "인용" | 파이프\n줄바꿈');
  expect(json[0]?.url).toBe('app://portal-e/page?id=13');

  // ── 화면 ──
  await app.evaluate(() => globalThis.__helm?.setPanel('results'));

  await expect
    .poll(
      async () =>
        JSON.parse(
          await shellEval(
            `JSON.stringify(Number(document.querySelector('[data-results-rows]')?.getAttribute('data-results-rows') ?? 0))`
          )
        ) as number,
      { message: '결과표 대기', timeout: 15_000 }
    )
    .toBe(3);

  const columns = JSON.parse(
    await shellEval(`(() => {
      const nodes = [...document.querySelectorAll('[data-results-column]')];
      return JSON.stringify(nodes.map((el) => el.getAttribute('data-results-column')));
    })()`)
  ) as string[];

  expect(columns).toEqual(['pageId', 'kind', 'step', 'url', 'note']);

  const resultsShot = await captureShell('results-table.png');

  summary['resultsExport'] = {
    rows: 3,
    csv: { file: path.basename(exported.csv?.filePath ?? ''), bytes: exported.csv?.bytes },
    md: { file: path.basename(exported.md?.filePath ?? ''), bytes: exported.md?.bytes },
    json: { file: path.basename(exported.json?.filePath ?? ''), bytes: exported.json?.bytes },
    columns,
    shot: resultsShot
  };
});
