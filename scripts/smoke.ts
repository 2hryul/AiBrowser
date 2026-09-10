import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * M0 + M1 스모크 테스트.
 *
 * 판정은 전부 메인 프로세스의 실제 상태나 셸 DOM 을 읽어서 한다.
 * 외부 네트워크에 나가지 않는다 — 검증에 쓰는 페이지는 모두 app:// 번들 리소스다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm1');
/** 두 번의 실행이 같은 프로필을 공유해야 세션 유지를 검증할 수 있다. */
const PROFILE = path.join(ROOT, '.smoke-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.smoke-downloads');

const HOME_URL = 'app://home/';
const HOME_TITLE = 'Helm 홈';
const ARTICLE_URL = 'app://fixtures/article.html';
const ARTICLE_TITLE = '사내 문서 보관 규정 개정 안내';
const READER_URL = 'app://fixtures/reader/semantic-article.html';
const PDF_URL = 'app://fixtures/sample.pdf';
const COOKIE = { url: 'https://helm.internal/', name: 'helm_smoke_session', value: 'm1-persisted' };

interface SmokeTabState {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  pinned: boolean;
  suspended: boolean;
  readerable: boolean;
}

interface SmokeBrowserState {
  tabs: SmokeTabState[];
  activeTabId: number | null;
  orientation: 'vertical' | 'horizontal';
  canRestoreClosedTab: boolean;
}

/** HELM_E2E=1 일 때만 메인 프로세스에 노출되는 테스트 훅. */
interface HelmE2EHook {
  getTabManager: () => {
    createTab: (url?: string) => number;
    closeTab: (id: number) => void;
    selectTab: (id: number) => void;
    navigate: (id: number, input: string) => boolean;
    moveTab: (id: number, toIndex: number) => boolean;
    setPinned: (id: number, pinned: boolean) => boolean;
    restoreClosedTab: () => number | null;
    unloadIdleTabs: (now?: number) => number;
    indexOf: (id: number) => number;
    getState: () => SmokeBrowserState;
    getWebContents: (id: number) => Electron.WebContents | null;
    getTabBounds: (id: number) => Electron.Rectangle | null;
    expectedContentBounds: () => Electron.Rectangle;
    activeTabId: number | null;
  } | null;
  getWindow: () => Electron.BaseWindow | null;
  getShell: () => Electron.WebContentsView | null;
  getShellState: () => { panel: string; find: unknown; theme: string; darkMode: boolean };
  getHistory: () => { clear: () => void; count: () => number } | null;
  getBookmarks: () => { count: () => number } | null;
  getDownloads: () => { list: () => { fileName: string; state: string; savePath: string }[] } | null;
  getSession: () => Electron.Session;
  setPanel: (panel: string) => void;
  loadExtensionsFrom: (
    dirs: { name: string; path: string }[]
  ) => Promise<
    { name: string; ok: boolean; manifestName: string | null; version: string | null; error: string | null; unsupportedPermissions: string[] }[]
  >;
  downloadDir: string;
  sessionPartition: string;
}

declare global {
  var __helm: HelmE2EHook | undefined;
}

// ─────────────────────────────────────────────────────────────
// 공통 헬퍼
// ─────────────────────────────────────────────────────────────

function launchApp(overrides: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    // 프로젝트 루트를 넘겨 package.json 의 main 을 타게 한다(app.getAppPath() === ROOT).
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      HELM_E2E: '1',
      HELM_USER_DATA_DIR: PROFILE,
      HELM_DOWNLOAD_DIR: DOWNLOAD_DIR,
      // 30분을 기다릴 수 없으므로 유휴 언로드 임계 시간을 줄인다.
      HELM_IDLE_UNLOAD_MS: '400',
      ...overrides
    }
  });
}

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

/** 셸(브라우저 크롬) 안에서 표현식을 평가한다. 반환값은 JSON 직렬화된 문자열이어야 한다. */
function shellEval(app: ElectronApplication, expression: string): Promise<string> {
  return app.evaluate(async (_electronApi, expr) => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[smoke] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(expr)) as string;
  }, expression);
}

/** 탭의 문서가 기대 제목이 될 때까지 기다린다. */
async function waitForTitle(
  app: ElectronApplication,
  tabId: number,
  expected: string
): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(
          (_e, id) => globalThis.__helm?.getTabManager()?.getWebContents(id)?.getTitle() ?? '',
          tabId
        ),
      { message: `탭 ${tabId} 의 문서 title 이 "${expected}" 가 되기를 대기` }
    )
    .toBe(expected);
}

/** 탭을 주소로 이동시키고 로딩이 끝날 때까지 기다린다. */
async function navigateAndWait(
  app: ElectronApplication,
  tabId: number,
  url: string
): Promise<void> {
  const ok = await app.evaluate(
    (_e, arg) => globalThis.__helm?.getTabManager()?.navigate(arg.id, arg.url) ?? false,
    { id: tabId, url }
  );
  expect(ok, `${url} 이동 요청 실패`).toBe(true);

  await expect
    .poll(
      () =>
        app.evaluate((_e, id) => {
          const wc = globalThis.__helm?.getTabManager()?.getWebContents(id);
          return wc ? `${wc.getURL()}|${wc.isLoading() ? 'loading' : 'done'}` : '';
        }, tabId),
      { message: `${url} 로딩 완료 대기` }
    )
    .toBe(`${url}|done`);
}

interface Shot {
  width: number;
  height: number;
  bytes: number;
  /** 평균 밝기(0~255). 다크모드 판정에 쓴다. */
  luminance: number;
}

/**
 * capturePage 결과를 artifacts\m1 에 저장하고 크기·평균 밝기를 돌려준다.
 * 평균 밝기는 PNG 를 디코딩하지 않고 NativeImage.toBitmap()(BGRA 원본)에서 바로 계산한다.
 */
async function capture(
  app: ElectronApplication,
  target: 'shell' | { tabId: number },
  fileName: string
): Promise<Shot> {
  const arg =
    typeof target === 'string' ? { kind: 'shell' as const, tabId: -1 } : { kind: 'tab' as const, tabId: target.tabId };

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
    const bitmap = image.toBitmap(); // BGRA

    // 픽셀을 4개씩 건너뛰며 표본만 본다 — 전체를 다 훑을 필요는 없다.
    let sum = 0;
    let count = 0;
    for (let i = 0; i < bitmap.length; i += 16) {
      const b = bitmap[i] ?? 0;
      const g = bitmap[i + 1] ?? 0;
      const r = bitmap[i + 2] ?? 0;
      sum += 0.299 * r + 0.587 * g + 0.114 * b;
      count += 1;
    }

    return {
      base64: image.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
      luminance: count === 0 ? 0 : sum / count
    };
  }, arg);

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const buffer = Buffer.from(shot.base64, 'base64');
  fs.writeFileSync(path.join(ARTIFACTS, fileName), buffer);

  return {
    width: shot.width,
    height: shot.height,
    bytes: buffer.byteLength,
    luminance: Math.round(shot.luminance * 10) / 10
  };
}

/** REPORT.md 작성과 회귀 비교를 위해 실측값을 모아 파일로 남긴다. */
const summary: Record<string, unknown> = {};

let app: ElectronApplication;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // 세션 유지 검증이 앞선 실행 결과에 오염되지 않도록 프로필과 다운로드 폴더를 초기화한다.
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  summary['ranAt'] = new Date().toISOString();

  app = await launchApp();
  await waitForWindow(app);
});

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'smoke-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
});

// ─────────────────────────────────────────────────────────────
// M0 유지 항목
// ─────────────────────────────────────────────────────────────

test('[M0] 앱이 뜨고 탭·주소창·네비게이션이 동작한다', async () => {
  // 1) 윈도우 1개, 시작 탭 1개
  expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
  await expect.poll(async () => (await readState(app)).tabs.length).toBe(1);

  // 2) 셸(React UI)이 실제로 렌더링되었는지 DOM 으로 확인
  const shellDom = await shellEval(
    app,
    `JSON.stringify({
       tabs: document.querySelectorAll('[role="tab"]').length,
       omnibox: document.querySelectorAll('input[aria-label="주소창"]').length,
       newTab: document.querySelectorAll('button[aria-label="새 탭"]').length
     })`
  );
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
  await navigateAndWait(app, targetTabId, HOME_URL);

  // 4) 문서 title 이 기대값과 일치 → 번들 페이지가 실제로 서비스됨
  await waitForTitle(app, targetTabId, HOME_TITLE);

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

  // 7) 웹 콘텐츠가 사이드바·툴바를 침범하지 않고 정확히 맞물리는지
  const layout = await app.evaluate((_e, id) => {
    const manager = globalThis.__helm?.getTabManager();
    if (!manager) throw new Error('[smoke] 탭 매니저 없음');
    return { actual: manager.getTabBounds(id), expected: manager.expectedContentBounds() };
  }, targetTabId);
  expect(layout.actual).toEqual(layout.expected);
  expect(layout.expected.x).toBe(240);
  expect(layout.expected.y).toBe(48);

  const viewport = await app.evaluate(async (_e, id) => {
    const wc = globalThis.__helm?.getTabManager()?.getWebContents(id);
    if (!wc) throw new Error('[smoke] 탭 webContents 없음');
    return (await wc.executeJavaScript(
      'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'
    )) as string;
  }, targetTabId);
  expect(JSON.parse(viewport)).toEqual({ w: layout.expected.width, h: layout.expected.height });

  // 셸 뷰는 창 콘텐츠 영역과 정확히 같아야 한다.
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
    .poll(
      async () => {
        const fit = await readShellFit();
        return JSON.stringify(fit.shell) === JSON.stringify(fit.window);
      },
      { message: '셸 뷰가 창 콘텐츠 영역에 정확히 맞기를 대기' }
    )
    .toBe(true);

  // 8) 셸 UI가 메인이 푸시한 상태를 실제로 반영했는지 (IPC → zustand → DOM)
  await expect
    .poll(
      () =>
        shellEval(
          app,
          `JSON.stringify({
             count: document.querySelectorAll('[role="tab"]').length,
             active: document.querySelector('[role="tab"][aria-selected="true"] [data-tab-title]')?.textContent?.trim() ?? null,
             address: document.querySelector('input[aria-label="주소창"]')?.value ?? null
           })`
        ),
      { message: '셸 DOM 이 닫기·전환 결과를 반영하기를 대기' }
    )
    .toBe(JSON.stringify({ count: 2, active: HOME_TITLE, address: HOME_URL }));

  summary['m0'] = {
    contentBounds: layout.expected,
    pageViewport: JSON.parse(viewport),
    shellBounds: (await readShellFit()).shell,
    tabsAfterClose: afterClose.tabs.length
  };
});

// ─────────────────────────────────────────────────────────────
// M1 추가 항목
// ─────────────────────────────────────────────────────────────

test('[M1] 히스토리 — 3개 URL 방문 후 3건 표시, 검색 필터 동작', async () => {
  // 시작 탭이 남긴 기록을 비우고 정확히 3개만 방문한다.
  await app.evaluate(() => globalThis.__helm?.getHistory()?.clear());
  expect(await app.evaluate(() => globalThis.__helm?.getHistory()?.count() ?? -1)).toBe(0);

  const tabId = (await readState(app)).activeTabId as number;
  for (const url of [HOME_URL, ARTICLE_URL, READER_URL]) {
    await navigateAndWait(app, tabId, url);
  }

  expect(await app.evaluate(() => globalThis.__helm?.getHistory()?.count() ?? -1)).toBe(3);

  // 히스토리 화면에 3건이 보이는지 셸 DOM 으로 확인
  await app.evaluate(() => globalThis.__helm?.setPanel('history'));
  await expect
    .poll(
      () =>
        shellEval(
          app,
          `JSON.stringify({
             panel: document.querySelector('[role="region"]')?.getAttribute('aria-label') ?? null,
             rows: document.querySelector('[data-history-count]')?.getAttribute('data-history-count') ?? null
           })`
        ),
      { message: '히스토리 화면에 3건이 표시되기를 대기' }
    )
    .toBe(JSON.stringify({ panel: '방문 기록', rows: '3' }));

  // 검색 필터 — '홈' 은 app://home/ 한 건만 남아야 한다.
  await expect
    .poll(
      async () => {
        await shellEval(
          app,
          `(() => {
             const input = document.querySelector('input[aria-label="방문 기록 검색"]');
             const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
             setter.call(input, 'home');
             input.dispatchEvent(new Event('input', { bubbles: true }));
             return 'ok';
           })()`
        );
        return shellEval(
          app,
          `JSON.stringify(Array.from(document.querySelectorAll('[data-history-url]')).map((el) => el.getAttribute('data-history-url')))`
        );
      },
      { message: '검색 필터가 app://home/ 만 남기기를 대기' }
    )
    .toBe(JSON.stringify([HOME_URL]));

  const filtered = await app.evaluate(() => ({
    all: globalThis.__helm?.getHistory()?.count() ?? -1
  }));

  await app.evaluate(() => globalThis.__helm?.setPanel('none'));
  summary['history'] = { visited: 3, stored: filtered.all, filterQuery: 'home', filterRows: 1 };
});

test('[M1] 북마크 — 추가 → 북마크바 표시 → 클릭 이동 → 삭제', async () => {
  const tabId = (await readState(app)).activeTabId as number;
  await navigateAndWait(app, tabId, ARTICLE_URL);
  await waitForTitle(app, tabId, ARTICLE_TITLE);

  // 추가: 툴바의 별 버튼을 실제로 누른다(사람이 하는 경로).
  await shellEval(app, `(document.querySelector('button[aria-label="북마크 추가"]').click(), 'ok')`);

  await expect
    .poll(() => app.evaluate(() => globalThis.__helm?.getBookmarks()?.count() ?? -1), {
      message: '북마크 1건이 저장되기를 대기'
    })
    .toBe(1);

  // 북마크바가 뜨고 방금 추가한 항목이 보인다.
  const barBefore = await expect
    .poll(
      () =>
        shellEval(
          app,
          `JSON.stringify({
             bar: !!document.querySelector('[role="toolbar"][aria-label="북마크바"]'),
             items: Array.from(document.querySelectorAll('[role="toolbar"][aria-label="북마크바"] [data-bookmark-id]')).map((el) => el.textContent.trim())
           })`
        ),
      { message: '북마크바가 표시되기를 대기' }
    )
    .toBe(JSON.stringify({ bar: true, items: [`★${ARTICLE_TITLE}`] }));
  void barBefore;

  // 북마크바가 생기면 웹 콘텐츠 상단 여백이 그만큼 내려간다.
  const insetWithBar = await app.evaluate(
    () => globalThis.__helm?.getTabManager()?.expectedContentBounds().y ?? -1
  );
  expect(insetWithBar).toBe(48 + 32);

  // 클릭 이동: 먼저 홈으로 옮긴 뒤 북마크바를 눌러 되돌아오는지 본다.
  await navigateAndWait(app, tabId, HOME_URL);
  await shellEval(
    app,
    `(document.querySelector('[role="toolbar"][aria-label="북마크바"] [data-bookmark-id]').click(), 'ok')`
  );
  await waitForTitle(app, tabId, ARTICLE_TITLE);
  expect((await readState(app)).tabs.find((t) => t.id === tabId)?.url).toBe(ARTICLE_URL);

  // 삭제: 다시 별 버튼(이제 '북마크 삭제')을 누른다.
  await shellEval(app, `(document.querySelector('button[aria-label="북마크 삭제"]').click(), 'ok')`);
  await expect
    .poll(() => app.evaluate(() => globalThis.__helm?.getBookmarks()?.count() ?? -1), {
      message: '북마크가 삭제되기를 대기'
    })
    .toBe(0);

  // 북마크가 없으면 북마크바도 사라지고 여백이 원래대로 돌아온다.
  await expect
    .poll(() =>
      app.evaluate(() => globalThis.__helm?.getTabManager()?.expectedContentBounds().y ?? -1)
    )
    .toBe(48);

  summary['bookmarks'] = { addedThenRemoved: true, insetWithBar, insetWithoutBar: 48 };
});

test('[M1] 다운로드 — app://fixtures/sample.pdf 완료 항목과 실제 파일', async () => {
  // 사용자가 페이지에서 링크를 누르는 경로와 같게, 활성 탭의 webContents 로 내려받는다.
  await app.evaluate((_e, url) => {
    const manager = globalThis.__helm?.getTabManager();
    const id = manager?.activeTabId ?? null;
    const wc = id === null ? null : manager?.getWebContents(id);
    if (!wc) throw new Error('[smoke] 활성 탭 webContents 없음');
    wc.downloadURL(url);
  }, PDF_URL);

  const done = await expect
    .poll(
      () =>
        app.evaluate(() => {
          const items = globalThis.__helm?.getDownloads()?.list() ?? [];
          const item = items[0];
          return item ? `${item.fileName}|${item.state}` : 'none';
        }),
      { message: '다운로드가 완료되기를 대기', timeout: 20_000 }
    )
    .toBe('sample.pdf|completed');
  void done;

  const savePath = await app.evaluate(
    () => globalThis.__helm?.getDownloads()?.list()[0]?.savePath ?? ''
  );
  expect(savePath).not.toBe('');
  expect(fs.existsSync(savePath), `다운로드 파일이 없습니다: ${savePath}`).toBe(true);

  const size = fs.statSync(savePath).size;
  expect(size).toBe(fs.statSync(path.join(ROOT, 'fixtures', 'sample.pdf')).size);

  // 다운로드 관리자 화면에 완료 항목이 보인다.
  await app.evaluate(() => globalThis.__helm?.setPanel('downloads'));
  await expect
    .poll(
      () =>
        shellEval(
          app,
          `JSON.stringify({
             count: document.querySelector('[data-downloads-count]')?.getAttribute('data-downloads-count') ?? null,
             file: document.querySelector('[data-download-file]')?.getAttribute('data-download-file') ?? null,
             state: document.querySelector('[data-download-state]')?.getAttribute('data-download-state') ?? null
           })`
        ),
      { message: '다운로드 관리자에 완료 항목이 보이기를 대기' }
    )
    .toBe(JSON.stringify({ count: '1', file: 'sample.pdf', state: 'completed' }));

  await app.evaluate(() => globalThis.__helm?.setPanel('none'));
  summary['downloads'] = { file: 'sample.pdf', savePath, bytes: size };
});

test('[M1] 옴니박스 — "hom" 입력 시 app://home 이 1순위', async () => {
  const suggestions = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[smoke] 셸 뷰 없음');
    // 주소창에 실제로 타이핑해서 제안 목록을 띄운다.
    return (await shell.webContents.executeJavaScript(
      `(async () => {
         const input = document.querySelector('input[aria-label="주소창"]');
         input.focus();
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         setter.call(input, 'hom');
         input.dispatchEvent(new Event('input', { bubbles: true }));
         await new Promise((r) => setTimeout(r, 400));
         return JSON.stringify(
           Array.from(document.querySelectorAll('#omnibox-suggestions [role="option"]')).map((el) => ({
             rank: el.getAttribute('data-suggestion-rank'),
             text: el.textContent.trim()
           }))
         );
       })()`
    )) as string;
  });

  const parsed = JSON.parse(suggestions) as { rank: string; text: string }[];
  expect(parsed.length, '제안이 하나도 없습니다').toBeGreaterThan(0);
  expect(parsed[0]?.rank).toBe('0');
  expect(parsed[0]?.text).toContain(HOME_URL);

  // 메인의 제안 계산 결과도 같은 순서인지 직접 확인한다.
  const raw = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[smoke] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(
      `window.helm.suggest('hom').then((r) => JSON.stringify(r))`
    )) as string;
  });
  const fromMain = JSON.parse(raw) as { kind: string; url: string }[];
  expect(fromMain[0]?.url).toBe(HOME_URL);

  // 주소창 정리
  await shellEval(
    app,
    `(() => {
       const input = document.querySelector('input[aria-label="주소창"]');
       input.blur();
       return 'ok';
     })()`
  );

  summary['omnibox'] = { input: 'hom', topSuggestion: fromMain[0]?.url, total: fromMain.length };
});

test('[M1] 탭 고급 — 복구·고정·드래그 정렬·유휴 언로드', async () => {
  // 정리: 탭을 2개로 맞춘다.
  const before = await readState(app);
  for (const tab of before.tabs.slice(1)) {
    await app.evaluate((_e, id) => globalThis.__helm?.getTabManager()?.closeTab(id), tab.id);
  }
  await expect.poll(async () => (await readState(app)).tabs.length).toBe(1);

  const extra = await app.evaluate(
    (_e, url) => globalThis.__helm?.getTabManager()?.createTab(url) ?? -1,
    ARTICLE_URL
  );
  await expect.poll(async () => (await readState(app)).tabs.length).toBe(2);

  // 1) 닫은 탭 복구
  await app.evaluate((_e, id) => globalThis.__helm?.getTabManager()?.closeTab(id), extra);
  await expect.poll(async () => (await readState(app)).tabs.length).toBe(1);
  expect((await readState(app)).canRestoreClosedTab).toBe(true);

  const restored = await app.evaluate(
    () => globalThis.__helm?.getTabManager()?.restoreClosedTab() ?? null
  );
  expect(restored).not.toBeNull();
  await expect.poll(async () => (await readState(app)).tabs.length).toBe(2);
  await waitForTitle(app, restored as number, ARTICLE_TITLE);

  // 2) 고정 탭에는 닫기 버튼이 없다
  await app.evaluate(
    (_e, id) => globalThis.__helm?.getTabManager()?.setPinned(id, true),
    restored as number
  );
  await expect
    .poll(
      () =>
        shellEval(
          app,
          `JSON.stringify({
             pinnedTabs: document.querySelectorAll('[role="tab"][data-pinned="true"]').length,
             closeButtonsOnPinned: document.querySelectorAll('[role="tab"][data-pinned="true"] button[aria-label$="탭 닫기"]').length
           })`
        ),
      { message: '고정 탭이 셸에 반영되기를 대기' }
    )
    .toBe(JSON.stringify({ pinnedTabs: 1, closeButtonsOnPinned: 0 }));

  // 고정 탭은 IPC 로 닫기를 요청해도 닫히지 않는다.
  await app.evaluate(
    (_e, id) => globalThis.__helm?.getTabManager()?.closeTab(id),
    restored as number
  );
  expect((await readState(app)).tabs.length).toBe(2);

  // 고정 탭은 목록 앞쪽으로 모인다.
  expect(
    await app.evaluate(
      (_e, id) => globalThis.__helm?.getTabManager()?.indexOf(id) ?? -1,
      restored as number
    )
  ).toBe(0);

  // 3) 드래그 정렬 — 고정을 풀고 순서를 바꾼다.
  await app.evaluate(
    (_e, id) => globalThis.__helm?.getTabManager()?.setPinned(id, false),
    restored as number
  );
  const order = (await readState(app)).tabs.map((t) => t.id);
  const moved = await app.evaluate(
    (_e, arg) => globalThis.__helm?.getTabManager()?.moveTab(arg.id, arg.to) ?? false,
    { id: order[0] as number, to: 1 }
  );
  expect(moved).toBe(true);
  expect((await readState(app)).tabs.map((t) => t.id)).toEqual([order[1], order[0]]);

  // 4) 유휴 언로드 — 임계 시간(테스트에서 400ms)이 지난 비활성 탭이 내려간다.
  const activeId = (await readState(app)).activeTabId as number;
  await new Promise((resolve) => setTimeout(resolve, 700));
  const unloaded = await app.evaluate(
    () => globalThis.__helm?.getTabManager()?.unloadIdleTabs() ?? -1
  );
  expect(unloaded).toBeGreaterThanOrEqual(1);

  const suspendedState = await readState(app);
  expect(suspendedState.tabs.find((t) => t.id !== activeId)?.suspended).toBe(true);
  expect(suspendedState.tabs.find((t) => t.id === activeId)?.suspended).toBe(false);

  // 다시 선택하면 복구된다.
  const sleeping = suspendedState.tabs.find((t) => t.id !== activeId)?.id as number;
  await app.evaluate((_e, id) => globalThis.__helm?.getTabManager()?.selectTab(id), sleeping);
  await expect
    .poll(async () => (await readState(app)).tabs.find((t) => t.id === sleeping)?.suspended, {
      message: '언로드된 탭이 복구되기를 대기'
    })
    .toBe(false);

  summary['tabs'] = {
    restoredClosedTab: true,
    pinnedHasNoCloseButton: true,
    reordered: true,
    idleUnloaded: unloaded
  };
});

test('[M1] 읽기 모드 — 본문은 살리고 광고 div 는 걷어낸다', async () => {
  const tabId = (await readState(app)).activeTabId as number;
  await navigateAndWait(app, tabId, ARTICLE_URL);
  await waitForTitle(app, tabId, ARTICLE_TITLE);

  const payloadRaw = await app.evaluate(async (_e, id) => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[smoke] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(
      `window.helm.readTab(${id}).then((p) => JSON.stringify({
         hasArticle: !!p.article,
         reason: p.reason,
         title: p.article ? p.article.title : null,
         length: p.article ? p.article.length : 0,
         hasBody: p.article ? p.article.textContent.includes('문서보관기준개정본문') : false,
         hasAdTop: p.article ? p.article.textContent.includes('광고영역상단') : true,
         hasAdBottom: p.article ? p.article.textContent.includes('광고영역하단') : true,
         hasScript: p.article ? p.article.content.includes('<script') : true
       }))`
    )) as string;
  }, tabId);

  const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  expect(payload['hasArticle']).toBe(true);
  expect(payload['title']).toBe(ARTICLE_TITLE);
  expect(payload['hasBody'], '본문 표식이 빠졌습니다').toBe(true);
  expect(payload['hasAdTop'], '상단 광고가 본문에 섞였습니다').toBe(false);
  expect(payload['hasAdBottom'], '하단 광고가 본문에 섞였습니다').toBe(false);
  expect(payload['hasScript'], '스크립트가 본문에 남았습니다').toBe(false);
  expect(payload['length'] as number).toBeGreaterThan(400);

  // 읽기 모드 화면이 실제로 그려지는지 확인하고 스크린샷을 남긴다.
  await app.evaluate(() => globalThis.__helm?.setPanel('reader'));
  await expect
    .poll(
      () =>
        shellEval(
          app,
          `JSON.stringify({
             region: document.querySelector('[role="region"]')?.getAttribute('aria-label') ?? null,
             hasBody: (document.querySelector('[data-reader-length]')?.textContent ?? '').includes('문서보관기준개정본문')
           })`
        ),
      { message: '읽기 모드 화면이 그려지기를 대기' }
    )
    .toBe(JSON.stringify({ region: '읽기 모드', hasBody: true }));

  const readerShot = await capture(app, 'shell', 'reader.png');
  expect(readerShot.bytes).toBeGreaterThan(5_000);

  await app.evaluate(() => globalThis.__helm?.setPanel('none'));
  summary['reader'] = { title: payload['title'], length: payload['length'], screenshot: 'reader.png' };
});

test('[M1] 페이지 내 찾기 — 일치 수를 표시한다', async () => {
  const tabId = (await readState(app)).activeTabId as number;
  await navigateAndWait(app, tabId, ARTICLE_URL);

  const result = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[smoke] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(
      `window.helm.find('보관', false, true).then((r) => JSON.stringify(r))`
    )) as string;
  });

  const find = JSON.parse(result) as { query: string; matches: number; activeMatchOrdinal: number };
  expect(find.query).toBe('보관');
  expect(find.matches, '일치가 하나도 없습니다').toBeGreaterThan(0);

  // 찾기바가 뜨고 일치 수가 보인다.
  await expect
    .poll(
      () =>
        shellEval(
          app,
          `JSON.stringify({
             bar: !!document.querySelector('[role="search"][aria-label="페이지에서 찾기"]'),
             matches: document.querySelector('[data-find-matches]')?.getAttribute('data-find-matches') ?? null
           })`
        ),
      { message: '찾기바에 일치 수가 표시되기를 대기' }
    )
    .toBe(JSON.stringify({ bar: true, matches: String(find.matches) }));

  // 찾기바가 뜨면 콘텐츠 상단 여백이 그만큼 내려간다.
  expect(
    await app.evaluate(() => globalThis.__helm?.getTabManager()?.expectedContentBounds().y ?? -1)
  ).toBe(48 + 40);

  // 닫으면 원래대로
  await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (shell) await shell.webContents.executeJavaScript('window.helm.stopFind()');
  });
  await expect
    .poll(() =>
      app.evaluate(() => globalThis.__helm?.getTabManager()?.expectedContentBounds().y ?? -1)
    )
    .toBe(48);

  summary['find'] = { query: '보관', matches: find.matches };
});

test('[M1] 다크모드 — 토글하면 셸 배경 밝기가 임계값을 넘나든다', async () => {
  const setTheme = async (theme: 'light' | 'dark'): Promise<void> => {
    await app.evaluate(async (_e, value) => {
      const shell = globalThis.__helm?.getShell();
      if (!shell) throw new Error('[smoke] 셸 뷰 없음');
      await shell.webContents.executeJavaScript(`window.helm.setTheme(${JSON.stringify(value)})`);
    }, theme);

    await expect
      .poll(() => app.evaluate(() => globalThis.__helm?.getShellState().theme ?? ''), {
        message: `테마가 ${theme} 로 바뀌기를 대기`
      })
      .toBe(theme);
    // 미디어 쿼리 재평가와 리페인트를 기다린다.
    await new Promise((resolve) => setTimeout(resolve, 400));
  };

  await setTheme('light');
  const light = await capture(app, 'shell', 'shell-light.png');

  await setTheme('dark');
  const dark = await capture(app, 'shell', 'shell-dark.png');

  // 밝은 테마는 밝고 어두운 테마는 어둡다 — 임계값으로 판정한다.
  expect(light.luminance, `밝은 테마 평균 밝기 ${light.luminance}`).toBeGreaterThan(150);
  expect(dark.luminance, `어두운 테마 평균 밝기 ${dark.luminance}`).toBeLessThan(90);
  expect(light.luminance - dark.luminance).toBeGreaterThan(80);

  summary['darkMode'] = { lightLuminance: light.luminance, darkLuminance: dark.luminance };
});

test('[M1] 확장 로드 — 결과를 기록하고 미지원 권한을 짚는다', async () => {
  const results = await app.evaluate(
    (_e, dirs) => globalThis.__helm?.loadExtensionsFrom(dirs) ?? Promise.resolve([]),
    [
      { name: 'helm-devtest', path: path.join(ROOT, 'fixtures', 'extensions', 'helm-devtest') },
      { name: 'helm-unsupported', path: path.join(ROOT, 'fixtures', 'extensions', 'helm-unsupported') },
      { name: 'helm-missing', path: path.join(ROOT, 'fixtures', 'extensions', '없는-확장') }
    ]
  );

  expect(results).toHaveLength(3);

  const devtest = results.find((r) => r.name === 'helm-devtest');
  expect(devtest?.ok, `정상 확장 로드 실패: ${devtest?.error}`).toBe(true);
  expect(devtest?.manifestName).toBe('Helm 확장 로드 검증');
  expect(devtest?.version).toBe('1.0.0');
  expect(devtest?.unsupportedPermissions).toEqual([]);

  const unsupported = results.find((r) => r.name === 'helm-unsupported');
  expect(unsupported?.unsupportedPermissions).toEqual(['bookmarks', 'history', 'notifications']);

  const missing = results.find((r) => r.name === 'helm-missing');
  expect(missing?.ok).toBe(false);
  expect(missing?.error).toContain('manifest.json 없음');

  // 결과를 파일로 남겨 docs/extensions.md 작성 근거로 쓴다.
  fs.writeFileSync(
    path.join(ARTIFACTS, 'extensions.json'),
    `${JSON.stringify(results, null, 2)}\n`,
    'utf-8'
  );
  summary['extensions'] = results.map((r) => ({
    name: r.name,
    ok: r.ok,
    version: r.version,
    unsupportedPermissions: r.unsupportedPermissions,
    error: r.error
  }));
});

test('[M1] 전체 화면 스크린샷과 세션 쿠키 기록', async () => {
  // 사람이 보는 상태에 가깝게 정리한 뒤 캡처한다.
  const tabId = (await readState(app)).activeTabId as number;
  await navigateAndWait(app, tabId, HOME_URL);
  await shellEval(app, `(document.querySelector('button[aria-label="북마크 추가"]').click(), 'ok')`);
  await expect
    .poll(() => app.evaluate(() => globalThis.__helm?.getBookmarks()?.count() ?? -1))
    .toBe(1);

  const shellShot = await capture(app, 'shell', 'shell.png');
  expect(shellShot.width).toBeGreaterThan(600);
  expect(shellShot.height).toBeGreaterThan(400);
  expect(shellShot.bytes).toBeGreaterThan(5_000);

  const homeShot = await capture(app, { tabId }, 'home-tab.png');
  expect(homeShot.bytes).toBeGreaterThan(3_000);

  // persist:helm 파티션에 쿠키를 심고 디스크로 flush
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

  summary['screenshots'] = { 'shell.png': shellShot, 'home-tab.png': homeShot };

  await app.close();
});

test('[M0] 재시작 후에도 persist:helm 세션과 북마크가 유지된다', async () => {
  const second = await launchApp();

  try {
    await waitForWindow(second);

    const cookies = await second.evaluate(
      ({ session }, input) =>
        session.fromPartition(input.partition).cookies.get({ url: input.url, name: input.name }),
      { partition: 'persist:helm', url: COOKIE.url, name: COOKIE.name }
    );

    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.value).toBe(COOKIE.value);

    // M1: 북마크·방문 기록은 SQLite 에 있으므로 재시작 후에도 남아 있어야 한다.
    const stored = await second.evaluate(() => ({
      bookmarks: globalThis.__helm?.getBookmarks()?.count() ?? -1,
      history: globalThis.__helm?.getHistory()?.count() ?? -1
    }));
    expect(stored.bookmarks).toBe(1);
    expect(stored.history).toBeGreaterThan(0);

    summary['persistence'] = {
      partition: 'persist:helm',
      cookie: COOKIE.name,
      valueAfterRestart: cookies[0]?.value ?? null,
      bookmarksAfterRestart: stored.bookmarks,
      historyAfterRestart: stored.history
    };
  } finally {
    await second.close();
  }
});

test('[M1] 프로필 가져오기 — 앱을 통해 fixture 프로필을 가져온다', async () => {
  // 다른 테스트의 북마크·기록과 섞이지 않도록 별도 프로필로 띄운다.
  const importProfileDir = path.join(ROOT, '.smoke-profile-import');
  fs.rmSync(importProfileDir, { recursive: true, force: true });

  const third = await launchApp({
    HELM_USER_DATA_DIR: importProfileDir,
    // discoverProfiles 가 볼 %LOCALAPPDATA% 를 fixture 로 바꿔 끼운다.
    HELM_PROFILE_ROOT: path.join(ROOT, 'fixtures', 'profiles', 'localappdata')
  });

  try {
    await waitForWindow(third);

    const discovered = await third.evaluate(async () => {
      const shell = globalThis.__helm?.getShell();
      if (!shell) throw new Error('[smoke] 셸 뷰 없음');
      return (await shell.webContents.executeJavaScript(
        'window.helm.discoverProfiles().then((p) => JSON.stringify(p))'
      )) as string;
    });

    const profiles = JSON.parse(discovered) as { browser: string; name: string; dir: string }[];
    expect(profiles.map((p) => `${p.browser}/${p.name}`).sort()).toEqual([
      'chrome/Default',
      'edge/Default'
    ]);

    const chrome = profiles.find((p) => p.browser === 'chrome');
    expect(chrome).toBeDefined();

    const resultRaw = await third.evaluate(async (_e, dir) => {
      const shell = globalThis.__helm?.getShell();
      if (!shell) throw new Error('[smoke] 셸 뷰 없음');
      return (await shell.webContents.executeJavaScript(
        `window.helm.runImport(${JSON.stringify(dir)}).then((r) => JSON.stringify(r))`
      )) as string;
    }, chrome?.dir ?? '');

    const result = JSON.parse(resultRaw) as {
      sourceProfile: string;
      bookmarks: number;
      history: number;
      autofill: number;
      skippedCredentialFiles: string[];
      errors: string[];
    };

    const expectedCounts = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'fixtures', 'profiles', 'expected.json'), 'utf-8')
    ) as Record<string, { bookmarks: number; visits: number; autofill: number; decoys: number }>;

    expect(result.errors).toEqual([]);
    expect(result.bookmarks).toBe(expectedCounts['chrome']?.bookmarks);
    expect(result.history).toBe(expectedCounts['chrome']?.visits);
    expect(result.autofill).toBe(expectedCounts['chrome']?.autofill);
    expect(result.skippedCredentialFiles.length).toBe(expectedCounts['chrome']?.decoys);

    // 실제로 저장되었는지 저장소에서 다시 센다.
    const stored = await third.evaluate(() => ({
      bookmarks: globalThis.__helm?.getBookmarks()?.count() ?? -1,
      history: globalThis.__helm?.getHistory()?.count() ?? -1
    }));
    // 시작 탭이 남긴 방문 1건이 더해진다.
    expect(stored.bookmarks).toBe(expectedCounts['chrome']?.bookmarks);
    expect(stored.history).toBeGreaterThanOrEqual(expectedCounts['chrome']?.visits ?? 0);

    // 가져오기 UI 가 결과를 보여주는지도 확인한다.
    await third.evaluate(() => globalThis.__helm?.setPanel('bookmarks'));
    await expect
      .poll(
        async () => {
          const shell = await third.evaluate(async () => {
            const view = globalThis.__helm?.getShell();
            if (!view) throw new Error('[smoke] 셸 뷰 없음');
            return (await view.webContents.executeJavaScript(
              `JSON.stringify({
                 panel: !!document.querySelector('[data-import-panel]'),
                 profiles: document.querySelectorAll('[data-import-profile]').length
               })`
            )) as string;
          });
          return shell;
        },
        { message: '가져오기 UI 가 프로필 목록을 보여주기를 대기' }
      )
      .toBe(JSON.stringify({ panel: true, profiles: 2 }));

    summary['profileImport'] = {
      discovered: profiles.map((p) => `${p.browser}/${p.name}`),
      imported: {
        bookmarks: result.bookmarks,
        history: result.history,
        autofill: result.autofill
      },
      skippedFiles: result.skippedCredentialFiles
    };
  } finally {
    await third.close();
    fs.rmSync(importProfileDir, { recursive: true, force: true });
  }
});
