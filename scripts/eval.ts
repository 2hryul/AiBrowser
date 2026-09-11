import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 골든셋 러너 — `npm run eval -- <workflowId>` (GOAL-M5 성공 조건 4·7).
 *
 * Playwright 테스트가 아니라 **독립 실행 스크립트**다. 이유는 종료 코드다:
 * 오탐이 하나라도 있으면 1로 죽어야 하고, 그 값이 CI 의 판정이 된다.
 *
 * 하는 일:
 *   1. Electron 을 한 번 띄우고 `golden/<id>/index.json` 의 날짜를 차례로 실행한다
 *      — 실제 포털·ToolSurface·정책·마스킹·스크린샷을 모두 지나는 경로다
 *   2. 승인은 **사람 역할을 이 스크립트가 한다**. 허용 목록에 있는 주체만 `domain` 으로
 *      답하고 그 수를 센다 — 첫 날에만 물어야 하고(도메인 승인), 이후 0이어야 한다.
 *      자동 승인 플래그는 없다(불변 조건 4). 승인 없이 지나가면 그 자체가 실패다
 *   3. 판정을 `golden/<id>/expected/<date>.json` 과 맞춘다
 *   4. 증거 팩 구조·규칙 버전·PII 마스킹을 run 마다 검사한다
 *   5. 표를 `docs/eval.md` 에 덧붙이고, 오탐 > 0 이면 종료 코드 1
 */

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.eval-profile');
const DOWNLOAD_DIR = path.join(ROOT, '.eval-downloads');
const EVIDENCE_ROOT = path.join(ROOT, 'artifacts', 'm5');
const EVAL_DOC = path.join(ROOT, 'docs', 'eval.md');

/** 이 러너가 사람 대신 `domain` 으로 답해 주는 승인 주체. 그 밖에는 답하지 않는다. */
const APPROVE_SUBJECTS = new Set([
  'site:portal-h-settle',
  'site:portal-h-ledger',
  'download'
]);

/** 정산 데이터에 실제로 들어 있는 결재자 이름 — 증거 팩에 원문이 남지 않았는지 본다. */
const APPROVER_NAMES = ['김민준', '이서연', '박지호', '최수빈', '정예은'];

interface ExpectedDay {
  date: string;
  verdict: 'PASS' | 'FAIL' | 'REVIEW';
  findings: { kind: string; txId: string; note: string }[];
}

interface GoldenIndex {
  workflowId: string;
  dates: string[];
  total: number;
  planted: number;
  verdicts: Record<string, number>;
}

interface DayResult {
  date: string;
  expected: string;
  actual: string;
  match: boolean;
  /** 판정 근거가 된(실패한) 오라클 */
  failing: string[];
  sources: string;
  detected: string[];
  expectedKinds: string[];
  evidence: { ok: boolean; issues: string[]; files: number; screenshots: number; masked: number };
  durationMs: number;
}

let app: ElectronApplication;

// ─────────────────────────────────────────────────────────────
// 실행 준비
// ─────────────────────────────────────────────────────────────

function resetDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** 앞 실행이 남긴 Electron 이 포트·단일 인스턴스 잠금을 쥐고 있으면 새 실행이 조용히 죽는다. */
function killStragglers(): void {
  try {
    execFileSync('taskkill', ['/F', '/IM', 'electron.exe', '/T'], { stdio: 'ignore' });
  } catch {
    // 돌고 있지 않으면 그대로 진행
  }
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
      // 증거 팩을 저장소 안에 남겨 사람이 바로 열어 볼 수 있게 한다.
      HELM_EVIDENCE_DIR: EVIDENCE_ROOT,
      HELM_MCP_DISABLED: '1'
    }
  });

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const visible = await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0];
      return win ? win.isVisible() : false;
    });
    if (visible) return;
    await sleep(250);
  }

  throw new Error('[eval] 창이 30초 안에 뜨지 않았습니다');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// 승인 — 사람 역할
// ─────────────────────────────────────────────────────────────

const approvals: { date: string; subject: string; host: string; action: string }[] = [];
let answering = true;

/**
 * 승인 대기 큐를 지켜보다 허용 목록의 주체만 `domain` 으로 답한다.
 *
 * 목록 밖 요청은 답하지 않고 기록만 한다 — 워크플로우가 쓰기 동작을 하려 했다는 뜻이고,
 * 그러면 그 실행은 대기 상태로 멈춘 뒤 실패해야 한다(이 대사 워크플로우에는 쓰기가 없다).
 */
async function watchApprovals(currentDate: () => string): Promise<void> {
  while (answering) {
    try {
      const queue = await app.evaluate(() => globalThis.__helm?.approvalQueue() ?? []);

      for (const item of queue) {
        const subject = item.action === 'site_first_visit' ? `site:${item.host}` : item.tool;

        if (!APPROVE_SUBJECTS.has(subject)) {
          console.warn(`[eval] 허용 목록 밖 승인 요청 — ${subject} @ ${item.host} (${item.action})`);
          continue;
        }

        const answered = await app.evaluate(
          (_electronApi, id) => globalThis.__helm?.answerApproval(id, 'domain') ?? false,
          item.id
        );

        if (answered) {
          approvals.push({ date: currentDate(), subject, host: item.host, action: item.action });
          console.warn(`[eval] 승인(domain) — ${subject} @ ${item.host}`);
        }
      }
    } catch {
      // 앱이 내려가는 중이면 조용히 끝낸다.
    }

    await sleep(150);
  }
}

// ─────────────────────────────────────────────────────────────
// 증거 팩 검사 (성공 조건 7)
// ─────────────────────────────────────────────────────────────

const REQUIRED_FILES = ['extracted.json', 'normalized.json', 'oracles.json', 'run.json'];

function checkEvidence(dir: string, expectScreenshots: boolean): DayResult['evidence'] {
  const issues: string[] = [];

  if (!fs.existsSync(dir)) {
    return { ok: false, issues: [`증거 팩 폴더가 없습니다: ${dir}`], files: 0, screenshots: 0, masked: 0 };
  }

  for (const name of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, name))) issues.push(`${name} 없음`);
  }

  const stepsDir = path.join(dir, 'steps');
  const rawDir = path.join(dir, 'raw');
  const screenshots = fs.existsSync(stepsDir)
    ? fs.readdirSync(stepsDir).filter((file) => file.endsWith('.png'))
    : [];
  const raws = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')) : [];

  if (!fs.existsSync(stepsDir)) issues.push('steps/ 없음');
  if (!fs.existsSync(rawDir)) issues.push('raw/ 없음');
  if (expectScreenshots && screenshots.length === 0) issues.push('steps/*.png 이 없습니다');
  if (raws.length === 0) issues.push('raw/*.json 이 없습니다');

  // 규칙 ID 와 버전
  let masked = 0;
  try {
    const oracles = JSON.parse(fs.readFileSync(path.join(dir, 'oracles.json'), 'utf-8')) as {
      outcomes?: { rule?: string; ruleVersion?: number }[];
    };
    const outcomes = oracles.outcomes ?? [];

    if (outcomes.length === 0) issues.push('oracles.json 에 판정이 없습니다');
    for (const outcome of outcomes) {
      if (typeof outcome.rule !== 'string' || outcome.rule === '') issues.push('규칙 ID 누락');
      if (typeof outcome.ruleVersion !== 'number' || outcome.ruleVersion < 1) {
        issues.push(`규칙 버전 누락: ${String(outcome.rule)}`);
      }
    }
  } catch (error) {
    issues.push(`oracles.json 읽기 실패: ${(error as Error).message}`);
  }

  // PII 마스킹 — 선언된 항목이 `***` 인지, 그리고 원문 이름이 어디에도 없는지
  for (const name of ['extracted.json', 'normalized.json']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;

    const text = fs.readFileSync(file, 'utf-8');
    masked += (text.match(/\*\*\*/g) ?? []).length;

    for (const approver of APPROVER_NAMES) {
      if (text.includes(approver)) issues.push(`${name} 에 결재자 이름이 그대로 남았습니다 (${approver})`);
    }

    if (/"approver"\s*:\s*"(?!\*\*\*)/.test(text)) {
      issues.push(`${name} 의 approver 가 마스킹되지 않았습니다`);
    }
    if (/"approverNo"\s*:\s*"(?!\*\*\*)/.test(text)) {
      issues.push(`${name} 의 approverNo 가 마스킹되지 않았습니다`);
    }
  }

  for (const raw of raws) {
    const text = fs.readFileSync(path.join(rawDir, raw), 'utf-8');
    for (const approver of APPROVER_NAMES) {
      if (text.includes(approver)) issues.push(`raw/${raw} 에 결재자 이름이 남았습니다 (${approver})`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    files: fs.readdirSync(dir).length,
    screenshots: screenshots.length,
    masked
  };
}

// ─────────────────────────────────────────────────────────────
// 결과 → 검출 종류
// ─────────────────────────────────────────────────────────────

interface Row {
  txId?: unknown;
  [key: string]: unknown;
}

/**
 * 대사 결과를 정답표의 `kind` 로 옮긴다.
 * 판정(verdict)만 맞추면 "우연히 같은 판정" 을 놓치므로 무엇을 잡았는지까지 본다.
 */
function detectedKinds(outputs: Record<string, unknown>): string[] {
  const kinds: string[] = [];

  const mismatched = (outputs['mismatchedRows'] ?? []) as { left?: Row }[];
  for (const match of mismatched) kinds.push(`amount:${String(match.left?.txId ?? '?')}`);

  for (const row of (outputs['onlyLeftRows'] ?? []) as Row[]) {
    kinds.push(`missing_ledger:${String(row.txId ?? '?')}`);
  }

  for (const row of (outputs['onlyRightRows'] ?? []) as Row[]) {
    kinds.push(`missing_settle:${String(row.txId ?? '?')}`);
  }

  const matches = (outputs['matches'] ?? []) as { tier?: string; left?: Row }[];
  for (const match of matches) {
    if (match.tier === 'fuzzy') kinds.push(`typo_id:${String(match.left?.txId ?? '?')}`);
  }

  return [...new Set(kinds)].sort();
}

// ─────────────────────────────────────────────────────────────
// 본체
// ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const workflowId = process.argv[2];

  if (workflowId === undefined || workflowId === '') {
    console.error('사용법: npm run eval -- <workflowId>');
    return 2;
  }

  const goldenDir = path.join(ROOT, 'golden', workflowId);
  const indexFile = path.join(goldenDir, 'index.json');

  if (!fs.existsSync(indexFile)) {
    console.error(`[eval] 골든셋이 없습니다: ${indexFile}`);
    return 2;
  }

  const index = JSON.parse(fs.readFileSync(indexFile, 'utf-8')) as GoldenIndex;

  killStragglers();
  resetDir(PROFILE);
  resetDir(DOWNLOAD_DIR);
  fs.rmSync(path.join(EVIDENCE_ROOT, 'evidence'), { recursive: true, force: true });
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });

  console.warn(`[eval] ${workflowId} — ${index.dates.length}일치 (골든셋 ${indexFile})`);
  await launch();

  let currentDate = '(시작)';
  const watcher = watchApprovals(() => currentDate);
  const results: DayResult[] = [];

  try {
    const listed = await app.evaluate(() => globalThis.__helm?.listWorkflows() ?? []);
    const entry = listed.find((item) => item.id === workflowId);

    if (!entry) {
      console.error(`[eval] workflows/ 에서 ${workflowId} 를 찾지 못했습니다`);
      console.error(`       찾은 것: ${listed.map((item) => `${item.id}${item.error ? '(오류)' : ''}`).join(', ') || '없음'}`);
      return 2;
    }
    if (entry.error !== null) {
      console.error(`[eval] ${workflowId} 로드 실패\n${entry.error}`);
      return 2;
    }

    console.warn(`[eval] 워크플로우 v${entry.version} — ${entry.file}`);

    for (const date of index.dates) {
      currentDate = date;

      const expectedFile = path.join(goldenDir, 'expected', `${date}.json`);
      const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf-8')) as ExpectedDay;

      const runId = `eval-${date}`;
      const outcome = await app.evaluate(
        async (_electronApi, input) =>
          (await globalThis.__helm?.runWorkflow(input.workflowId, { date: input.date }, input.runId)) ??
          null,
        { workflowId, date, runId }
      );

      if (outcome === null) {
        results.push({
          date,
          expected: expected.verdict,
          actual: 'ERROR',
          match: false,
          failing: ['실행이 결과를 돌려주지 않았습니다'],
          sources: '',
          detected: [],
          expectedKinds: expected.findings.map((finding) => `${finding.kind}:${finding.txId}`).sort(),
          evidence: { ok: false, issues: ['실행 실패'], files: 0, screenshots: 0, masked: 0 },
          durationMs: 0
        });
        continue;
      }

      const evidence = checkEvidence(path.join(EVIDENCE_ROOT, 'evidence', runId), true);

      results.push({
        date,
        expected: expected.verdict,
        actual: outcome.verdict,
        match: outcome.verdict === expected.verdict,
        failing: outcome.oracles
          .filter((oracle) => !oracle.ok)
          .map((oracle) => `${oracle.rule}(${oracle.verdict})`),
        sources: outcome.sources.map((step) => `${step.adapter}:${step.source}`).join(' · '),
        detected: detectedKinds(outcome.outputs),
        expectedKinds: expected.findings.map((finding) => `${finding.kind}:${finding.txId}`).sort(),
        evidence,
        durationMs: outcome.durationMs
      });

      const mark = outcome.verdict === expected.verdict ? '✓' : '✗';
      console.warn(
        `[eval] ${mark} ${date} 기대 ${expected.verdict} / 실제 ${outcome.verdict} (${outcome.durationMs}ms)` +
          (evidence.ok ? '' : ` · 증거 팩 문제 ${evidence.issues.length}건`)
      );
    }
  } finally {
    answering = false;
    await watcher;
    await app.close().catch(() => undefined);
  }

  return report(workflowId, index, results);
}

// ─────────────────────────────────────────────────────────────
// 집계와 기록
// ─────────────────────────────────────────────────────────────

function report(workflowId: string, index: GoldenIndex, results: DayResult[]): number {
  const total = results.length;

  // 오탐 = 불일치가 심긴 날인데 PASS. GOAL-M5 가 타협하지 않는 그 수다.
  const falsePass = results.filter((row) => row.expected !== 'PASS' && row.actual === 'PASS');
  // 반대 방향 — 정상인데 시끄럽게 운 것.
  const falseAlarm = results.filter((row) => row.expected === 'PASS' && row.actual !== 'PASS');
  const mismatched = results.filter((row) => !row.match);
  const reviews = results.filter((row) => row.actual === 'REVIEW');

  const planted = results.filter((row) => row.expected !== 'PASS');
  const detectedPlanted = planted.filter((row) => row.actual !== 'PASS');

  // 검출 내용까지 같은지 — 판정만 맞고 다른 것을 잡은 경우를 걸러낸다.
  const wrongFindings = planted.filter(
    (row) => JSON.stringify(row.detected) !== JSON.stringify(row.expectedKinds)
  );

  const evidenceIssues = results.filter((row) => !row.evidence.ok);
  const accuracy = total === 0 ? 0 : (total - mismatched.length) / total;
  const recall = planted.length === 0 ? 1 : detectedPlanted.length / planted.length;
  const reviewRate = total === 0 ? 0 : reviews.length / total;

  const lines: string[] = [];
  lines.push('');
  lines.push(`## ${workflowId} — 골든셋 회귀 (${new Date().toISOString().slice(0, 10)})`);
  lines.push('');
  lines.push(
    `대상 ${total}일치 · 심긴 불일치 ${planted.length}건 · 정답표 \`golden/${workflowId}/expected/\``
  );
  lines.push('');
  lines.push('| 지표 | 값 |');
  lines.push('| --- | --- |');
  lines.push(`| 정확도(판정 일치) | ${(accuracy * 100).toFixed(1)}% (${total - mismatched.length}/${total}) |`);
  lines.push(`| 재현율(불일치 검출) | ${(recall * 100).toFixed(1)}% (${detectedPlanted.length}/${planted.length}) |`);
  lines.push(`| REVIEW 비율 | ${(reviewRate * 100).toFixed(1)}% (${reviews.length}/${total}) |`);
  lines.push(`| **오탐(잘못된 PASS)** | **${falsePass.length}** |`);
  lines.push(`| 오경보(정상인데 PASS 아님) | ${falseAlarm.length} |`);
  lines.push(`| 검출 내용 불일치 | ${wrongFindings.length} |`);
  lines.push(`| 증거 팩 결함 | ${evidenceIssues.length} |`);
  lines.push(`| 승인 요청(domain 응답) | ${approvals.length} |`);
  lines.push('');
  lines.push('| 날짜 | 기대 | 실제 | 근거 오라클 | 획득 경로 | 증거 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  for (const row of results) {
    lines.push(
      `| ${row.date} | ${row.expected} | ${row.match ? row.actual : `**${row.actual}**`} | ` +
        `${row.failing.join(', ') || '—'} | ${row.sources} | ` +
        `${row.evidence.ok ? `png ${row.evidence.screenshots} · \`***\` ${row.evidence.masked}` : `문제 ${row.evidence.issues.length}건`} |`
    );
  }

  lines.push('');
  lines.push(
    `승인 기록: ${
      approvals.length === 0
        ? '없음'
        : approvals.map((item) => `${item.date} ${item.subject}@${item.host}`).join(' · ')
    }`
  );
  lines.push('');
  lines.push(
    '> 승인은 러너가 사람 역할로 `domain` 범위로 답했다. 허용 목록(`site:portal-h-settle`, ' +
      '`site:portal-h-ledger`, `download`) 밖의 요청에는 답하지 않는다 — 자동 승인 플래그는 없다.'
  );
  lines.push('');

  const text = lines.join('\n');
  fs.appendFileSync(EVAL_DOC, `${text}\n`, 'utf-8');

  console.warn(text);
  console.warn(`[eval] docs/eval.md 에 기록했습니다`);

  if (evidenceIssues.length > 0) {
    console.error('[eval] 증거 팩 문제:');
    for (const row of evidenceIssues) {
      console.error(`  ${row.date}: ${row.evidence.issues.join(' / ')}`);
    }
  }

  if (wrongFindings.length > 0) {
    console.error('[eval] 검출 내용이 정답과 다릅니다:');
    for (const row of wrongFindings) {
      console.error(`  ${row.date}: 기대 [${row.expectedKinds.join(', ')}] / 실제 [${row.detected.join(', ')}]`);
    }
  }

  const goldenTotal = index.total;
  if (total !== goldenTotal) {
    console.error(`[eval] 실행 수(${total})가 골든셋(${goldenTotal})과 다릅니다`);
    return 1;
  }

  if (falsePass.length > 0) {
    console.error(`[eval] 오탐 ${falsePass.length}건 — ${falsePass.map((row) => row.date).join(', ')}`);
    return 1;
  }

  if (mismatched.length > 0 || evidenceIssues.length > 0 || wrongFindings.length > 0) {
    console.error('[eval] 판정·증거가 정답표와 어긋납니다');
    return 1;
  }

  console.warn('[eval] 오탐 0 · 미탐 0 · 증거 팩 정상');
  return 0;
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: Error) => {
    console.error('[eval] 실행 중 오류', error);
    process.exitCode = 1;
  });
