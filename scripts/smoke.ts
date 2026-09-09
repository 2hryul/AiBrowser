import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * M0 스모크 테스트.
 * 외부 네트워크 없이 번들 페이지(app://home/)만 사용하고,
 * 판정은 전부 메인 프로세스의 실제 상태를 읽어서 한다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm0');
/** 두 번의 실행이 같은 프로필을 공유해야 세션 유지를 검증할 수 있다. */
const PROFILE = path.join(ROOT, '.smoke-profile');
const HOME_URL = 'app://home/';
const HOME_TITLE = 'Helm 홈';
const COOKIE = { url: 'https://helm.internal/', name: 'helm_smoke_session', value: 'm0-persisted' };

interface SmokeTabState {
  id: number;
  title: string;
  url: string;
  loading: boolean;
}

interface SmokeBrowserState {
  tabs: SmokeTabState[];
  activeTabId: number | null;
}

/** HELM_E2E=1 일 때만 메인 프로세스에 노출되는 테스트 훅. */
interface HelmE2EHook {
  getTabManager: () => {
    createTab: (url?: string) => number;
    closeTab: (id: number) => void;
    selectTab: (id: number) => void;
    navigate: (id: number, input: string) => boolean;
    getState: () => SmokeBrowserState;
    getWebContents: (id: number) => Electron.WebContents | null;
    getTabBounds: (id: number) => Electron.Rectangle | null;
    expectedContentBounds: () => Electron.Rectangle;
  } | null;
  getWindow: () => Electron.BaseWindow | null;
  getShell: () => Electron.WebContentsView | null;
  sessionPartition: string;
}

declare global {
  var __helm: HelmE2EHook | undefined;
}

function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    // 프로젝트 루트를 넘겨 package.json 의 main 을 타게 한다(app.getAppPath() === ROOT).
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, HELM_E2E: '1', HELM_USER_DATA_DIR: PROFILE }
  });
}

/** 메인 윈도우가 실제로 떠서 보일 때까지 기다린다. */
async function waitForWindow(app: ElectronApplication): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(({ BaseWindow }) => {
          const win = BaseWindow.getAllWindows()[0];
          return win ? win.isVisible() : false;
        }),
      { message: '메인 윈도우가 표시되기를 대기', timeout: 30_000 }
    )
    .toBe(true);
}

function readState(app: ElectronApplication): Promise<SmokeBrowserState> {
  return app.evaluate(() => {
    const manager = globalThis.__helm?.getTabManager();
    if (!manager) throw new Error('[smoke] __helm 훅 없음 - HELM_E2E=1 로 실행했는지 확인');
    return manager.getState();
  });
}

/** capturePage 결과를 artifacts\m0 에 저장하고 크기를 돌려준다. */
async function capture(
  app: ElectronApplication,
  target: 'shell' | { tabId: number },
  fileName: string
): Promise<{ width: number; height: number; bytes: number }> {
  const arg = typeof target === 'string' ? { kind: 'shell' as const, tabId: -1 } : { kind: 'tab' as const, tabId: target.tabId };

  const shot = await app.evaluate(async (_electronApi, input) => {
    const hook = globalThis.__helm;
    if (!hook) throw new Error('[smoke] __helm 훅 없음');

    const wc =
      input.kind === 'shell'
        ? hook.getShell()?.webContents
        : hook.getTabManager()?.getWebContents(input.tabId);
    if (!wc) throw new Error(`[smoke] 캡처 대상 webContents 없음 - kind: ${input.kind}`);

    const image = await wc.capturePage();
    const size = image.getSize();
    return { base64: image.toPNG().toString('base64'), width: size.width, height: size.height };
  }, arg);

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const buffer = Buffer.from(shot.base64, 'base64');
  fs.writeFileSync(path.join(ARTIFACTS, fileName), buffer);
  return { width: shot.width, height: shot.height, bytes: buffer.byteLength };
}

/** REPORT.md 작성과 회귀 비교를 위해 실측값을 모아 파일로 남긴다. */
const summary: Record<string, unknown> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  // 세션 유지 검증이 앞선 실행 결과에 오염되지 않도록 프로필을 초기화한다.
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  summary['ranAt'] = new Date().toISOString();
});

test.afterAll(() => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'smoke-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
});

test('앱이 뜨고 탭·주소창·네비게이션이 동작한다', async () => {
  const app = await launchApp();

  try {
    await waitForWindow(app);

    // 1) 윈도우 1개, 시작 탭 1개
    expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
    await expect.poll(async () => (await readState(app)).tabs.length).toBe(1);

    // 2) 셸(React UI)이 실제로 렌더링되었는지 DOM 으로 확인
    const shellDom = await app.evaluate(async () => {
      const shell = globalThis.__helm?.getShell();
      if (!shell) throw new Error('[smoke] 셸 뷰 없음');
      const probe = [
        'JSON.stringify({',
        '  tabs: document.querySelectorAll(\'[role="tab"]\').length,',
        '  omnibox: document.querySelectorAll(\'input[aria-label="주소창"]\').length,',
        '  newTab: document.querySelectorAll(\'button[aria-label="새 탭"]\').length',
        '})'
      ].join('\n');
      return (await shell.webContents.executeJavaScript(probe)) as string;
    });
    expect(JSON.parse(shellDom)).toEqual({ tabs: 1, omnibox: 1, newTab: 1 });

    // 3) 탭 2개 추가 생성(시작 탭 포함 총 3개) 후 하나를 app://home/ 으로 이동
    const created = await app.evaluate(() => {
      const manager = globalThis.__helm?.getTabManager();
      if (!manager) throw new Error('[smoke] 탭 매니저 없음');
      return [manager.createTab('about:blank'), manager.createTab('about:blank')];
    });
    expect(created).toHaveLength(2);
    await expect.poll(async () => (await readState(app)).tabs.length).toBe(3);

    const targetTabId = created[0] as number;
    const navigated = await app.evaluate(
      (_e, id) => globalThis.__helm?.getTabManager()?.navigate(id, 'app://home/') ?? false,
      targetTabId
    );
    expect(navigated).toBe(true);

    // 4) 문서 title 이 기대값과 일치 → 번들 페이지가 실제로 서비스됨
    await expect
      .poll(
        () =>
          app.evaluate(
            (_e, id) => globalThis.__helm?.getTabManager()?.getWebContents(id)?.getTitle() ?? '',
            targetTabId
          ),
        { message: 'app://home/ 문서 title 대기' }
      )
      .toBe(HOME_TITLE);

    const homeState = (await readState(app)).tabs.find((t) => t.id === targetTabId);
    expect(homeState?.url).toBe(HOME_URL);

    // 5) 탭 전환
    await app.evaluate((_e, id) => globalThis.__helm?.getTabManager()?.selectTab(id), targetTabId);
    expect((await readState(app)).activeTabId).toBe(targetTabId);

    // 6) 탭 닫기 — 닫은 탭은 사라지고 활성 탭은 유지
    const doomed = created[1] as number;
    await app.evaluate((_e, id) => globalThis.__helm?.getTabManager()?.closeTab(id), doomed);
    await expect.poll(async () => (await readState(app)).tabs.length).toBe(2);

    const afterClose = await readState(app);
    expect(afterClose.tabs.map((t) => t.id)).not.toContain(doomed);
    expect(afterClose.activeTabId).toBe(targetTabId);

    // 7) 탭 웹 콘텐츠가 사이드바·툴바를 침범하지 않고 정확히 맞물리는지
    const layout = await app.evaluate((_e, id) => {
      const manager = globalThis.__helm?.getTabManager();
      if (!manager) throw new Error('[smoke] 탭 매니저 없음');
      return { actual: manager.getTabBounds(id), expected: manager.expectedContentBounds() };
    }, targetTabId);
    expect(layout.actual).toEqual(layout.expected);
    expect(layout.expected.x).toBe(240);
    expect(layout.expected.y).toBe(48);

    // 뷰 bounds 뿐 아니라 페이지 뷰포트가 실제로 그 영역을 다 채우는지까지 본다.
    const viewport = await app.evaluate(async (_e, id) => {
      const wc = globalThis.__helm?.getTabManager()?.getWebContents(id);
      if (!wc) throw new Error('[smoke] 탭 webContents 없음');
      return (await wc.executeJavaScript(
        'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'
      )) as string;
    }, targetTabId);
    expect(JSON.parse(viewport)).toEqual({
      w: layout.expected.width,
      h: layout.expected.height
    });
    summary['contentBounds'] = layout.expected;
    summary['pageViewport'] = JSON.parse(viewport);

    // 셸 뷰는 창 콘텐츠 영역과 정확히 같아야 한다.
    // (show() 전 크기로 굳으면 사이드바 하단이 창 밖으로 밀려 잘린다.)
    const readShellFit = (): Promise<{ shell: Electron.Rectangle; window: Electron.Rectangle }> =>
      app.evaluate(() => {
        const hook = globalThis.__helm;
        const win = hook?.getWindow();
        const shell = hook?.getShell();
        if (!win || !shell) throw new Error('[smoke] 창 또는 셸 뷰 없음');
        const content = win.getContentBounds();
        return {
          shell: shell.getBounds(),
          window: { x: 0, y: 0, width: content.width, height: content.height }
        };
      });

    await expect
      .poll(async () => {
        const fit = await readShellFit();
        return JSON.stringify(fit.shell) === JSON.stringify(fit.window);
      }, { message: '셸 뷰가 창 콘텐츠 영역에 정확히 맞기를 대기' })
      .toBe(true);
    summary['shellBounds'] = (await readShellFit()).shell;

    // 8) 셸 UI가 메인이 푸시한 상태를 실제로 반영했는지 (IPC → zustand → DOM)
    await expect
      .poll(
        () =>
          app.evaluate(async () => {
            const shell = globalThis.__helm?.getShell();
            if (!shell) throw new Error('[smoke] 셸 뷰 없음');
            const probe = [
              'JSON.stringify({',
              '  count: document.querySelectorAll(\'[role="tab"]\').length,',
              '  active: document.querySelector(\'[role="tab"][aria-selected="true"]\')?.textContent?.trim() ?? null,',
              '  address: document.querySelector(\'input[aria-label="주소창"]\')?.value ?? null',
              '})'
            ].join('\n');
            return (await shell.webContents.executeJavaScript(probe)) as string;
          }),
        { message: '셸 DOM 이 닫기·전환 결과를 반영하기를 대기' }
      )
      .toBe(JSON.stringify({ count: 2, active: HOME_TITLE, address: HOME_URL }));

    // 9) 스크린샷 — 렌더링 여부는 말이 아니라 해상도·파일 크기로 확인한다
    const shellShot = await capture(app, 'shell', 'shell.png');
    expect(shellShot.width).toBeGreaterThan(600);
    expect(shellShot.height).toBeGreaterThan(400);
    expect(shellShot.bytes).toBeGreaterThan(5_000);

    const homeShot = await capture(app, { tabId: targetTabId }, 'home-tab.png');
    expect(homeShot.width).toBeGreaterThan(400);
    expect(homeShot.bytes).toBeGreaterThan(3_000);

    summary['screenshots'] = { 'shell.png': shellShot, 'home-tab.png': homeShot };
    summary['tabs'] = { createdTotal: 3, afterClose: afterClose.tabs.length, homeTitle: HOME_TITLE };

    // 10) persist:helm 파티션에 쿠키를 심고 디스크로 flush
    await app.evaluate(
      async ({ session }, input) => {
        const partition = session.fromPartition(input.partition);
        await partition.cookies.set({
          url: input.url,
          name: input.name,
          value: input.value,
          // 만료 시각이 있어야 세션 쿠키가 아니라 영구 쿠키로 디스크에 남는다.
          expirationDate: Math.floor(Date.now() / 1000) + 3600
        });
        await partition.cookies.flushStore();
      },
      { partition: 'persist:helm', url: COOKIE.url, name: COOKIE.name, value: COOKIE.value }
    );
  } finally {
    await app.close();
  }
});

test('재시작 후에도 persist:helm 세션이 유지된다', async () => {
  const app = await launchApp();

  try {
    await waitForWindow(app);

    const cookies = await app.evaluate(
      ({ session }, input) =>
        session.fromPartition(input.partition).cookies.get({ url: input.url, name: input.name }),
      { partition: 'persist:helm', url: COOKIE.url, name: COOKIE.name }
    );

    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.value).toBe(COOKIE.value);

    summary['sessionPersistence'] = {
      partition: 'persist:helm',
      cookie: COOKIE.name,
      valueAfterRestart: cookies[0]?.value ?? null
    };
  } finally {
    await app.close();
  }
});
