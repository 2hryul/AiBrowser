import type { ActionKind, GrantScope } from './Policy';

/**
 * Approval — 승인 다이얼로그와 대기 큐.
 *
 * 자동 승인 경로는 없다(GOAL-M3 FIXED DECISIONS). 승인이 필요하면 사람이 답할 때까지 도구 호출이
 * 기다리고, 그 사이 실행 단위 상태는 `waiting_approval` 이다. 헤드리스·MCP 실행에서도 같다 —
 * 큐에 쌓이고 사람이 사이드바에서 처리한다.
 */

export interface ApprovalRequest {
  id: string;
  /** 승인 주체 — Policy 가 grant 를 남길 때 쓰는 키 */
  subject: string;
  tool: string;
  action: ActionKind;
  host: string;
  /** 왜 묻는지 — 사람이 판단할 근거 */
  reason: string;
  /** 클릭 대상 문구 등 */
  targetText: string | null;
  /** 되돌릴 수 없는 작업이면 다이얼로그에 고정 문구가 붙는다 */
  irreversible: boolean;
  runId: string;
  createdAt: number;
}

export type ApprovalAnswer =
  | { granted: true; scope: GrantScope }
  | { granted: false; reason: 'denied' };

export interface ApprovalEvents {
  /** 셸에 새 승인 요청을 알린다. */
  onRequest: (request: ApprovalRequest) => void;
  /** 대기 목록이 바뀔 때. 사이드바 배지·목록 갱신용. */
  onQueueChange: (queue: ApprovalRequest[]) => void;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (answer: ApprovalAnswer) => void;
}

/** 허용된 승인의 기록 — 감사 로그가 "누가 무엇을 허락했는지" 를 빠뜨리지 않게 한다. */
export interface GrantedApproval {
  scope: GrantScope;
  subject: string;
  at: number;
}

export class Approval {
  private readonly events: ApprovalEvents;
  private readonly pending = new Map<string, Pending>();
  /**
   * 실행 단위별 허용 기록. 도구가 스스로 승인을 받는 경우(request_access)에도
   * callTool 이 감사 로그에 범위를 적을 수 있어야 한다.
   */
  private readonly granted = new Map<string, GrantedApproval[]>();
  private counter = 0;

  constructor(events: ApprovalEvents) {
    this.events = events;
  }

  /** 사람에게 묻고 답을 기다린다. 답이 오기 전에는 도구 호출이 진행되지 않는다. */
  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<ApprovalAnswer> {
    this.counter += 1;
    const request: ApprovalRequest = {
      ...input,
      id: `approval-${Date.now()}-${this.counter}`,
      createdAt: Date.now()
    };

    return new Promise<ApprovalAnswer>((resolve) => {
      this.pending.set(request.id, { request, resolve });
      this.events.onRequest(request);
      this.events.onQueueChange(this.queue());
    });
  }

  /** 사람이 답했다. scope 를 주면 허용, 없으면 거부. */
  answer(id: string, answer: ApprovalAnswer): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;

    this.pending.delete(id);

    if (answer.granted) {
      const list = this.granted.get(entry.request.runId) ?? [];
      list.push({ scope: answer.scope, subject: entry.request.subject, at: Date.now() });
      this.granted.set(entry.request.runId, list);
    }

    entry.resolve(answer);
    this.events.onQueueChange(this.queue());
    return true;
  }

  /** 그 실행 단위에서 허용된 승인 수. callTool 이 run 전후로 비교한다. */
  grantedCount(runId: string): number {
    return this.granted.get(runId)?.length ?? 0;
  }

  /** 가장 최근 허용 기록. */
  lastGranted(runId: string): GrantedApproval | null {
    const list = this.granted.get(runId);
    return list && list.length > 0 ? (list[list.length - 1] ?? null) : null;
  }

  queue(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /** 대기 중인 요청이 있는지 — 실행 단위 상태 표시용. */
  isWaiting(runId: string): boolean {
    return [...this.pending.values()].some((entry) => entry.request.runId === runId);
  }

  /** 앱을 닫을 때 남은 요청은 거부로 떨어뜨린다. 조용히 통과시키지 않는다. */
  rejectAll(): void {
    for (const entry of [...this.pending.values()]) {
      this.pending.delete(entry.request.id);
      entry.resolve({ granted: false, reason: 'denied' });
    }
    this.events.onQueueChange([]);
  }
}

/** 되돌릴 수 없는 작업의 고정 문구. 다이얼로그와 로그에서 같은 문장을 쓴다. */
export const IRREVERSIBLE_NOTICE = '이 작업은 되돌릴 수 없습니다';
