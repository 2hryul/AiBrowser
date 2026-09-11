import fs from 'node:fs';
import path from 'node:path';
import { EvidencePack, type EvidenceContract, type EvidenceSummary } from '../audit/Evidence';
import { createLedgerAdapter } from './adapters/ledger';
import type { PortalIo, NetEntryLike } from './adapters/io';
import { createSettleAdapter } from './adapters/settle';
import { Engine, type Adapter, type RunResult } from './Engine';
import { loadWorkflow, type WorkflowDoc } from './schema';

/**
 * 워크플로우 실행 — 메인 프로세스 쪽 배선.
 *
 * 어댑터는 `PortalIo` 만 보고, 그 구현은 여기서 **ToolSurface 를 거쳐** 만든다.
 * 어댑터가 CDP 를 직접 부르지 않는 것이 요점이다: 정책 검사·PII 마스킹·감사 로그가
 * 도구 호출 경로에 붙어 있으므로, 워크플로우도 사람이 쓰는 것과 같은 문을 지나야 한다.
 *
 * 실행 하나가 만드는 것: 증거 팩 폴더 + 판정. 예약 실행이면 받은편지함 항목까지.
 */

export type ToolDispatch = (threadId: string, name: string, args: unknown) => Promise<unknown>;

export interface RunnerOptions {
  /** `__helm.callTool` 과 같은 통로 — 정책·감사·마스킹을 지난다 */
  callTool: ToolDispatch;
  /** 증거 팩과 워크플로우 폴더의 부모. 보통 userData */
  baseDir: string;
  /** `workflows/` 폴더 */
  workflowDir: string;
}

export interface WorkflowRunOutcome {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  inputs: Record<string, unknown>;
  verdict: string;
  status: string;
  /** 단계별 실제 획득 경로 — 폴백이 일어났는지 여기서 보인다 */
  sources: { step: string; adapter: string | null; source: string; note: string | null }[];
  outputs: Record<string, unknown>;
  oracles: { rule: string; ruleVersion: number; verdict: string; ok: boolean; message: string }[];
  evidence: EvidenceSummary;
  durationMs: number;
}

/**
 * ToolSurface 로 만든 `PortalIo`.
 *
 * 탭은 실행 하나가 하나만 쓴다(열고 계속 이동). 워크플로우가 20번 돌면 탭 20개가 남는 일을
 * 막으려는 것이고, 사람이 보는 탭을 건드리지 않기 위해 `foreground: false` 로만 만든다.
 */
export function createPortalIo(
  callTool: ToolDispatch,
  threadId: string,
  pack: EvidencePack | null
): PortalIo & { closeTab: () => Promise<void> } {
  let tabId: number | null = null;

  const call = async <T>(name: string, args: unknown): Promise<T> =>
    (await callTool(threadId, name, args)) as T;

  return {
    async open(url) {
      if (tabId === null) {
        const created = await call<{ tabId: number }>('tabs_create', { url, foreground: false });
        tabId = created.tabId;
        return tabId;
      }

      await call('navigate', { tabId, url });
      return tabId;
    },

    async tap(id, urlPattern) {
      const result = await call<{ requests: NetEntryLike[] }>('read_network_requests', {
        tabId: id,
        urlPattern,
        includeBody: true,
        limit: 50
      });
      return result.requests;
    },

    async click(id, query, role) {
      const found = await call<{ matches: { ref?: string; name?: string }[] }>('find', {
        tabId: id,
        query,
        ...(role === undefined ? {} : { role }),
        limit: 5
      });

      const ref = found.matches[0]?.ref;
      if (ref === undefined) throw new Error(`"${query}" 를 화면에서 찾을 수 없습니다`);

      await call('computer', { tabId: id, action: 'left_click', ref });
    },

    async text(id) {
      const result = await call<{ text: string }>('get_page_text', { tabId: id, mode: 'text' });
      return result.text;
    },

    async download(id, url) {
      return call<{ savePath: string; bytes: number }>('download', { tabId: id, url });
    },

    async readFile(savePath) {
      return fs.promises.readFile(savePath);
    },

    async screenshot(id, label) {
      if (pack === null) return null;

      try {
        const shot = await call<{ image?: string }>('computer', {
          tabId: id,
          action: 'screenshot',
          scale: 0.5
        });
        if (shot.image === undefined || shot.image === '') return null;

        return pack.saveScreenshot(label, Buffer.from(shot.image, 'base64'));
      } catch (error) {
        // 스크린샷 실패로 대사를 멈추지 않는다.
        console.warn(`[workflow] 스크린샷 실패 - ${label}: ${(error as Error).message}`);
        return null;
      }
    },

    async wait(ms) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.();
      });
    },

    async closeTab() {
      if (tabId === null) return;
      try {
        await call('tabs_close', { tabId });
      } catch {
        // 이미 닫혔으면 그대로 둔다.
      }
      tabId = null;
    }
  };
}

function toEvidenceContract(adapter: Adapter): EvidenceContract {
  const { contract } = adapter;
  return {
    name: contract.name,
    version: contract.version,
    output: [...contract.output],
    pii: [...contract.pii],
    source: contract.source,
    write: contract.write
  };
}

export class WorkflowRunner {
  private readonly options: RunnerOptions;
  private readonly cache = new Map<string, WorkflowDoc>();

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  /** `workflows/*.yaml` 목록. 로드 실패한 파일은 사유와 함께 알린다. */
  list(): { id: string; version: number; description: string | null; file: string; error: string | null }[] {
    const dir = this.options.workflowDir;
    if (!fs.existsSync(dir)) return [];

    const out: ReturnType<WorkflowRunner['list']> = [];

    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const full = path.join(dir, file);

      try {
        const doc = loadWorkflow(fs.readFileSync(full, 'utf-8'), file);
        out.push({
          id: doc.id,
          version: doc.version,
          description: doc.description ?? null,
          file: full,
          error: null
        });
      } catch (error) {
        out.push({ id: file, version: 0, description: null, file: full, error: (error as Error).message });
      }
    }

    return out;
  }

  load(workflowId: string): WorkflowDoc {
    const cached = this.cache.get(workflowId);
    if (cached) return cached;

    for (const entry of this.list()) {
      if (entry.error !== null) continue;
      if (entry.id !== workflowId) continue;

      const doc = loadWorkflow(fs.readFileSync(entry.file, 'utf-8'), entry.file);
      this.cache.set(workflowId, doc);
      return doc;
    }

    throw new Error(`[workflow] ${workflowId} 을 ${this.options.workflowDir} 에서 찾을 수 없습니다`);
  }

  /** 같은 워크플로우를 여러 번 돌릴 때 YAML 을 다시 읽게 한다(승격 UI 저장 직후). */
  forget(workflowId?: string): void {
    if (workflowId === undefined) this.cache.clear();
    else this.cache.delete(workflowId);
  }

  /**
   * 한 번 실행하고 증거 팩을 남긴다.
   *
   * `runId` 를 받는 이유는 증거 팩 폴더 이름이 되고, 예약 실행이 받은편지함에 그 경로를
   * 적어 주기 때문이다 — 사람이 결과에서 근거로 바로 갈 수 있어야 한다.
   */
  async run(
    workflowId: string,
    inputs: Record<string, unknown>,
    options: { runId?: string; threadId?: string } = {}
  ): Promise<WorkflowRunOutcome> {
    const workflow = this.load(workflowId);
    const runId = options.runId ?? `${workflowId}-${Date.now().toString(36)}`;
    const threadId = options.threadId ?? `workflow:${runId}`;

    const pack = new EvidencePack(this.options.baseDir, runId);
    const io = createPortalIo(this.options.callTool, threadId, workflow.evidence.screenshots ? pack : null);

    const adapters: Record<string, Adapter> = {};
    for (const adapter of [createSettleAdapter(io), createLedgerAdapter(io)]) {
      adapters[adapter.contract.name] = adapter;
    }

    const engine = new Engine({ adapters });
    const startedAt = Date.now();

    let result: RunResult;
    try {
      result = await engine.run(workflow, inputs, runId);
    } finally {
      await io.closeTab();
    }

    const contracts: Record<string, EvidenceContract> = {};
    for (const [name, adapter] of Object.entries(adapters)) {
      contracts[name] = toEvidenceContract(adapter);
    }

    const evidence = pack.write({ workflow, result, contracts, finishedAt: Date.now() });

    return {
      runId,
      workflowId,
      workflowVersion: workflow.version,
      inputs,
      verdict: result.verdict,
      status: result.state.status,
      sources: result.state.steps
        .filter((step) => step.kind === 'adapter')
        .map((step) => ({
          step: step.id,
          adapter: step.name,
          source: step.source,
          note: step.note
        })),
      outputs: result.outputs,
      oracles: result.verification.outcomes.map((outcome) => ({
        rule: outcome.rule,
        ruleVersion: outcome.ruleVersion,
        verdict: outcome.verdict,
        ok: outcome.ok,
        message: outcome.message
      })),
      evidence,
      durationMs: Date.now() - startedAt
    };
  }
}
