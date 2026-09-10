import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 되돌리기 테스트 (`npm run test:undo`, GOAL-M3 성공 조건 5).
 *
 *   1. type 3회 → undo 2회 → 필드 값이 1회차 상태
 *   2. tabs_close → undo → 탭 복구
 *   3. download → undo → 파일 없음 · 기록 없음
 *   4. 제출(상신) 후 undo → `sealed` 로 거부
 *
 * 사람 UI(UndoPanel)와 AI 의 `undo` 도구가 같은 스택을 보므로, 여기서는 사람 경로
 * (`UndoManager` 훅)와 AI 경로(`undo` 도구)를 모두 지난다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm3');
const PROFILE = path.join(ROOT, '.undo-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.undo-downloads');

const THREAD = 'test-undo';

let app: ElectronApplication;

const summary: Record<string, unknown> = {};

interface UndoRecordLike {
  id: string;
  tool: string;
  describe: string;
  undone: boolean;
  sealed: boolean;
  sealedReason: string | null;
}

/** 도구 호출. 메인에서 실행되고 결과는 JSON 으로 건너온다. */
async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const raw = await app.evaluate(
    async (_electronApi, input) => {
      const hook = globalThis.__helm;
      if (!hook) throw new Error('[undo-tests] __helm 훅 없음');
      const result = await hook.callTool(input.thread, input.name, input.args);
      return JSON.stringify(result ?? null);
    },
    { thread: THREAD, name, args }
  );
  return JSON.parse(raw) as T;
}

function undoList(): Promise<UndoRecordLike[]> {
  return app.evaluate(
    (_electronApi, thread) => globalThis.__helm?.getUndo()?.list(thread) ?? [],
    THREAD
  );
}

/** 사람 경로 — UndoPanel 과 같은 API. */
function applyUndo(
  id?: string
): Promise<{ ok: boolean; reason?: string; message?: string; record?: UndoRecordLike }> {
  return app.evaluate(
    async (_electronApi, input) => {
      const manager = globalThis.__helm?.getUndo();
      if (!manager) return { ok: false, reason: 'failed', message: '훅 없음' };
      return manager.undo(input.thread, input.id) as Promise<{
        ok: boolean;
        reason?: string;
        message?: string;
      }>;
    },
    { thread: THREAD, id }
  );
}

/** 페이지의 폼 값을 직접 읽는다 — 도구를 거치지 않아야 "정말 복원됐나" 를 볼 수 있다. */
function fieldValue(tabId: number, selector: string): Promise<string> {
  return app.evaluate(
    async (_electronApi, input) => {
      const wc = globalThis.__helm?.getTabManager()?.getWebContents(input.tabId);
      if (!wc) return '';
      return (await wc.executeJavaScript(
        `String(document.querySelector(${JSON.stringify(input.selector)})?.value ?? '')`
      )) as string;
    },
    { tabId, selector }
  );
}

/** 승인 요청에 답한다(테스트가 사람 역할). */
function answerApproval(action: string, scope: 'once' | 'thread' | 'domain' | null): Promise<boolean> {
  return app.evaluate(
    async (_electronApi, input) => {
      const hook = globalThis.__helm;
      if (!hook) return false;

      for (let attempt = 0; attempt < 300; attempt += 1) {
        const found = hook.approvalQueue().find((item) => item.action === input.action);
        if (found) return hook.answerApproval(found.id, input.scope);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    },
    { action, scope }
  );
}

async function openTab(url: string): Promise<number> {
  const started = await callTool<{ tabId: number }>('preview_start', { url });
  await expect
    .poll(
      async () => {
        const page = await callTool<{ text?: string }>('get_page_text', { tabId: started.tabId });
        return (page.text ?? '').length > 0;
      },
      { message: `${url} 로드 대기`, timeout: 15_000 }
    )
    .toBe(true);
  return started.tabId;
}

async function refOf(tabId: number, name: string, role: string): Promise<string> {
  const found = await callTool<{ matches: { ref: string; name: string }[] }>('find', {
    tabId,
    query: name,
    role
  });
  const match = found.matches[0];
  expect(match, `${name}(${role}) 을 찾지 못했습니다`).toBeDefined();
  return match?.ref ?? '';
}

// ─────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  // 여기서 보려는 것은 되돌리기다. 사이트 접근·다운로드는 미리 허용해 두고,
  // 쓰기 클릭(상신)만 승인 흐름을 지난다.
  fs.writeFileSync(
    path.join(PROFILE, 'policy.json'),
    `${JSON.stringify(
      {
        locked: false,
        sites: { default: 'allow', hosts: {} },
        deny: { hosts: [], tools: [] },
        tools: {},
        grants: [{ subject: 'download', host: 'portal-c', scope: 'domain', grantedAt: 0 }],
        retentionDays: 30
      },
      null,
      2
    )}\n`,
    'utf-8'
  );

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
});

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'undo-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
  await app?.close();
});

// ─────────────────────────────────────────────────────────────

test('[되돌리기] type 3회 후 undo 2회면 1회차 상태로 돌아간다', async () => {
  const tabId = await openTab('app://portal-f/draft');
  const ref = await refOf(tabId, '제목', 'textbox');

  const values: string[] = [];

  // 입력은 이어 붙는다: A → AB → ABC. 각 단계의 "이전 값" 이 역연산의 근거다.
  for (const chunk of ['1월', '정산', '재요청']) {
    await callTool('computer', { tabId, action: 'type', ref, text: chunk });
    values.push(await fieldValue(tabId, '#draft-title'));
  }

  expect(values).toEqual(['1월', '1월정산', '1월정산재요청']);

  const stack = await undoList();
  const typeEntries = stack.filter((entry) => entry.tool === 'computer' && !entry.undone);
  expect(typeEntries.length, '입력 3회가 스택에 쌓이지 않았습니다').toBe(3);

  const first = await applyUndo();
  expect(first.ok, `1차 되돌리기 실패: ${first.message}`).toBe(true);
  expect(await fieldValue(tabId, '#draft-title')).toBe('1월정산');

  const second = await applyUndo();
  expect(second.ok, `2차 되돌리기 실패: ${second.message}`).toBe(true);

  const after = await fieldValue(tabId, '#draft-title');
  expect(after, '1회차 상태로 돌아오지 않았습니다').toBe('1월');

  summary['typeUndo'] = { values, afterTwoUndos: after, stack: typeEntries.length };
});

test('[되돌리기] tabs_close 를 되돌리면 탭이 복구된다', async () => {
  const created = await callTool<{ tabId: number }>('tabs_create', {
    url: 'app://portal-a/list?page=1'
  });

  const closed = await callTool<{ closed: boolean }>('tabs_close', { tabId: created.tabId });
  expect(closed.closed).toBe(true);

  const gone = await app.evaluate(
    (_electronApi, id) =>
      (globalThis.__helm?.getTabManager()?.getState().tabs ?? []).some((tab) => tab.id === id),
    created.tabId
  );
  expect(gone, '탭이 닫히지 않았습니다').toBe(false);

  const before = await app.evaluate(
    () => globalThis.__helm?.getTabManager()?.getState().tabs.length ?? 0
  );

  // AI 경로 — `undo` 도구도 같은 스택을 본다. irreversible 도구라 승인을 받는다.
  const approving = answerApproval('tool', 'once');
  const outcome = await callTool<{ ok: boolean; record: UndoRecordLike | null }>('undo', {});
  expect(await approving, 'undo 도구가 승인을 요구하지 않았습니다').toBe(true);

  expect(outcome.ok, '되돌리기가 실패했습니다').toBe(true);
  expect(outcome.record?.tool).toBe('tabs_close');

  await expect
    .poll(
      () => app.evaluate(() => globalThis.__helm?.getTabManager()?.getState().tabs.length ?? 0),
      { message: '탭 복구 대기', timeout: 10_000 }
    )
    .toBe(before + 1);

  const restored = await app.evaluate(() => {
    const tabs = globalThis.__helm?.getTabManager()?.getState().tabs ?? [];
    const last = tabs[tabs.length - 1];
    return last ? { url: last.url, owner: last.owner } : null;
  });

  expect(restored?.url, '복구된 탭의 주소가 다릅니다').toContain('portal-a');
  // 소유권까지 되살아나야 AI 가 그 탭을 계속 다룰 수 있다.
  expect(restored?.owner, '복구된 탭의 소유권이 사람으로 바뀌었습니다').toBe('ai');

  summary['tabsCloseUndo'] = {
    closedTabId: created.tabId,
    restoredUrl: restored?.url,
    restoredOwner: restored?.owner
  };
});

test('[되돌리기] download 를 되돌리면 파일과 기록이 사라진다', async () => {
  const tabId = await openTab('app://portal-c/');

  const downloaded = await callTool<{ savePath: string; fileName: string; state: string }>(
    'download',
    { tabId, url: 'app://portal-c/attachment?id=1' }
  );

  expect(downloaded.state).toBe('completed');
  expect(fs.existsSync(downloaded.savePath), '내려받은 파일이 없습니다').toBe(true);

  const listedBefore = await app.evaluate(
    (_electronApi, savePath) =>
      (globalThis.__helm?.getDownloads()?.list() ?? []).some((item) => item.savePath === savePath),
    downloaded.savePath
  );
  expect(listedBefore, '다운로드 기록이 없습니다').toBe(true);

  const outcome = await applyUndo();
  expect(outcome.ok, `되돌리기 실패: ${outcome.message}`).toBe(true);

  expect(fs.existsSync(downloaded.savePath), '파일이 남아 있습니다').toBe(false);

  const listedAfter = await app.evaluate(
    (_electronApi, savePath) =>
      (globalThis.__helm?.getDownloads()?.list() ?? []).some((item) => item.savePath === savePath),
    downloaded.savePath
  );
  expect(listedAfter, '다운로드 기록이 남아 있습니다').toBe(false);

  summary['downloadUndo'] = {
    fileName: downloaded.fileName,
    savePath: downloaded.savePath,
    fileGone: !fs.existsSync(downloaded.savePath),
    recordGone: !listedAfter
  };
});

test('[되돌리기] 상신 후에는 봉인되어 되돌릴 수 없다', async () => {
  const tabId = await openTab('app://portal-f/draft');
  const titleRef = await refOf(tabId, '제목', 'textbox');

  // preview_start 는 같은 주소의 탭을 재사용하므로 앞 테스트의 값이 남아 있을 수 있다.
  // 입력은 이어 붙는 동작이라 "이전 값 + 새 값" 을 기준으로 본다.
  const beforeTyping = await fieldValue(tabId, '#draft-title');
  await callTool('computer', { tabId, action: 'type', ref: titleRef, text: '클라우드 사용료 정산 2월' });
  expect(await fieldValue(tabId, '#draft-title')).toBe(`${beforeTyping}클라우드 사용료 정산 2월`);

  const beforeSeal = await undoList();
  const undoableBefore = beforeSeal.filter((entry) => !entry.undone && !entry.sealed).length;
  expect(undoableBefore, '봉인 전에 되돌릴 항목이 있어야 한다').toBeGreaterThan(0);

  // 상신 클릭 — 이번에는 사람이 승인한다. 승인되면 그 이전 입력은 봉인된다.
  const submitRef = await refOf(tabId, '상신', 'button');
  const approving = answerApproval('write_click', 'once');
  const clicked = await callTool<{ ok?: boolean }>('computer', {
    tabId,
    action: 'left_click',
    ref: submitRef
  });

  expect(await approving, '상신이 승인을 요구하지 않았습니다').toBe(true);
  expect(clicked.ok, '클릭이 수행되지 않았습니다').toBe(true);

  const afterSeal = await undoList();
  const sealed = afterSeal.filter((entry) => entry.sealed);
  expect(sealed.length, '봉인된 항목이 없습니다').toBeGreaterThan(0);
  expect(sealed[0]?.sealedReason).toContain('되돌릴 수 없습니다');

  // 사람 경로: 봉인 항목을 지목해 되돌리려 하면 사유와 함께 거부된다.
  const refused = await applyUndo(sealed[0]?.id);
  expect(refused.ok).toBe(false);
  expect(refused.reason).toBe('sealed');
  expect(refused.message).toContain('되돌릴 수 없습니다');

  // 값도 그대로 남아 있어야 한다 — 거부는 아무것도 바꾸지 않는다.
  const stillThere = await undoList();
  expect(stillThere.find((entry) => entry.id === sealed[0]?.id)?.undone).toBe(false);

  // AI 경로도 같은 답을 받는다.
  const approvingAi = answerApproval('tool', 'once');
  const aiOutcome = await callTool<{ ok: boolean; reason: string | null; message: string | null }>(
    'undo',
    { id: sealed[0]?.id ?? '' }
  );
  expect(await approvingAi).toBe(true);
  expect(aiOutcome.ok).toBe(false);
  expect(aiOutcome.reason).toBe('sealed');

  summary['sealed'] = {
    undoableBeforeSeal: undoableBefore,
    sealedCount: sealed.length,
    sealedReason: sealed[0]?.sealedReason,
    humanRefusal: refused.reason,
    aiRefusal: aiOutcome.reason
  };
});
