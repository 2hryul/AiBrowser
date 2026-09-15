import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * M4c 로그인 획득 경로 E2E — `npm run test:login`.
 *
 * 검증 대상(GOAL-M4c 성공 조건 2):
 *   - inapp: 모의 IdP 폼 로그인 → 세션 성립 → 세션 메타 `method:'inapp'` → 재시작 후 메타 유지
 *   - oauth_modal: 일반 탭에서는 "안전하지 않은 앱" → 모달에서 code 발급·redirect → 모달 자동 닫힘
 *   - external: 화이트리스트 호스트는 openExternal 호출(mock) → "완료" → 검증 통과.
 *     화이트리스트 밖은 호출 전 거부 + 감사 로그
 *   - 세션 만료 → 받은편지함 `login_required` + 스레드 `waiting_login` → 로그인 후 재개
 *
 * `app://` 는 쿠키를 가질 수 없다(Chromium 이 커스텀 스킴 쿠키를 거부). 모의 IdP 의 세션은
 * fixture 내부 상태이고 `__helm.idpHasSession(host)` 로 본다. 파티션 쿠키의 재시작 유지는
 * smoke([M0])가 실제 쿠키로 검증한다 — 여기서는 세션 메타(SQLite)의 유지를 본다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm4c');
const PROFILE = path.join(ROOT, '.login-profile');

const FORM_HOST = 'idp-form';
const OAUTH_HOST = 'idp-oauth';
const FORM_APP_URL = `app://${FORM_HOST}/app`;
const OAUTH_APP_URL = `app://${OAUTH_HOST}/app`;

const summary: Record<string, unknown> = {};

let app: ElectronApplication;

test.describe.configure({ mode: 'serial' });

function seedPolicy(profileDir: string): void {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'policy.json'),
    `${JSON.stringify(
      {
        locked: false,
        // 도구가 IdP 호스트에 접근할 때 승인 다이얼로그가 끼지 않게 미리 허용한다.
        // 승인 흐름 자체는 test:policy·M3 시나리오가 검증한다.
        sites: {
          default: 'ask',
          hosts: { home: 'allow', fixtures: 'allow', [FORM_HOST]: 'allow', [OAUTH_HOST]: 'allow' }
        },
        deny: { hosts: [], tools: [] },
        tools: { javascript: 'ask' },
        allowPasswordImport: true,
        externalLoginHosts: [FORM_HOST, OAUTH_HOST],
        grants: [],
        retentionDays: 30
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
}

function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, HELM_E2E: '1', HELM_USER_DATA_DIR: PROFILE }
  });
}

async function waitForWindow(target: ElectronApplication): Promise<void> {
  await expect
    .poll(
      () =>
        target.evaluate(({ BaseWindow }) => {
          const win = BaseWindow.getAllWindows()[0];
          return win ? win.isVisible() : false;
        }),
      { message: '메인 윈도우가 표시되기를 대기', timeout: 30_000 }
    )
    .toBe(true);
}

/** loginStart 를 **기다리지 않고** 시작한다 — 완료까지 사람 입력(프롬프트)이 끼기 때문이다. */
function kickLogin(url: string, method: 'inapp' | 'oauth_modal' | 'external'): Promise<void> {
  return app.evaluate(async (_e, input) => {
    const hook = globalThis.__helm;
    if (!hook) throw new Error('[login-e2e] __helm 훅 없음');
    (globalThis as Record<string, unknown>)['__loginResult'] = null;
    void hook.loginStart(input.url, input.method).then((result) => {
      (globalThis as Record<string, unknown>)['__loginResult'] = result;
    });
  }, { url, method });
}

function loginResult(): Promise<unknown> {
  return app.evaluate(() => (globalThis as Record<string, unknown>)['__loginResult'] ?? null);
}

async function waitLoginResult(): Promise<{
  status: string;
  method: string;
  host: string;
  fellBackFrom?: string;
}> {
  await expect
    .poll(() => loginResult(), { message: 'loginStart 결과를 대기', timeout: 20_000 })
    .not.toBeNull();
  return (await loginResult()) as { status: string; method: string; host: string };
}

/** 질문 텍스트에 해당 문자열이 든 대기 프롬프트를 찾아 id 를 돌려준다. */
async function waitPrompt(contains: string): Promise<string> {
  await expect
    .poll(
      () =>
        app.evaluate(
          (_e, text) =>
            globalThis.__helm?.pendingPrompts().find((p) => p.question.includes(text))?.id ?? '',
          contains
        ),
      { message: `"${contains}" 프롬프트를 대기`, timeout: 20_000 }
    )
    .not.toBe('');
  return app.evaluate(
    (_e, text) =>
      globalThis.__helm?.pendingPrompts().find((p) => p.question.includes(text))?.id ?? '',
    contains
  );
}

function answerPrompt(id: string, answer: string): Promise<boolean> {
  return app.evaluate(
    (_e, input) => globalThis.__helm?.answerPrompt(input.id, input.answer) ?? false,
    { id, answer }
  );
}

/** 주소에 해당 문자열이 든 탭을 찾는다. */
async function waitTab(urlPart: string): Promise<number> {
  await expect
    .poll(
      () =>
        app.evaluate((_e, part) => {
          const state = globalThis.__helm?.getTabManager()?.getState();
          return state?.tabs.find((tab) => tab.url.includes(part))?.id ?? -1;
        }, urlPart),
      { message: `"${urlPart}" 탭을 대기`, timeout: 15_000 }
    )
    .not.toBe(-1);
  return app.evaluate((_e, part) => {
    const state = globalThis.__helm?.getTabManager()?.getState();
    return state?.tabs.find((tab) => tab.url.includes(part))?.id ?? -1;
  }, urlPart);
}

/** 탭 문서에서 표현식을 평가한다. */
function inTab(tabId: number, expression: string): Promise<unknown> {
  return app.evaluate(
    async (_e, input) => {
      const wc = globalThis.__helm?.getTabManager()?.getWebContents(input.tabId);
      if (!wc) throw new Error(`[login-e2e] 탭 ${input.tabId} 없음`);
      return (await wc.executeJavaScript(input.expression)) as unknown;
    },
    { tabId, expression }
  );
}

async function waitInTab(tabId: number, expression: string, message: string): Promise<void> {
  await expect
    .poll(() => inTab(tabId, expression), { message, timeout: 15_000 })
    .toBe(true);
}

/** 모의 IdP 로그인 폼을 사람 대신 채운다 — E2E 에서만 하는 일이다. */
async function fillLoginForm(tabId: number): Promise<void> {
  const creds = await app.evaluate(() => globalThis.__helm?.idpCreds());
  if (!creds) throw new Error('[login-e2e] fixture 계정을 읽지 못함');

  await waitInTab(tabId, '!!document.querySelector("#login-form")', '로그인 폼을 대기');
  await inTab(
    tabId,
    `(() => {
       document.querySelector('#login-id').value = ${JSON.stringify(creds.user)};
       document.querySelector('#login-pw').value = ${JSON.stringify(creds.password)};
       document.querySelector('#login-submit').click();
       return true;
     })()`
  );
  await waitInTab(tabId, '!!document.querySelector("#signed-in")', '로그인 완료 화면을 대기');
}

function idpHasSession(host: string): Promise<boolean> {
  return app.evaluate(
    async (_e, target) => (await globalThis.__helm?.idpHasSession(target)) ?? false,
    host
  );
}

function sessionMeta(): Promise<{ loginMethod: string | null; loggedInAt: number | null } | null> {
  return app.evaluate(() => globalThis.__helm?.getSessionStore()?.meta('default') ?? null);
}

/** 셸(사이드바 포함) DOM 에서 표현식을 평가한다. */
function shellEval(expression: string): Promise<unknown> {
  return app.evaluate(async (_e, expr) => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[login-e2e] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(expr)) as unknown;
  }, expression);
}

test.beforeAll(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  seedPolicy(PROFILE);
  summary['ranAt'] = new Date().toISOString();

  app = await launchApp();
  await waitForWindow(app);
});

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'login-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
  await app.close();
});

// ─────────────────────────────────────────────────────────────
// inapp — 기본 경로
// ─────────────────────────────────────────────────────────────

test('[M4c] inapp — 폼 로그인으로 세션이 서고 메타에 경로가 남는다', async () => {
  expect(await idpHasSession(FORM_HOST)).toBe(false);

  await kickLogin(FORM_APP_URL, 'inapp');

  // login_start 가 연 탭에서 사람이 직접 로그인한다(여기서는 E2E 가 대신 친다).
  const tabId = await waitTab(FORM_HOST);
  await fillLoginForm(tabId);

  const promptId = await waitPrompt(FORM_HOST);
  expect(await answerPrompt(promptId, '로그인함')).toBe(true);

  const result = await waitLoginResult();
  expect(result.status).toBe('logged_in');
  expect(result.method).toBe('inapp');
  expect(await idpHasSession(FORM_HOST)).toBe(true);

  const meta = await sessionMeta();
  expect(meta?.loginMethod).toBe('inapp');
  expect(meta?.loggedInAt).not.toBeNull();

  summary['inapp'] = { result, meta };
});

test('[M4c] inapp — 재시작 후에도 로그인 메타가 남는다', async () => {
  await app.close();
  app = await launchApp();
  await waitForWindow(app);

  // 세션 메타는 SQLite 에 있다. 파티션 쿠키의 유지는 smoke [M0] 가 실제 쿠키로 검증한다.
  const meta = await sessionMeta();
  expect(meta?.loginMethod).toBe('inapp');
  expect(meta?.loggedInAt).not.toBeNull();

  summary['restart'] = { metaAfterRestart: meta };
});

// ─────────────────────────────────────────────────────────────
// oauth_modal — 임베디드를 거부하는 IdP
// ─────────────────────────────────────────────────────────────

test('[M4c] oauth_modal — 일반 탭은 거부되고 모달로 로그인된다', async () => {
  await app.evaluate(() => globalThis.__helm?.idpReset());

  // 1) fixture 재현 확인 — 일반 탭(UA 에 Electron 토큰)은 "안전하지 않은 앱".
  const blockedTabId = await app.evaluate(
    (_e, url) => globalThis.__helm?.getTabManager()?.createTab(url) ?? -1,
    OAUTH_APP_URL
  );
  expect(blockedTabId).not.toBe(-1);
  await waitInTab(
    blockedTabId,
    '!!document.querySelector("#embedded-blocked")',
    '"안전하지 않은 앱" 화면을 대기'
  );

  // 2) 모달 경로 — Electron 토큰만 뗀 표준 Chromium UA(스푸핑 아님).
  await kickLogin(OAUTH_APP_URL, 'oauth_modal');

  const clickInModal = (selector: string): Promise<string> =>
    app.evaluate(async ({ BrowserWindow }, sel) => {
      const modal = BrowserWindow.getAllWindows().find(
        (win) => !win.isDestroyed() && win.webContents.getURL().includes('idp-oauth')
      );
      if (!modal) return 'no-modal';
      const found = (await modal.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el; })()`
      )) as boolean;
      return found ? 'clicked' : 'absent';
    }, selector);

  // 모달은 정상 브라우저로 보여야 한다 — "로그인 필요" 화면에서 로그인을 시작하고,
  await expect
    .poll(() => clickInModal('#oauth-start'), { message: '모달의 로그인 링크를 대기', timeout: 15_000 })
    .toBe('clicked');
  // 동의 화면(#oauth-allow)이 나오면 임베디드 거부를 통과한 것이다.
  await expect
    .poll(() => clickInModal('#oauth-allow'), { message: '모달의 동의 버튼을 대기', timeout: 15_000 })
    .toBe('clicked');

  const result = await waitLoginResult();
  expect(result.status).toBe('logged_in');
  expect(result.method).toBe('oauth_modal');
  expect(await idpHasSession(OAUTH_HOST)).toBe(true);

  // 모달은 redirect 가 콜백에 닿으면 스스로 닫힌다.
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(
            (win) => !win.isDestroyed() && win.webContents.getURL().includes('idp-oauth')
          ).length
        ),
      { message: '모달이 닫히기를 대기', timeout: 10_000 }
    )
    .toBe(0);

  const meta = await sessionMeta();
  expect(meta?.loginMethod).toBe('oauth_modal');

  summary['oauthModal'] = { blockedInPlainTab: true, result, meta };
});

// ─────────────────────────────────────────────────────────────
// external — 실제 브라우저로 인증만 (E2E 는 mock)
// ─────────────────────────────────────────────────────────────

test('[M4c] external — 화이트리스트 안은 mock 호출·검증 통과', async () => {
  await app.evaluate(() => globalThis.__helm?.idpReset());

  await kickLogin(FORM_APP_URL, 'external');

  // 외부 브라우저는 mock — 호출 기록으로 확인한다.
  await expect
    .poll(
      () => app.evaluate(() => globalThis.__helm?.externalOpens() ?? []),
      { message: 'openExternal 호출 기록을 대기', timeout: 10_000 }
    )
    .toContain(FORM_APP_URL);

  // "외부 브라우저에서 로그인을 마쳤다" 를 fixture 에 심고 완료를 알린다.
  await app.evaluate(async (_e, host) => globalThis.__helm?.idpLogin(host), FORM_HOST);
  const promptId = await waitPrompt('기본 브라우저');
  expect(await answerPrompt(promptId, '완료')).toBe(true);

  const result = await waitLoginResult();
  expect(result.status).toBe('logged_in');
  expect(result.method).toBe('external');
  expect(result.fellBackFrom).toBeUndefined();

  const meta = await sessionMeta();
  expect(meta?.loginMethod).toBe('external');

  summary['external'] = { result, meta };
});

test('[M4c] external — 화이트리스트 밖 호스트는 호출 전 거부·로그', async () => {
  const before = await app.evaluate(() => globalThis.__helm?.externalOpens() ?? []);

  // portal-a 는 externalLoginHosts 에 없다 — 브라우저를 열기 전에 거부되어야 한다.
  const result = await app.evaluate(async () => {
    const hook = globalThis.__helm;
    if (!hook) throw new Error('[login-e2e] __helm 훅 없음');
    return hook.loginStart('app://portal-a/app', 'external');
  });

  expect(result?.status).toBe('denied');
  expect(result?.host).toBe('portal-a');

  const after = await app.evaluate(() => globalThis.__helm?.externalOpens() ?? []);
  expect(after).toEqual(before);

  const denied = await app.evaluate(
    () =>
      globalThis.__helm
        ?.getAudit()
        ?.read()
        .filter((entry) => entry.tool === 'login_denied').length ?? 0
  );
  expect(denied).toBeGreaterThan(0);

  summary['externalDenied'] = { result, openExternalCalls: after.length };
});

// ─────────────────────────────────────────────────────────────
// 세션 만료 → login_required → 로그인 후 재개 (M4a 체크포인트 연동)
// ─────────────────────────────────────────────────────────────

test('[M4c] 세션 만료 — waiting_login → 받은편지함 카드 → 로그인 후 재개', async () => {
  const threadId = 't-login-e2e';

  await app.evaluate(() => globalThis.__helm?.idpReset());

  // 스레드가 몰던 탭이 보호 자원에서 로그인 화면으로 되밀리는 상황을 만든다.
  await app.evaluate(
    async (_e, input) => {
      const hook = globalThis.__helm;
      if (!hook) throw new Error('[login-e2e] __helm 훅 없음');
      await hook.callTool(input.threadId, 'tabs_create', { url: input.url });
    },
    { threadId, url: FORM_APP_URL }
  );

  // 감지 → 스레드 waiting_login + 받은편지함 login_required + 체크포인트.
  await expect
    .poll(
      () => app.evaluate((_e, id) => globalThis.__helm?.getThreadStore()?.get(id)?.status ?? '', threadId),
      { message: '스레드가 waiting_login 이 되기를 대기', timeout: 15_000 }
    )
    .toBe('waiting_login');

  const inboxItem = await app.evaluate(
    (_e, id) =>
      globalThis.__helm
        ?.getInbox()
        ?.list({ threadId: id })
        .find((item) => item.kind === 'login_required') ?? null,
    threadId
  );
  expect(inboxItem).not.toBeNull();

  const checkpoint = await app.evaluate(
    (_e, id) => globalThis.__helm?.getCheckpointStore()?.latest(id) ?? null,
    threadId
  );
  expect(checkpoint?.name).toBe('로그인 필요');

  // 사이드바 카드 — 경로 3종 버튼이 보인다. 스크린샷을 증거로 남긴다.
  await app.evaluate(() => globalThis.__helm?.setPanel('inbox'));
  await expect
    .poll(
      () => shellEval('document.querySelectorAll("[data-login-card] [data-login-method]").length'),
      { message: '로그인 필요 카드의 경로 버튼 3개를 대기', timeout: 15_000 }
    )
    .toBe(3);

  const shot = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) return '';
    const image = await shell.webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  const shotPath = path.join(ARTIFACTS, 'login-required-card.png');
  fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));

  // inapp 버튼 클릭 → login_start 흐름 → 로그인 → 스레드 재개.
  await shellEval('(() => { document.querySelector("[data-login-card] [data-login-method=\'inapp\']").click(); return true; })()');

  const loginTabId = await waitTab(FORM_HOST);
  await fillLoginForm(loginTabId);

  const promptId = await waitPrompt(FORM_HOST);
  expect(await answerPrompt(promptId, '로그인함')).toBe(true);

  await expect
    .poll(
      () => app.evaluate((_e, id) => globalThis.__helm?.getThreadStore()?.get(id)?.status ?? '', threadId),
      { message: '로그인 후 스레드가 running 으로 재개되기를 대기', timeout: 20_000 }
    )
    .toBe('running');

  // 카드가 일을 마치면 항목은 읽음 처리된다.
  await expect
    .poll(
      () =>
        app.evaluate(
          (_e, input) =>
            globalThis.__helm
              ?.getInbox()
              ?.list({ threadId: input.threadId })
              .find((item) => item.id === input.id)?.readAt ?? null,
          { threadId, id: (inboxItem as { id: number }).id }
        ),
      { message: '받은편지함 항목이 읽음 처리되기를 대기', timeout: 10_000 }
    )
    .not.toBeNull();

  summary['sessionExpiry'] = {
    inboxItem,
    checkpoint: { id: checkpoint?.id, name: checkpoint?.name },
    screenshot: 'login-required-card.png'
  };
});
