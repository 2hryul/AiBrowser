import fs from 'node:fs';
import path from 'node:path';
import { maskDeep, maskText } from '../control/Masking';

/**
 * 감사 로그 — 모든 도구 호출을 JSONL 로 남긴다.
 *
 * 목적이 둘이다: 사람이 나중에 "AI 가 무엇을 했는가" 를 재생할 수 있게 하는 것,
 * 그리고 개인정보가 로그에 고이지 않게 하는 것. 인자와 결과는 저장 전에 마스킹을 거친다 —
 * 도구 결과에서 가려도 로그에 원문이 남으면 아무 의미가 없다.
 */

export interface AuditEntry {
  ts: number;
  /** 누가 불렀는가 — mcp | agent | shell */
  source: string;
  runId: string;
  tabId: number | null;
  url: string | null;
  tool: string;
  /** 마스킹된 인자 */
  args: unknown;
  /** 클릭 대상 문구 */
  targetText: string | null;
  /** 마스킹된 결과 요약 */
  result: unknown;
  durationMs: number;
  screenshotPath: string | null;
  policyDecision: 'allow' | 'deny' | 'ask';
  /** 승인 결과가 있으면 범위 */
  grantScope: string | null;
  /** 개인정보가 걸렸는가 — 사람이 다시 봐야 한다는 표시 */
  review: boolean;
  error: string | null;
}

/** 결과에서 이만큼만 남긴다. 스크린샷 base64 같은 큰 값은 로그에 넣지 않는다. */
const MAX_RESULT_CHARS = 2000;

export class AuditLog {
  private readonly dir: string;
  private readonly logPath: string;
  private readonly screenshotDir: string;
  private counter = 0;

  constructor(baseDir: string, runId: string) {
    this.dir = path.join(baseDir, 'audit');
    this.logPath = path.join(this.dir, `${runId}.jsonl`);
    this.screenshotDir = path.join(this.dir, runId);

    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  get file(): string {
    return this.logPath;
  }

  get screenshots(): string {
    return this.screenshotDir;
  }

  /**
   * 조작 도구 실행 직후 스크린샷을 저장한다.
   * 이미지에는 이미 마스킹이 적용된 상태로 들어온다(computer 도구가 가린다).
   */
  saveScreenshot(base64: string): string | null {
    if (base64 === '') return null;

    this.counter += 1;
    const file = path.join(this.screenshotDir, `step-${String(this.counter).padStart(4, '0')}.png`);

    try {
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));
      return file;
    } catch (error) {
      console.error(`[AuditLog] 스크린샷 저장 실패 - 경로: ${file}`, error);
      return null;
    }
  }

  /** 한 줄 기록. 저장 전에 인자·결과를 마스킹한다. */
  append(entry: Omit<AuditEntry, 'review'> & { review?: boolean }): AuditEntry {
    const maskedArgs = maskDeep(entry.args);
    const maskedResult = maskDeep(shrink(entry.result));
    const maskedTarget = entry.targetText === null ? null : maskText(entry.targetText).text;

    const full: AuditEntry = {
      ...entry,
      args: maskedArgs.value,
      result: maskedResult.value,
      targetText: maskedTarget,
      review: entry.review === true || maskedArgs.review || maskedResult.review
    };

    try {
      fs.appendFileSync(this.logPath, `${JSON.stringify(full)}\n`, 'utf-8');
    } catch (error) {
      console.error(`[AuditLog] 기록 실패 - 경로: ${this.logPath}`, error);
    }

    return full;
  }

  /** 재생 UI 가 읽는다. 깨진 줄은 건너뛴다 — 로그 하나 때문에 재생이 막히면 안 된다. */
  read(): AuditEntry[] {
    if (!fs.existsSync(this.logPath)) return [];

    const out: AuditEntry[] = [];
    for (const line of fs.readFileSync(this.logPath, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        // 쓰다가 중단된 줄
      }
    }
    return out;
  }

  /** 보존 기간이 지난 로그·스크린샷을 지운다. */
  static prune(baseDir: string, retentionDays: number): number {
    const dir = path.join(baseDir, 'audit');
    if (!fs.existsSync(dir)) return 0;

    const cutoff = Date.now() - retentionDays * 86_400_000;
    let removed = 0;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      try {
        if (fs.statSync(target).mtimeMs >= cutoff) continue;
        fs.rmSync(target, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        console.warn(`[AuditLog.prune] 삭제 실패 - 경로: ${target}`, error);
      }
    }

    return removed;
  }
}

/** 큰 결과를 잘라 로그를 읽을 수 있는 크기로 유지한다. */
function shrink(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_RESULT_CHARS ? `${value.slice(0, MAX_RESULT_CHARS)}…(잘림)` : value;
  }

  if (Array.isArray(value)) {
    // 배열은 앞쪽 몇 개만 남기고 길이를 알려 준다.
    if (value.length > 20) {
      return { '...': `${value.length}개 중 앞 20개`, items: value.slice(0, 20).map(shrink) };
    }
    return value.map(shrink);
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 스크린샷 base64 는 파일로 따로 저장하므로 로그에서 뺀다.
      if (key === 'image' && typeof item === 'string') {
        out[key] = `(이미지 ${item.length}바이트, 파일로 저장)`;
        continue;
      }
      out[key] = shrink(item);
    }
    return out;
  }

  return value;
}
