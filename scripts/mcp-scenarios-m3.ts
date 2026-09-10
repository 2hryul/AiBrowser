import fs from 'node:fs';
import path from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findPii } from '../src/main/control/Masking';

/**
 * M3 시나리오 재생 (`npm run test:scenarios`).
 *
 * 시나리오 D — 인사 포털: 승인을 받아야 접근하고, 산출물·로그·스크린샷 어디에도 개인정보가 없다.
 * 시나리오 F — 전자결재: 초안은 채우지만 "상신" 은 AI 가 누를 수 없다.
 * 그리고 그 기록을 StepLogPlayer 로 재생할 수 있다(성공 조건 7).
 *
 * M2 시나리오(A·B·C)와 프로필을 분리한다 — 이쪽 정책은 `sites.default: "ask"` 라서
 * 승인 흐름 자체가 검증 대상이다.
 */

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'm3');
const PROFILE = path.join(ROOT, '.m3-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.m3-downloads');

const PORT = 3198;
const TOKEN = 'helm-dev-token-m3';

/** 마스킹 색 (computer.ts maskBitmap 과 같은 값) */
const MASK_RGB = 40;

let app: ElectronApplication;
let client: Client;

/** 실측값. artifacts/m3/REPORT.md 의 근거로 남긴다. */
const summary: Record<string, unknown> = {};

// ─────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────

interface BlockedLike {
  blocked_by_policy?: true;
  reason?: string;
  by?: 'policy' | 'user';
}

/** 마지막 호출 — 실패 메시지에 "어디서 멈췄나" 를 실어 보내기 위한 기록. */
let lastCall = '(없음)';

async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  lastCall = `${name} ${JSON.stringify(args).slice(0, 160)}`;

  const result = await client
    .callTool({ name, arguments: args })
    .catch((error: Error) => {
      throw new Error(`[mcp] ${lastCall} 호출 실패: ${error.message}`);
    });
  const content = result.content as { type: string; text?: string }[] | undefined;
  const text = content?.[0]?.text ?? '{}';

  if (result.isError) {
    throw new Error(`[mcp] ${name} 실패: ${text}`);
  }
  return JSON.parse(text) as T;
}

function isBlocked(value: unknown): value is Required<BlockedLike> {
  return typeof value === 'object' && value !== null && 'blocked_by_policy' in value;
}

interface ApprovalMatch {
  tool?: string;
  host?: string;
  action?: string;
}

/**
 * 승인 요청이 올라오기를 기다려 답한다 — 테스트가 "사람" 역할을 한다.
 * scope 가 null 이면 거부. 도구 호출은 이 답이 오기 전까지 대기 상태로 멈춘다.
 */
function answerApproval(
  match: ApprovalMatch,
  scope: 'once' | 'thread' | 'domain' | null
): Promise<{ tool: string; host: string; action: string; reason: string; irreversible: boolean } | null> {
  return app.evaluate(
    async (_electronApi, input) => {
      const hook = globalThis.__helm;
      if (!hook) return null;

      for (let attempt = 0; attempt < 300; attempt += 1) {
        const found = hook.approvalQueue().find((item) => {
          if (input.match.tool && item.tool !== input.match.tool) return false;
          if (input.match.host && item.host !== input.match.host) return false;
          if (input.match.action && item.action !== input.match.action) return false;
          return true;
        });

        if (found) {
          hook.answerApproval(found.id, input.scope);
          return {
            tool: found.tool,
            host: found.host,
            action: found.action,
            reason: found.reason,
            irreversible: found.irreversible
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    },
    { match, scope }
  );
}

/** 승인 큐에 요청이 올라오기를 기다린다(답하지 않는다). 다이얼로그 검증용. */
function waitForApproval(match: ApprovalMatch): Promise<string | null> {
  return app.evaluate(
    async (_electronApi, input) => {
      const hook = globalThis.__helm;
      if (!hook) return null;

      for (let attempt = 0; attempt < 300; attempt += 1) {
        const found = hook.approvalQueue().find((item) => {
          if (input.tool && item.tool !== input.tool) return false;
          if (input.action && item.action !== input.action) return false;
          return true;
        });
        if (found) return found.id;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    },
    match
  );
}

function auditEntries(): Promise<
  {
    tool: string;
    url: string | null;
    policyDecision: string;
    grantScope: string | null;
    screenshotPath: string | null;
    review: boolean;
    error: string | null;
    result: unknown;
  }[]
> {
  return app.evaluate(() => globalThis.__helm?.getAudit()?.read() ?? []);
}

function auditFile(): Promise<string> {
  return app.evaluate(() => globalThis.__helm?.getAudit()?.file ?? '');
}

/** 셸(브라우저 크롬) 안에서 표현식을 평가한다. 반환값은 JSON 문자열이어야 한다. */
function shellEval(expression: string): Promise<string> {
  return app.evaluate(async (_electronApi, expr) => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) throw new Error('[m3] 셸 뷰 없음');
    return (await shell.webContents.executeJavaScript(expr)) as string;
  }, expression);
}

/** 셸 자체를 캡처한다 — 탭 뷰가 위에 있어도 승인 다이얼로그를 그림으로 남길 수 있다. */
async function captureShell(fileName: string): Promise<string> {
  const base64 = await app.evaluate(async () => {
    const shell = globalThis.__helm?.getShell();
    if (!shell) return '';
    const image = await shell.webContents.capturePage();
    return image.toPNG().toString('base64');
  });

  const target = path.join(ARTIFACTS, fileName);
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  return fileName;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 탭 페이지에서 선택자에 걸리는 요소들의 **텍스트 사각형**을 읽는다.
 * 셀 전체가 아니라 글자가 차지한 영역이어야 마스킹 덮개와 같은 기준으로 비교할 수 있다.
 */
function textRects(tabId: number, selector: string): Promise<Rect[]> {
  return app.evaluate(
    async (_electronApi, input) => {
      const wc = globalThis.__helm?.getTabManager()?.getWebContents(input.tabId);
      if (!wc) return [];

      const script = `(() => {
        const out = [];
        for (const el of document.querySelectorAll(${JSON.stringify(input.selector)})) {
          const range = document.createRange();
          range.selectNodeContents(el);
          for (const r of range.getClientRects()) {
            if (r.width > 0 && r.height > 0) out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          }
          range.detach();
        }
        return out;
      })()`;

      return (await wc.executeJavaScript(script)) as Rect[];
    },
    { tabId, selector }
  );
}

function viewportWidth(tabId: number): Promise<number> {
  return app.evaluate(async (_electronApi, id) => {
    const wc = globalThis.__helm?.getTabManager()?.getWebContents(id);
    if (!wc) return 0;
    return (await wc.executeJavaScript('window.innerWidth')) as number;
  }, tabId);
}

/** 각 사각형이 마스킹 색으로 덮인 비율. 1 에 가까울수록 완전히 가려졌다. */
function maskCoverage(
  base64: string,
  cssViewportWidth: number,
  rects: Rect[]
): Promise<{ ratio: number; pixels: number }[]> {
  return app.evaluate(
    ({ nativeImage }, input) => {
      const image = nativeImage.createFromBuffer(Buffer.from(input.base64, 'base64'));
      const size = image.getSize();
      const bitmap = image.toBitmap();
      const scale = size.width / Math.max(1, input.cssViewportWidth);

      return input.rects.map((rect) => {
        // 경계 1px 은 안티에일리어싱이 섞이므로 안쪽만 본다.
        const x0 = Math.max(0, Math.round(rect.x * scale) + 1);
        const y0 = Math.max(0, Math.round(rect.y * scale) + 1);
        const x1 = Math.min(size.width, Math.round((rect.x + rect.width) * scale) - 1);
        const y1 = Math.min(size.height, Math.round((rect.y + rect.height) * scale) - 1);

        let total = 0;
        let covered = 0;

        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const offset = (y * size.width + x) * 4;
            total += 1;
            if (
              bitmap[offset] === input.maskRgb &&
              bitmap[offset + 1] === input.maskRgb &&
              bitmap[offset + 2] === input.maskRgb
            ) {
              covered += 1;
            }
          }
        }

        return { ratio: total === 0 ? 0 : covered / total, pixels: total };
      });
    },
    { base64, cssViewportWidth, rects, maskRgb: MASK_RGB }
  );
}

/** 페이지 본문이 기대 문구를 담을 때까지 기다린다. */
async function waitForText(tabId: number, needle: string): Promise<string> {
  let last = '';
  let raw = '';

  await expect
    .poll(
      async () => {
        const page = await callTool<{ text?: string }>('get_page_text', { tabId });
        // text 가 없으면 정책 차단·오류다. 무엇이 왔는지 실패 메시지에 실어 보낸다.
        raw = JSON.stringify(page).slice(0, 400);
        last = page.text ?? '';
        return last.includes(needle);
      },
      { message: `"${needle}" 대기`, timeout: 15_000 }
    )
    .toBe(true)
    .catch((error: Error) => {
      throw new Error(`"${needle}" 를 찾지 못했습니다. 마지막 응답: ${raw}
${error.message}`);
    });

  return last;
}

// ─────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  // 승인 흐름이 검증 대상이므로 아무것도 미리 허용하지 않는다.
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(
    path.join(PROFILE, 'policy.json'),
    `${JSON.stringify(
      {
        locked: false,
        sites: { default: 'ask', hosts: {} },
        deny: { hosts: [], tools: [] },
        tools: { javascript: 'ask' },
        grants: [],
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
  client = new Client({ name: 'helm-m3-scenario-runner', version: '1.0.0' });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
});

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(ARTIFACTS, 'scenario-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf-8'
  );
  await client?.close().catch(() => undefined);
  await app?.close();
});

// ─────────────────────────────────────────────────────────────
// 시나리오 D
// ─────────────────────────────────────────────────────────────

test('[시나리오 D-거부] 승인을 거부하면 즉시 종료하고 아무것도 수집하지 않는다', async () => {
  const collected: string[] = [];

  // 사람이 거부한다.
  const asked = answerApproval({ action: 'site_first_visit', host: 'portal-d' }, null);

  const started = await callTool<{ tabId?: number } & BlockedLike>('preview_start', {
    url: 'app://portal-d/'
  });

  const request = await asked;
  expect(request, '사이트 첫 접근 승인을 묻지 않았습니다').not.toBeNull();
  expect(request?.action).toBe('site_first_visit');

  // 막혔으면 스크립트는 여기서 끝난다 — 뒤 단계를 시도하지 않는다.
  expect(isBlocked(started), `막히지 않았습니다: ${JSON.stringify(started)}`).toBe(true);
  if (isBlocked(started)) {
    expect(started.by).toBe('user');
  }

  expect(collected).toHaveLength(0);
  expect(
    (started as { tabId?: number }).tabId,
    '거부됐는데 탭이 열렸습니다'
  ).toBeUndefined();

  summary['scenarioD_denied'] = {
    blocked: isBlocked(started),
    by: (started as BlockedLike).by,
    reason: (started as BlockedLike).reason,
    collected: collected.length
  };
});

test('[시나리오 D] 승인 1건으로 팀 5개를 순회하고 개인정보는 남기지 않는다', async () => {
  // 1) AI 가 접근 허락을 구한다 → 사람이 "이번 한 번" 을 고른다.
  const asked = answerApproval({ tool: 'request_access' }, 'once');
  const access = await callTool<{ granted: boolean; scope: string | null }>('request_access', {
    host: 'portal-d',
    reason: '팀별 구성원 수를 세기 위해 조직도를 읽습니다'
  });

  expect(await asked, '승인 요청이 오지 않았습니다').not.toBeNull();
  expect(access.granted).toBe(true);
  expect(access.scope).toBe('once');

  // 2) 이제 포털 D 로 들어간다 — 다시 묻지 않아야 한다.
  const started = await callTool<{ tabId: number } & BlockedLike>('preview_start', {
    url: 'app://portal-d/'
  });
  expect(isBlocked(started), '승인 후에도 막혔습니다').toBe(false);
  const tabId = started.tabId;

  const teams = await app.evaluate(() => globalThis.__helm?.portalTeams() ?? []);
  expect(teams.length).toBe(5);

  // 3) 팀 5개 순회 — 조직도 → 팀 클릭 → 구성원 표 읽기 → 화면 캡처
  const table: { team: string; members: number; rows: string[] }[] = [];
  const shots: { team: string; file: string; maskedRegions: number; minCoverage: number }[] = [];

  for (const team of teams) {
    await callTool('navigate', { tabId, url: 'app://portal-d/' });
    await waitForText(tabId, '조직도에서');

    const found = await callTool<{ matches: { ref: string; name: string }[] }>('find', {
      tabId,
      query: team,
      role: 'link'
    });
    const link = found.matches[0];
    expect(link, `${team} 링크를 찾지 못했습니다`).toBeDefined();

    await callTool('computer', { tabId, action: 'left_click', ref: link?.ref });
    // 구성원 페이지는 "구성원 4명" 을 담는다(조직도 화면에는 없는 문구다).
    const text = await waitForText(tabId, '구성원 4명');
    expect(text, `${team} 페이지로 이동하지 않았습니다`).toContain(team);

    const countMatch = /구성원 (\d+)명/.exec(text);
    const members = Number(countMatch?.[1] ?? 0);
    expect(members).toBe(4);

    // 표의 행을 그대로 산출물에 담는다. 마스킹이 도구 결과 단계에서 이미 적용돼 있어야 한다.
    const rows = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\*{2,}/.test(line));

    table.push({ team, members, rows });

    // 4) 스크린샷 — 개인정보 칸이 실제 픽셀로 덮였는지 본다.
    const shot = await callTool<{ image: string; maskedRegions: number }>('computer', {
      tabId,
      action: 'screenshot'
    });

    const rects = await textRects(tabId, '.member-no, .member-phone, .member-email');
    expect(rects.length, `${team} 개인정보 칸을 찾지 못했습니다`).toBe(members * 3);

    const coverage = await maskCoverage(shot.image, await viewportWidth(tabId), rects);
    const minCoverage = Math.min(...coverage.map((item) => item.ratio));

    expect(
      minCoverage,
      `${team}: 개인정보 칸이 완전히 가려지지 않았습니다 (${JSON.stringify(coverage)})`
    ).toBeGreaterThan(0.9);

    const file = `scenario-d-${teams.indexOf(team)}.png`;
    fs.writeFileSync(path.join(ARTIFACTS, file), Buffer.from(shot.image, 'base64'));
    shots.push({ team, file, maskedRegions: shot.maskedRegions, minCoverage });
  }

  // 5) 산출물에 개인정보 0건
  const outputPath = path.join(ARTIFACTS, 'scenario-d-table.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(table, null, 2)}\n`, 'utf-8');

  const inOutput = findPii(JSON.stringify(table));
  expect(inOutput, `산출물에 개인정보가 남았습니다: ${JSON.stringify(inOutput)}`).toEqual([]);

  // 미끼가 실제로 있었는지 확인한다 — 원본에 없었다면 이 검증은 아무것도 증명하지 않는다.
  const samples = await app.evaluate(() => globalThis.__helm?.piiSamples() ?? []);
  expect(samples.length).toBe(20);
  expect(findPii(JSON.stringify(samples)).length).toBeGreaterThan(40);

  // 6) JSONL 로그에 개인정보 0건
  const file = await auditFile();
  const raw = fs.readFileSync(file, 'utf-8');
  const inLog = findPii(raw);
  expect(inLog, `감사 로그에 개인정보가 남았습니다: ${JSON.stringify(inLog.slice(0, 5))}`).toEqual(
    []
  );

  // 7) 승인 로그 1건 — 실제로 범위가 기록된 승인은 하나뿐이어야 한다.
  const entries = await auditEntries();
  const granted = entries.filter((entry) => entry.grantScope !== null);
  expect(granted.length, `승인 기록 ${granted.length}건`).toBe(1);
  expect(granted[0]?.tool).toBe('request_access');

  const reviewed = entries.filter((entry) => entry.review);
  expect(reviewed.length, '마스킹 REVIEW 플래그가 하나도 없습니다').toBeGreaterThan(0);

  summary['scenarioD'] = {
    teams: teams.length,
    membersPerTeam: 4,
    approvals: granted.length,
    approvalScope: granted[0]?.grantScope,
    piiInOutput: inOutput.length,
    piiInLog: inLog.length,
    piiInSamples: findPii(JSON.stringify(samples)).length,
    reviewFlagged: reviewed.length,
    auditFile: file,
    output: path.basename(outputPath),
    shots
  };
});

// ─────────────────────────────────────────────────────────────
// 시나리오 F
// ─────────────────────────────────────────────────────────────

test('[시나리오 F] 초안은 채우고 상신은 막는다 — 3회 반복 자동 상신 0회', async () => {
  await app.evaluate(() => globalThis.__helm?.resetSubmitted());

  // 0) 전자결재·청구 포털 접근 승인 (이 작업 동안)
  const askedF = answerApproval({ action: 'site_first_visit', host: 'portal-f' }, 'thread');
  const started = await callTool<{ tabId: number } & BlockedLike>('preview_start', {
    url: 'app://portal-f/search'
  });
  expect(await askedF).not.toBeNull();
  expect(isBlocked(started), '결재 포털 접근이 막혔습니다').toBe(false);
  const tabId = started.tabId;

  // 1) POST 폼 검색 — GET 으로는 결과가 나오지 않는 화면이다.
  const emptyText = await waitForText(tabId, '0건');
  expect(emptyText).toContain('0건');

  const queryField = await callTool<{ matches: { ref: string }[] }>('find', {
    tabId,
    query: '제목',
    role: 'textbox'
  });
  await callTool('computer', { tabId, action: 'type', ref: queryField.matches[0]?.ref, text: '정산' });
  await callTool('computer', { tabId, action: 'key', text: 'enter' });

  const listText = await waitForText(tabId, '3건');
  expect(listText).toContain('3건');

  // 2) 이전 문서 값 추출
  const docs = await app.evaluate(() => globalThis.__helm?.approvalDocs() ?? []);
  const target = docs[0];
  expect(target).toBeDefined();

  const docLink = await callTool<{ matches: { ref: string }[] }>('find', {
    tabId,
    query: target?.title ?? '',
    role: 'link'
  });
  await callTool('computer', { tabId, action: 'left_click', ref: docLink.matches[0]?.ref });
  const docText = await waitForText(tabId, target?.id ?? '');

  const amountMatch = /([\d,]{7,})/.exec(docText);
  const priorAmount = amountMatch?.[1] ?? '';
  expect(priorAmount, '이전 문서 금액을 뽑지 못했습니다').toBe(
    (target?.amount ?? 0).toLocaleString('ko-KR')
  );
  expect(docText).toContain('임시저장');

  // 3) 청구 포털을 다른 탭에서 열어 금액을 가져온다.
  const askedBilling = answerApproval({ action: 'site_first_visit', host: 'portal-billing' }, 'thread');
  const billing = await callTool<{ tabId: number } & BlockedLike>('preview_start', {
    url: 'app://portal-billing/'
  });
  expect(await askedBilling).not.toBeNull();
  expect(isBlocked(billing), '청구 포털 접근이 막혔습니다').toBe(false);

  const billingText = await waitForText(billing.tabId, '청구금액');
  const billedLine = billingText
    .split('\n')
    .find((line) => line.includes(target?.id ?? '__none__'));
  expect(billedLine, '청구 행을 찾지 못했습니다').toBeDefined();

  const billedAmount = /([\d,]{7,})/.exec(billedLine ?? '')?.[1] ?? '';
  expect(billedAmount).not.toBe('');

  // 4) 결재 작성 화면 — 필드를 채운다(여기까지는 승인 없이 된다).
  await callTool('navigate', { tabId, url: 'app://portal-f/draft' });
  await waitForText(tabId, '결재 작성');

  const fields = await callTool<{ nodes: { ref: string; role: string; name: string }[] }>(
    'read_page',
    { tabId, filter: 'interactive' }
  );

  const refOf = (name: string): string => {
    const node = fields.nodes.find((item) => item.name.includes(name));
    expect(node, `${name} 필드를 찾지 못했습니다`).toBeDefined();
    return node?.ref ?? '';
  };

  const titleInput = await callTool<{ applied: boolean; previousValue: string | null }>(
    'form_input',
    { tabId, ref: refOf('제목'), value: `${target?.title ?? ''} 재정산` }
  );
  expect(titleInput.applied).toBe(true);

  await callTool('form_input', { tabId, ref: refOf('공급사'), value: '공급사 1' });
  await callTool('form_input', { tabId, ref: refOf('금액'), value: billedAmount });

  // 5) 본문은 iframe 안의 contenteditable — read_page 가 평탄화한 ref 로 입력한다.
  const flattened = await callTool<{ frames: number; nodes: { ref: string; role: string }[] }>(
    'read_page',
    { tabId }
  );
  expect(flattened.frames, 'iframe 이 평탄화되지 않았습니다').toBeGreaterThan(1);

  const editable = flattened.nodes.find((node) => node.role === 'textbox' || node.role === 'generic');
  expect(editable, '본문 편집기를 찾지 못했습니다').toBeDefined();

  const bodyText = `이전 문서 ${target?.id ?? ''} 금액 ${priorAmount}, 청구액 ${billedAmount} 기준으로 재정산합니다.`;
  await callTool('computer', { tabId, action: 'type', ref: editable?.ref, text: bodyText });

  const draftShot = await callTool<{ image: string }>('computer', { tabId, action: 'screenshot' });
  fs.writeFileSync(
    path.join(ARTIFACTS, 'scenario-f-draft.png'),
    Buffer.from(draftShot.image, 'base64')
  );

  // 6) "상신" 3회 시도 — 매번 승인을 요구하고, 사람이 거부하면 막힌다.
  const attempts: { blocked: boolean; by: string; dialogAction: string | null }[] = [];

  for (let round = 0; round < 3; round += 1) {
    const submitRef = await callTool<{ matches: { ref: string; name: string }[] }>('find', {
      tabId,
      query: '상신',
      role: 'button'
    });
    expect(submitRef.matches[0], '상신 버튼을 찾지 못했습니다').toBeDefined();

    // 승인 다이얼로그가 실제로 셸에 떠 있는지 본다 — 답하기 전에 확인한다.
    const pendingId = waitForApproval({ action: 'write_click' });

    const clicking = callTool<BlockedLike>('computer', {
      tabId,
      action: 'left_click',
      ref: submitRef.matches[0]?.ref
    })
      .then((value) => ({ kind: 'done' as const, value: JSON.stringify(value) }))
      .catch((error: Error) => ({ kind: 'error' as const, value: error.message }));

    const requestId = await pendingId;
    if (requestId === null) {
      // 승인 없이 끝났다면 무엇이 왔는지 보여 준다 — 조용히 통과한 것이 가장 나쁘다.
      const settled = await Promise.race([
        clicking,
        new Promise<{ kind: 'pending'; value: string }>((resolve) =>
          setTimeout(() => resolve({ kind: 'pending', value: '(응답 없음)' }), 5000)
        )
      ]);
      throw new Error(
        `승인 요청이 올라오지 않았습니다. 클릭 대상=${JSON.stringify(submitRef.matches[0])} 결과=${settled.kind}:${settled.value}`
      );
    }

    const dialog = JSON.parse(
      await shellEval(`(() => {
        const el = document.querySelector('[data-approval-id]');
        if (!el) return JSON.stringify(null);
        return JSON.stringify({
          action: el.getAttribute('data-approval-action'),
          tool: el.querySelector('[data-approval-tool]')?.textContent,
          target: el.querySelector('[data-approval-target]')?.textContent,
          scopes: [...el.querySelectorAll('[data-approval-scope]')].map((b) => b.getAttribute('data-approval-scope')),
          hasDeny: Boolean(el.querySelector('[data-approval-deny]'))
        });
      })()`)
    ) as {
      action: string;
      tool: string;
      target: string;
      scopes: string[];
      hasDeny: boolean;
    } | null;

    expect(dialog, 'ApprovalDialog 가 셸에 보이지 않습니다').not.toBeNull();
    expect(dialog?.action).toBe('write_click');
    expect(dialog?.scopes).toEqual(['once', 'thread', 'domain']);
    expect(dialog?.hasDeny).toBe(true);
    expect(dialog?.target).toContain('상신');

    if (round === 0) {
      await captureShell('scenario-f-approval.png');
    }

    // 사람이 셸의 "거부" 버튼을 누른다 — 실제 UI 경로로 거부한다.
    await shellEval(
      `JSON.stringify(Boolean(document.querySelector('[data-approval-deny]')?.click() ?? true))`
    );

    const settled = await clicking;
    expect(settled.kind, `${round + 1}회차: 클릭이 오류로 끝났습니다 — ${settled.value}`).toBe(
      'done'
    );

    const outcome = JSON.parse(settled.value) as BlockedLike;
    expect(isBlocked(outcome), `${round + 1}회차: 상신이 막히지 않았습니다`).toBe(true);

    attempts.push({
      blocked: isBlocked(outcome),
      by: outcome.by ?? '',
      dialogAction: dialog?.action ?? null
    });
  }

  // 7) 자동 상신 0회 — 모의 포털의 상신 집합이 판정 근거다.
  const submitted = await app.evaluate(() => globalThis.__helm?.submittedDocs() ?? []);
  expect(submitted, `자동 상신 ${submitted.length}건`).toEqual([]);

  // 8) 문서 상태 미변경
  await callTool('navigate', { tabId, url: `app://portal-f/doc?id=${target?.id ?? ''}` });
  const afterText = await waitForText(tabId, target?.id ?? '');
  expect(afterText).toContain('임시저장');
  expect(afterText).not.toContain('상신되었습니다');

  // 9) 로그에 blocked_by_policy 가 남는다.
  const file = await auditFile();
  const raw = fs.readFileSync(file, 'utf-8');
  expect(raw).toContain('blocked_by_policy');

  const entries = await auditEntries();
  const blockedEntries = entries.filter(
    (entry) => JSON.stringify(entry.result ?? '').includes('blocked_by_policy')
  );
  expect(blockedEntries.length, '차단 기록이 부족합니다').toBeGreaterThanOrEqual(3);

  summary['scenarioF'] = {
    priorAmount,
    billedAmount,
    draftTitleApplied: titleInput.applied,
    frames: flattened.frames,
    attempts,
    submittedDocs: submitted.length,
    statusAfter: '임시저장',
    blockedEntries: blockedEntries.length,
    shots: ['scenario-f-draft.png', 'scenario-f-approval.png']
  };
});

// ─────────────────────────────────────────────────────────────
// 성공 조건 7 — StepLogPlayer
// ─────────────────────────────────────────────────────────────

test('[StepLogPlayer] 시나리오 로그를 단계별로 재생하고 URL 을 새 탭으로 연다', async () => {
  const entries = await auditEntries();
  const withShot = entries.filter((entry) => entry.screenshotPath !== null);
  expect(withShot.length, '스크린샷이 남은 단계가 없습니다').toBeGreaterThan(0);

  // 파일이 실제로 있어야 한다 — 경로만 적혀 있고 파일이 없으면 재생이 깨진다.
  for (const entry of withShot) {
    expect(fs.existsSync(entry.screenshotPath ?? ''), `없는 파일: ${entry.screenshotPath}`).toBe(
      true
    );
  }

  await app.evaluate(() => globalThis.__helm?.setPanel('audit'));

  // 패널이 뜨면 컴포넌트가 로그를 읽어 온다.
  await expect
    .poll(
      async () =>
        JSON.parse(
          await shellEval(
            `JSON.stringify(Number(document.querySelector('[data-audit-count]')?.getAttribute('data-audit-count') ?? 0))`
          )
        ) as number,
      { message: '단계 목록 대기', timeout: 15_000 }
    )
    .toBe(entries.length);

  // 스크린샷이 있는 단계를 골라 상세를 확인한다.
  const stepIndex = entries.findIndex((entry) => entry.screenshotPath !== null && entry.url);
  expect(stepIndex).toBeGreaterThanOrEqual(0);

  await shellEval(
    `JSON.stringify(Boolean(document.querySelector('[data-audit-step="${stepIndex}"]')?.click() ?? true))`
  );

  const detail = JSON.parse(
    await shellEval(`(() => {
      const img = document.querySelector('[data-audit-screenshot]');
      const url = document.querySelector('[data-audit-url]');
      return JSON.stringify({
        src: img ? img.getAttribute('src') : null,
        url: url ? url.textContent : null,
        hasOpenButton: Boolean(document.querySelector('[data-audit-open-url]'))
      });
    })()`)
  ) as { src: string | null; url: string | null; hasOpenButton: boolean };

  expect(detail.src, '단계 스크린샷이 표시되지 않았습니다').toContain('file://');
  expect(detail.hasOpenButton).toBe(true);
  expect(detail.url).toBe(entries[stepIndex]?.url);

  const beforeTabs = await app.evaluate(
    () => globalThis.__helm?.getTabManager()?.getState().tabs.length ?? 0
  );

  await shellEval(
    `JSON.stringify(Boolean(document.querySelector('[data-audit-open-url]')?.click() ?? true))`
  );

  await expect
    .poll(
      () => app.evaluate(() => globalThis.__helm?.getTabManager()?.getState().tabs.length ?? 0),
      { message: '새 탭 대기', timeout: 10_000 }
    )
    .toBe(beforeTabs + 1);

  const opened = await app.evaluate(() => {
    const tabs = globalThis.__helm?.getTabManager()?.getState().tabs ?? [];
    const last = tabs[tabs.length - 1];
    return last ? { url: last.url, owner: last.owner } : null;
  });

  // 사람이 여는 탭이므로 AI 소유가 아니어야 한다.
  expect(opened?.owner).toBe('human');

  const playerShot = await captureShell('step-log-player.png');

  summary['stepLogPlayer'] = {
    steps: entries.length,
    stepsWithScreenshot: withShot.length,
    inspectedStep: stepIndex,
    openedTabUrl: opened?.url,
    openedTabOwner: opened?.owner,
    shot: playerShot
  };
});

// ─────────────────────────────────────────────────────────────
// 설정 화면 — grants 조회·회수, 거부 목록 편집, 잠금 상태
// ─────────────────────────────────────────────────────────────

test('[정책 화면] 승인 기록을 회수하고 거부 목록을 편집한다', async () => {
  await app.evaluate(() => globalThis.__helm?.setPanel('policy'));

  // 패널은 열린 뒤 정책을 비동기로 읽어 온다 — 목록이 그려질 때까지 기다린다.
  await expect
    .poll(
      async () =>
        JSON.parse(
          await shellEval(
            `JSON.stringify(Number(document.querySelector('[data-grant-count]')?.getAttribute('data-grant-count') ?? 0))`
          )
        ) as number,
      { message: '승인 목록 대기', timeout: 15_000 }
    )
    .toBeGreaterThan(0);

  // 시나리오 F 에서 남긴 thread 범위 승인이 목록에 보여야 한다.
  const before = JSON.parse(
    await shellEval(`(() => {
      const list = document.querySelector('[data-grant-count]');
      return JSON.stringify({
        locked: document.querySelector('[data-policy-locked]')?.getAttribute('data-policy-locked'),
        count: Number(list?.getAttribute('data-grant-count') ?? 0),
        subjects: [...document.querySelectorAll('[data-grant-subject]')].map((el) =>
          el.getAttribute('data-grant-subject')
        )
      });
    })()`)
  ) as { locked: string; count: number; subjects: string[] };

  expect(before.locked, '잠금 상태가 표시되지 않았습니다').toBe('false');
  expect(before.count, `기록된 승인 ${before.count}건`).toBeGreaterThan(0);
  expect(before.subjects.some((subject) => subject?.startsWith('site:'))).toBe(true);

  const shot = await captureShell('policy-panel.png');

  // 회수 — 정책 파일에서도 사라져야 한다.
  await shellEval(
    `JSON.stringify(Boolean(document.querySelector('[data-grant-revoke="0"]')?.click() ?? true))`
  );

  await expect
    .poll(() => app.evaluate(() => globalThis.__helm?.getPolicy()?.listGrants().length ?? -1), {
      message: '승인 회수 대기',
      timeout: 10_000
    })
    .toBe(before.count - 1);

  // 거부 목록 편집 — 렌더러에서 바꾼 값이 정책에 반영된다.
  await shellEval(`(() => {
    const input = document.querySelector('[data-deny-hosts]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'evil.example.com, portal-z');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-deny-save]').click();
    return JSON.stringify(true);
  })()`);

  await expect
    .poll(
      () =>
        app.evaluate(() => globalThis.__helm?.getPolicy()?.snapshot().deny.hosts ?? []),
      { message: '거부 목록 저장 대기', timeout: 10_000 }
    )
    .toEqual(['evil.example.com', 'portal-z']);

  // 거부한 도메인은 승인 여부와 무관하게 막힌다.
  const blocked = await callTool<BlockedLike>('navigate', { url: 'https://evil.example.com/' });
  expect(isBlocked(blocked), '거부 목록의 도메인이 막히지 않았습니다').toBe(true);
  expect(blocked.by).toBe('policy');

  summary['policyPanel'] = {
    grantsBefore: before.count,
    grantsAfterRevoke: before.count - 1,
    denyHosts: ['evil.example.com', 'portal-z'],
    deniedNavigate: blocked.by,
    shot
  };
});

test('[되돌리기 화면] AI 가 MCP 로 만든 항목과 봉인 사유를 사람이 본다', async () => {
  await app.evaluate(() => globalThis.__helm?.setPanel('undo'));

  await expect
    .poll(
      async () =>
        JSON.parse(
          await shellEval(
            `JSON.stringify(Number(document.querySelector('[data-undo-count]')?.getAttribute('data-undo-count') ?? 0))`
          )
        ) as number,
      { message: '되돌리기 목록 대기', timeout: 15_000 }
    )
    .toBeGreaterThan(0);

  const view = JSON.parse(
    await shellEval(`(() => {
      const list = document.querySelector('[data-undo-count]');
      return JSON.stringify({
        count: Number(list?.getAttribute('data-undo-count') ?? 0),
        sealed: [...document.querySelectorAll('[data-undo-sealed="true"]')].length,
        tools: [...document.querySelectorAll('[data-undo-id]')].map((el) =>
          el.querySelector('span')?.textContent
        )
      });
    })()`)
  ) as { count: number; sealed: number; tools: (string | null)[] };

  // 시나리오 F 의 입력(form_input·computer type)이 사람 목록에 보여야 한다.
  expect(view.count, `되돌리기 목록 ${view.count}건`).toBeGreaterThan(0);
  expect(view.tools).toContain('form_input');

  // 봉인 표시 — 제출 후에는 되돌릴 수 없다는 사실과 **사유**가 화면에 나와야 한다.
  // (시나리오 F 는 상신을 전부 거부했으므로 봉인이 없다. 여기서 직접 봉인해 표시를 본다.)
  const sealedByHook = await app.evaluate(() => {
    const hook = globalThis.__helm;
    const runId = hook?.undoActiveRunId() ?? '';
    return hook?.getUndo()?.seal(runId, '상신 실행 후에는 되돌릴 수 없습니다') ?? 0;
  });
  expect(sealedByHook, '봉인된 항목이 없습니다').toBeGreaterThan(0);

  const sealedView = JSON.parse(
    await shellEval(`(() => {
      const row = document.querySelector('[data-undo-sealed="true"]');
      return JSON.stringify({
        rows: document.querySelectorAll('[data-undo-sealed="true"]').length,
        text: row ? row.textContent : null,
        buttonDisabled: row ? Boolean(row.querySelector('button')?.disabled) : null
      });
    })()`)
  ) as { rows: number; text: string | null; buttonDisabled: boolean | null };

  expect(sealedView.rows, '봉인 표시가 화면에 없습니다').toBe(sealedByHook);
  expect(sealedView.text).toContain('상신 실행 후에는 되돌릴 수 없습니다');
  expect(sealedView.buttonDisabled, '봉인 항목의 되돌리기 버튼이 살아 있습니다').toBe(true);

  const shot = await captureShell('undo-panel.png');

  summary['undoPanel'] = {
    count: view.count,
    sealedOnLoad: view.sealed,
    sealedByHook,
    sealedRowsShown: sealedView.rows,
    shot
  };
});
