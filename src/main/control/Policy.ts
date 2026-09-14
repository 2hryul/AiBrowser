import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Policy — AI 가 하는 일에 대한 허가 판정.
 *
 * 순서는 하나다: **거부 확인 → 승인 필요 여부 → 마스킹**.
 * 자동 승인 플래그는 만들지 않는다(GOAL-M3 FIXED DECISIONS). "묻지 않고 해도 된다" 는 상태는
 * 사람이 명시적으로 남긴 grant 뿐이고, 그 grant 는 범위와 시각이 기록된다.
 *
 * policy.json 은 zod 로 검증한다. 형식이 어긋나면 조용히 기본값으로 넘어가지 않고 기동을 세운다 —
 * 정책 파일이 깨진 채로 도는 것이 정책 없이 도는 것보다 위험하다.
 */

export const SiteDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type SiteDecision = z.infer<typeof SiteDecisionSchema>;

export const GrantScopeSchema = z.enum(['once', 'thread', 'domain']);
export type GrantScope = z.infer<typeof GrantScopeSchema>;

export const GrantSchema = z.object({
  /** 도구 이름 또는 행위 이름(write_click 등) */
  subject: z.string().min(1),
  host: z.string().min(1),
  scope: GrantScopeSchema,
  /** scope==='thread' 일 때만 의미가 있다. M3 에서는 실행 단위 runId. */
  threadId: z.string().optional(),
  grantedAt: z.number().int().nonnegative()
});
export type Grant = z.infer<typeof GrantSchema>;

export const PolicyFileSchema = z.object({
  /** 관리자 잠금. true 면 사용자 grants 추가·정책 편집 불가. */
  locked: z.boolean().default(false),
  sites: z
    .object({
      default: SiteDecisionSchema.default('ask'),
      hosts: z.record(z.string(), SiteDecisionSchema).default({})
    })
    .default({ default: 'ask', hosts: {} }),
  deny: z
    .object({
      hosts: z.array(z.string()).default([]),
      tools: z.array(z.string()).default([])
    })
    .default({ hosts: [], tools: [] }),
  /** 도구별 기본 판정. 여기 없으면 sideEffect 로 판단한다. */
  tools: z.record(z.string(), SiteDecisionSchema).default({}),
  grants: z.array(GrantSchema).default([]),
  /**
   * 최초 구동 마법사에서 **저장된 비밀번호** 항목을 보여 줄지(M4c).
   *
   * 기본은 false 다 — 켜는 것이 사람의 결정이어야 한다. true 여도 자동으로 가져오지 않는다.
   * 마법사에서 명시 동의를 한 번 더 받고, 가져온 값은 OS 자격증명 관리자로 옮긴 뒤
   * 평문을 즉시 지운다. 관리자가 `locked` 로 이 값을 잠글 수 있다(M6).
   *
   * 이 값이 true 라도 **세션 쿠키·토큰은 여전히 가져오지 않는다**(불변 조건 9).
   * 비밀번호와 세션은 다른 물건이다.
   */
  allowPasswordImport: z.boolean().default(false),
  /**
   * 외부 브라우저(`login_start` 의 `external`) 폴백을 허용할 **호스트 화이트리스트**(M4c).
   *
   * 와일드카드는 없다 — 호스트 이름을 그대로 적는다(`deny.hosts` 와 같은 규칙).
   * 목록 밖 호스트는 실행 자체가 거부된다. 비어 있으면 외부 폴백을 쓰지 않는다는 뜻이다.
   */
  externalLoginHosts: z.array(z.string()).default([]),
  /** 감사 로그·스크린샷 보존 일수 */
  retentionDays: z.number().int().positive().default(30)
});

export type PolicyFile = z.infer<typeof PolicyFileSchema>;

/** 기본 정책. 파일이 없을 때만 쓴다(형식 오류는 기본값으로 덮지 않는다). */
export const DEFAULT_POLICY: PolicyFile = {
  locked: false,
  sites: { default: 'ask', hosts: {} },
  deny: { hosts: [], tools: [] },
  // javascript 는 무엇을 실행할지 알 수 없어 기본이 ask 다(GOAL-M3 FIXED DECISIONS).
  tools: { javascript: 'ask' },
  grants: [],
  // 기본은 잠근 쪽이다 — 켜는 것이 사람의 결정이어야 한다(M4c).
  allowPasswordImport: false,
  externalLoginHosts: [],
  retentionDays: 30
};

export class PolicyLoadError extends Error {
  readonly issues: string[];

  constructor(file: string, issues: string[]) {
    super(`[Policy] policy.json 형식 오류 - 경로: ${file}\n  ${issues.join('\n  ')}`);
    this.name = 'PolicyLoadError';
    this.issues = issues;
  }
}

/**
 * 쓰기 키워드 — 이 낱말이 붙은 요소를 누르는 것은 되돌릴 수 없을 가능성이 높다.
 * 한글은 어간이 붙으므로 부분 일치로 본다("제출하기", "결재요청" 모두 걸린다).
 */
export const WRITE_KEYWORDS: readonly string[] = [
  // 한국어
  '결제',
  '결재',
  '결의',
  '송금',
  '이체',
  '입금',
  '출금',
  '제출',
  '전송',
  '발송',
  '삭제',
  '제거',
  '승인',
  '확정',
  '확인완료',
  '구매',
  '주문',
  '결산',
  '등록',
  '신청',
  '상신',
  '반려',
  '취소',
  '폐기',
  '저장',
  '수정',
  '변경',
  '발행',
  '청구',
  '지급',
  // 영어
  'submit',
  'send',
  'delete',
  'remove',
  'approve',
  'confirm',
  'purchase',
  'order',
  'pay',
  'payment',
  'transfer',
  'checkout',
  'publish',
  'register',
  'apply',
  'save',
  'update',
  'destroy'
];

/** 요소 문구가 쓰기 행위인지. 대소문자·공백을 무시한다. */
export function isWriteKeyword(label: string): boolean {
  const normalized = label.toLowerCase().replace(/\s+/g, '');
  if (normalized === '') return false;
  return WRITE_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

/** 승인 대상이 되는 행위. 도구 이름과 별개로 "무엇을 하려는가" 를 가리킨다. */
export type ActionKind =
  | 'write_click'
  | 'form_submit'
  | 'download'
  | 'upload'
  | 'javascript'
  | 'site_first_visit'
  | 'tool';

export interface PolicyQuery {
  tool: string;
  /** 대상 페이지 host. 없으면 판정에서 사이트 규칙을 건너뛴다. */
  host: string | null;
  /** 클릭 대상 문구 등 — 쓰기 키워드 판정에 쓴다. */
  targetText?: string;
  /** 도구 계약의 되돌릴 수 없음 표시 */
  irreversible: boolean;
  sideEffect: 'read' | 'navigate' | 'input' | 'write' | 'exec' | 'persist';
  /** 실행 단위. M4 에서 threadId 로 승격된다. */
  runId: string;
}

export type PolicyVerdict =
  | { decision: 'allow'; reason: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string; action: ActionKind; subject: string };

export class Policy {
  private file: PolicyFile;
  private readonly filePath: string;
  /** once 로 승인된 것은 소비되면 사라진다. 파일에 쓰지 않는다. */
  private readonly onceGrants = new Set<string>();
  /** 사람이 이번 실행에서 접근을 허용한 host */
  private readonly visitedHosts = new Set<string>();

  constructor(filePath: string, file: PolicyFile) {
    this.filePath = filePath;
    this.file = file;
  }

  /**
   * 정책 파일을 읽는다. 파일이 없으면 기본값으로 만들고, 형식이 어긋나면 던진다.
   * @param userDataDir 사용자 데이터 폴더(CONSTRAINTS: 정책 파일은 여기 둔다)
   * @param seedFrom 저장소의 config/policy.json — 첫 실행에서 복사할 원본
   */
  static load(userDataDir: string, seedFrom?: string): Policy {
    const filePath = path.join(userDataDir, 'policy.json');

    if (!fs.existsSync(filePath)) {
      const seed =
        seedFrom && fs.existsSync(seedFrom)
          ? fs.readFileSync(seedFrom, 'utf-8')
          : `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`;
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(filePath, seed, 'utf-8');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      throw new PolicyLoadError(filePath, [`JSON 파싱 실패: ${(error as Error).message}`]);
    }

    const parsed = PolicyFileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
      );
      throw new PolicyLoadError(filePath, issues);
    }

    return new Policy(filePath, parsed.data);
  }

  snapshot(): PolicyFile {
    return structuredClone(this.file);
  }

  isLocked(): boolean {
    return this.file.locked;
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.filePath, `${JSON.stringify(this.file, null, 2)}\n`, 'utf-8');
    } catch (error) {
      console.error(`[Policy] 정책 저장 실패 - 경로: ${this.filePath}`, error);
    }
  }

  /** 사이트 판정. deny 목록이 sites 설정을 이긴다. */
  siteDecision(host: string | null): SiteDecision {
    if (!host) return 'allow';
    if (this.file.deny.hosts.includes(host)) return 'deny';
    return this.file.sites.hosts[host] ?? this.file.sites.default;
  }

  /** 도구가 아예 금지되었는지. */
  isToolDenied(tool: string): boolean {
    return this.file.deny.tools.includes(tool);
  }

  private grantKey(subject: string, host: string, runId: string, scope: GrantScope): string {
    return `${scope}:${subject}:${host}:${scope === 'thread' ? runId : ''}`;
  }

  /** 이미 승인된 행위인지. once 는 여기서 소비된다. */
  private hasGrant(subject: string, host: string, runId: string): boolean {
    const onceKey = this.grantKey(subject, host, runId, 'once');
    if (this.onceGrants.has(onceKey)) {
      this.onceGrants.delete(onceKey);
      return true;
    }

    return this.file.grants.some(
      (grant) =>
        grant.subject === subject &&
        grant.host === host &&
        ((grant.scope === 'domain') || (grant.scope === 'thread' && grant.threadId === runId))
    );
  }

  /**
   * 승인 결과를 기록한다.
   * @returns 기록 성공 여부. 관리자 잠금 상태면 domain/thread grant 를 추가하지 않는다.
   */
  recordGrant(subject: string, host: string, scope: GrantScope, runId: string): boolean {
    if (scope === 'once') {
      this.onceGrants.add(this.grantKey(subject, host, runId, 'once'));
      return true;
    }

    // 관리자 잠금: 사용자가 정책을 넓히는 grant 를 남길 수 없다(CONSTRAINTS).
    if (this.file.locked) return false;

    this.file.grants.push({
      subject,
      host,
      scope,
      ...(scope === 'thread' ? { threadId: runId } : {}),
      grantedAt: Date.now()
    });
    this.persist();
    return true;
  }

  /** 설정 화면에서 grant 회수. */
  revokeGrant(index: number): boolean {
    if (this.file.locked) return false;
    if (index < 0 || index >= this.file.grants.length) return false;
    this.file.grants.splice(index, 1);
    this.persist();
    return true;
  }

  listGrants(): Grant[] {
    return this.file.grants.map((grant) => ({ ...grant }));
  }

  /** 거부 목록 편집. 잠금 상태에서는 바꿀 수 없다. */
  setDeny(hosts: string[], tools: string[]): boolean {
    if (this.file.locked) return false;
    this.file.deny = { hosts: [...new Set(hosts)], tools: [...new Set(tools)] };
    this.persist();
    return true;
  }

  setSiteDecision(host: string, decision: SiteDecision): boolean {
    if (this.file.locked) return false;
    this.file.sites.hosts[host] = decision;
    this.persist();
    return true;
  }

  /** 이번 실행에서 이 host 를 이미 방문 허가했는지 표시한다. */
  markVisited(host: string): void {
    this.visitedHosts.add(host);
  }

  hasVisited(host: string): boolean {
    return this.visitedHosts.has(host);
  }

  /**
   * 판정. 순서가 중요하다:
   *   1) 도구 거부 목록
   *   2) 사이트 거부
   *   3) 이미 받은 승인
   *   4) 승인이 필요한 행위인지
   */
  evaluate(query: PolicyQuery): PolicyVerdict {
    if (this.isToolDenied(query.tool)) {
      return { decision: 'deny', reason: `도구 ${query.tool} 은(는) 정책에서 거부되었습니다` };
    }

    const site = this.siteDecision(query.host);
    if (site === 'deny') {
      return { decision: 'deny', reason: `${query.host} 은(는) 거부 목록에 있습니다` };
    }

    const host = query.host ?? '(no-host)';
    const action = classifyAction(query);

    // 읽기 도구는 사이트가 allow 면 그대로 통과한다.
    if (action === 'tool' && query.sideEffect === 'read' && site === 'allow') {
      return { decision: 'allow', reason: '읽기 도구, 사이트 허용' };
    }

    const subject = subjectOf(action, query);

    if (this.hasGrant(subject, host, query.runId)) {
      return { decision: 'allow', reason: `이미 승인됨 (${subject} @ ${host})` };
    }

    // 사이트 첫 접근: ask 상태이고 아직 방문 허가를 받지 않았다면 물어본다.
    if (action === 'site_first_visit') {
      if (site === 'allow' || this.hasVisited(host)) {
        return { decision: 'allow', reason: '이미 허용된 사이트' };
      }
      return {
        decision: 'ask',
        reason: `${host} 에 처음 접근합니다`,
        action,
        subject
      };
    }

    if (action === 'tool') {
      const toolPolicy = this.file.tools[query.tool];
      if (toolPolicy === 'deny') {
        return { decision: 'deny', reason: `도구 ${query.tool} 정책이 거부입니다` };
      }
      if (toolPolicy === 'ask') {
        return { decision: 'ask', reason: `도구 ${query.tool} 은(는) 승인이 필요합니다`, action, subject };
      }
      if (query.irreversible) {
        return {
          decision: 'ask',
          reason: `${query.tool} 은(는) 되돌릴 수 없습니다`,
          action,
          subject
        };
      }
      // 사이트가 ask 인데 읽기 외 행위면 첫 접근 승인이 먼저다.
      if (site === 'ask' && query.sideEffect !== 'read' && !this.hasVisited(host)) {
        return {
          decision: 'ask',
          reason: `${host} 에 처음 접근합니다`,
          action: 'site_first_visit',
          subject: `site:${host}`
        };
      }
      return { decision: 'allow', reason: '승인 대상 아님' };
    }

    // write_click / form_submit / download / upload / javascript
    return {
      decision: 'ask',
      reason: reasonFor(action, query),
      action,
      subject
    };
  }
}

/** 행위 분류. 도구 이름과 인자를 보고 "무엇을 하려는가" 를 정한다. */
export function classifyAction(query: PolicyQuery): ActionKind {
  if (query.tool === 'javascript') return 'javascript';
  if (query.tool === 'download') return 'download';
  if (query.tool === 'upload') return 'upload';

  if (query.tool === 'navigate' || query.tool === 'preview_start' || query.tool === 'tabs_create') {
    return 'site_first_visit';
  }

  if (query.tool === 'computer' && query.targetText && isWriteKeyword(query.targetText)) {
    return 'write_click';
  }

  if (query.tool === 'form_input' && query.targetText && isWriteKeyword(query.targetText)) {
    return 'form_submit';
  }

  return 'tool';
}

function subjectOf(action: ActionKind, query: PolicyQuery): string {
  if (action === 'site_first_visit') return `site:${query.host ?? '(no-host)'}`;
  if (action === 'write_click' || action === 'form_submit') return `${action}:${query.tool}`;
  return query.tool;
}

function reasonFor(action: ActionKind, query: PolicyQuery): string {
  switch (action) {
    case 'write_click':
      return `"${query.targetText ?? ''}" 을(를) 누르려 합니다. 되돌릴 수 없을 수 있습니다.`;
    case 'form_submit':
      return `폼을 제출하려 합니다 ("${query.targetText ?? ''}")`;
    case 'download':
      return '파일을 내려받으려 합니다';
    case 'upload':
      return '파일을 올리려 합니다';
    case 'javascript':
      return '페이지에서 스크립트를 실행하려 합니다. 되돌릴 수 없습니다.';
    default:
      return `${query.tool} 실행에 승인이 필요합니다`;
  }
}
