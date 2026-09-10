import { registerTool, type Tool } from './index';

/**
 * request_access — 아직 허용되지 않은 도메인에 붙기 전 사람의 허락을 받는다.
 *
 * M2 에서는 다이얼로그만 띄우고 결과를 버렸다. M3 에서는 승인 3단계(once/thread/domain)를 받아
 * `policy.json.grants` 에 시각과 함께 남긴다 — 그래서 같은 실행에서 다시 묻지 않고,
 * 사람이 설정 화면에서 회수할 수 있다.
 *
 * 승인 범위와 무관하게 허락된 호스트는 그 실행 동안 "방문 허가" 상태가 된다(markVisited).
 * 쓰기 행위(제출·다운로드·스크립트 등)는 이 허가와 별개로 매번 판정되므로, 이 완화는
 * 읽기와 일반 입력에만 미친다. (근거: artifacts/m3/REPORT.md 편차 기록)
 */

interface AccessArgs {
  host: string;
  reason: string;
}

interface AccessResult {
  host: string;
  granted: boolean;
  /** 사람이 고른 범위. 거부면 null. */
  scope: 'once' | 'thread' | 'domain' | null;
}

const requestAccess: Tool<AccessArgs, AccessResult> = {
  name: 'request_access',
  description:
    '아직 허용되지 않은 도메인에 접근하기 전에 사람의 허락을 받는다. 왜 필요한지(reason)를 함께 ' +
    '보여주고, 사람이 고른 범위(이번 한 번 / 이 작업 동안 / 이 도메인에서 항상)가 정책에 기록된다.',
  input: {
    type: 'object',
    properties: {
      host: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1 }
    },
    required: ['host', 'reason'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      host: { type: 'string' },
      granted: { type: 'boolean' },
      scope: { type: ['string', 'null'] }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const subject = `site:${args.host}`;

    const answer = await ctx.approval.request({
      subject,
      tool: 'request_access',
      action: 'site_first_visit',
      host: args.host,
      reason: args.reason,
      targetText: null,
      irreversible: false,
      runId: ctx.runId
    });

    if (!answer.granted) {
      return { host: args.host, granted: false, scope: null };
    }

    ctx.policy.recordGrant(subject, args.host, answer.scope, ctx.runId);
    ctx.policy.markVisited(args.host);

    return { host: args.host, granted: true, scope: answer.scope };
  }
};

export function registerRequestAccessTool(): void {
  registerTool(requestAccess);
}
