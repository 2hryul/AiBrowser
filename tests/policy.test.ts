import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  Policy,
  PolicyFileSchema,
  PolicyLoadError,
  WRITE_KEYWORDS,
  classifyAction,
  isWriteKeyword,
  type PolicyQuery
} from '../src/main/control/Policy';
import { findPii, maskDeep, maskText } from '../src/main/control/Masking';

/**
 * Policy·Masking 단위 테스트 (`npm run test:policy`).
 * 판정 규칙은 Electron 없이 순수하게 결정되므로 여기서 전부 본다.
 */

const RUN = 'run-1';

function query(over: Partial<PolicyQuery> = {}): PolicyQuery {
  return {
    tool: 'get_page_text',
    host: 'portal.example.co.kr',
    irreversible: false,
    sideEffect: 'read',
    runId: RUN,
    ...over
  };
}

let dir = '';

function policyWith(file: Record<string, unknown>): Policy {
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(file), 'utf-8');
  return Policy.load(dir);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-policy-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// 쓰기 키워드 판정표 — 40건
// ─────────────────────────────────────────────────────────────

describe('M4c 정책 값 — 비밀번호 임포트와 외부 로그인', () => {
  /**
   * 두 값은 **정보보호 결정**이 코드에 닿는 자리다(2026-09-15 결정: 둘 다 허용).
   * 스키마에 없으면 `policy.json` 에 적어도 zod 가 조용히 버려 기록이 무효가 된다 —
   * 그 상태를 막는 것이 이 테스트의 목적이다.
   */
  it('기본값은 잠근 쪽이다 — 켜는 것이 사람의 결정이어야 한다', () => {
    const parsed = PolicyFileSchema.parse({});

    expect(parsed.allowPasswordImport).toBe(false);
    expect(parsed.externalLoginHosts).toEqual([]);
  });

  it('적어 둔 값이 그대로 살아남는다 (조용히 버려지지 않는다)', () => {
    const parsed = PolicyFileSchema.parse({
      allowPasswordImport: true,
      externalLoginHosts: ['idp-form', 'idp-oauth']
    });

    expect(parsed.allowPasswordImport).toBe(true);
    expect(parsed.externalLoginHosts).toEqual(['idp-form', 'idp-oauth']);
  });

  it('저장소의 config/policy.json 에 결정이 기록되어 있다', () => {
    const file = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'policy.json'), 'utf-8')
    ) as unknown;

    const parsed = PolicyFileSchema.parse(file);

    // 2026-09-15 사람 결정 — 둘 다 허용.
    expect(parsed.allowPasswordImport).toBe(true);
    expect(parsed.externalLoginHosts.length).toBeGreaterThan(0);
  });

  it('외부 로그인 호스트에 와일드카드는 없다 — 목록은 호스트 이름 그대로다', () => {
    const parsed = PolicyFileSchema.parse({ externalLoginHosts: ['*'] });

    // 스키마가 막지는 않지만, `*` 는 호스트 이름일 뿐 "전부 허용" 이 아니다.
    // 이 테스트는 그 사실을 문서로 고정한다 — 운영 목록은 실제 호스트를 적어야 한다.
    expect(parsed.externalLoginHosts).toEqual(['*']);
    expect(parsed.externalLoginHosts.includes('sso.example.co.kr')).toBe(false);
  });
});

describe('쓰기 키워드 판정표', () => {
  /** [문구, 쓰기 행위인가] — 20건 참 / 20건 거짓 */
  const TABLE: [string, boolean][] = [
    // 쓰기로 봐야 하는 것 (20)
    ['결제하기', true],
    ['결재 요청', true],
    ['송금', true],
    ['계좌 이체', true],
    ['제출', true],
    ['제출하기', true],
    ['전송', true],
    ['메일 발송', true],
    ['삭제', true],
    ['영구 삭제', true],
    ['승인', true],
    ['최종 확정', true],
    ['구매하기', true],
    ['주문 완료', true],
    ['상신', true],
    ['등록', true],
    ['Submit', true],
    ['SEND', true],
    ['Delete Account', true],
    ['Confirm order', true],

    // 쓰기가 아닌 것 (20)
    ['목록', false],
    ['다음 페이지', false],
    ['이전', false],
    ['검색', false],
    ['조회', false],
    ['상세 보기', false],
    ['닫기', false],
    ['새로고침', false],
    ['도움말', false],
    ['설정', false],
    ['정렬', false],
    ['필터', false],
    ['내려받기 안내', false],
    ['Search', false],
    ['Next', false],
    ['Back', false],
    ['Cancel', false],
    ['Help', false],
    ['Details', false],
    ['', false]
  ];

  it('판정표가 40건이다', () => {
    expect(TABLE).toHaveLength(40);
  });

  for (const [label, expected] of TABLE) {
    it(`"${label}" → ${expected ? '쓰기' : '읽기'}`, () => {
      expect(isWriteKeyword(label)).toBe(expected);
    });
  }

  it('키워드 목록에 한글과 영문이 함께 있다', () => {
    expect(WRITE_KEYWORDS.some((keyword) => /[가-힣]/.test(keyword))).toBe(true);
    expect(WRITE_KEYWORDS.some((keyword) => /^[a-z]+$/.test(keyword))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 행위 분류
// ─────────────────────────────────────────────────────────────

describe('행위 분류', () => {
  it('도구별로 행위를 가른다', () => {
    expect(classifyAction(query({ tool: 'javascript' }))).toBe('javascript');
    expect(classifyAction(query({ tool: 'download' }))).toBe('download');
    expect(classifyAction(query({ tool: 'upload' }))).toBe('upload');
    expect(classifyAction(query({ tool: 'navigate' }))).toBe('site_first_visit');
    expect(classifyAction(query({ tool: 'preview_start' }))).toBe('site_first_visit');
    expect(classifyAction(query({ tool: 'get_page_text' }))).toBe('tool');
  });

  it('쓰기 문구를 누르는 클릭은 write_click 이다', () => {
    expect(classifyAction(query({ tool: 'computer', targetText: '상신' }))).toBe('write_click');
    expect(classifyAction(query({ tool: 'computer', targetText: '목록' }))).toBe('tool');
    expect(classifyAction(query({ tool: 'computer' }))).toBe('tool');
  });
});

// ─────────────────────────────────────────────────────────────
// 사이트 allow / ask / deny
// ─────────────────────────────────────────────────────────────

describe('사이트 판정', () => {
  it('기본값은 ask 다', () => {
    const policy = policyWith({});
    expect(policy.siteDecision('anything.example')).toBe('ask');
  });

  it('host 설정이 기본값을 덮는다', () => {
    const policy = policyWith({
      sites: { default: 'ask', hosts: { 'ok.example': 'allow', 'no.example': 'deny' } }
    });
    expect(policy.siteDecision('ok.example')).toBe('allow');
    expect(policy.siteDecision('no.example')).toBe('deny');
    expect(policy.siteDecision('other.example')).toBe('ask');
  });

  it('deny.hosts 는 sites 설정을 이긴다', () => {
    const policy = policyWith({
      sites: { default: 'allow', hosts: { 'bad.example': 'allow' } },
      deny: { hosts: ['bad.example'], tools: [] }
    });
    expect(policy.siteDecision('bad.example')).toBe('deny');
  });

  it('allow 사이트의 읽기 도구는 그대로 통과한다', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });
    const verdict = policy.evaluate(query());
    expect(verdict.decision).toBe('allow');
  });

  it('거부 사이트는 읽기도 막는다', () => {
    const policy = policyWith({ deny: { hosts: ['portal.example.co.kr'], tools: [] } });
    const verdict = policy.evaluate(query());
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('거부 목록');
  });

  it('거부 도구는 사이트와 무관하게 막힌다', () => {
    const policy = policyWith({
      sites: { default: 'allow', hosts: {} },
      deny: { hosts: [], tools: ['javascript'] }
    });
    const verdict = policy.evaluate(query({ tool: 'javascript', sideEffect: 'exec', irreversible: true }));
    expect(verdict.decision).toBe('deny');
  });
});

// ─────────────────────────────────────────────────────────────
// 승인 필요 판정
// ─────────────────────────────────────────────────────────────

describe('승인 필요 판정', () => {
  it('처음 보는 사이트로의 이동은 물어본다', () => {
    const policy = policyWith({});
    const verdict = policy.evaluate(query({ tool: 'navigate', sideEffect: 'navigate' }));
    expect(verdict.decision).toBe('ask');
    if (verdict.decision !== 'ask') return;
    expect(verdict.action).toBe('site_first_visit');
    expect(verdict.subject).toBe('site:portal.example.co.kr');
  });

  it('허용 사이트로의 이동은 묻지 않는다', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });
    expect(policy.evaluate(query({ tool: 'navigate', sideEffect: 'navigate' })).decision).toBe('allow');
  });

  it('쓰기 문구 클릭·폼 제출·다운로드·업로드·javascript 는 모두 승인 대상', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });

    const cases: PolicyQuery[] = [
      query({ tool: 'computer', targetText: '상신', sideEffect: 'input' }),
      query({ tool: 'form_input', targetText: '제출', sideEffect: 'input' }),
      query({ tool: 'download', sideEffect: 'write' }),
      query({ tool: 'upload', sideEffect: 'input' }),
      query({ tool: 'javascript', sideEffect: 'exec', irreversible: true })
    ];

    for (const item of cases) {
      const verdict = policy.evaluate(item);
      expect(verdict.decision, `${item.tool} 이 승인 대상이 아님`).toBe('ask');
    }
  });

  it('되돌릴 수 없는 도구는 승인 대상이다', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });
    const verdict = policy.evaluate(
      query({ tool: 'some_tool', irreversible: true, sideEffect: 'write' })
    );
    expect(verdict.decision).toBe('ask');
    expect(verdict.reason).toContain('되돌릴 수 없');
  });

  it('javascript 기본 정책은 ask 다', () => {
    expect(DEFAULT_POLICY.tools['javascript']).toBe('ask');
  });
});

// ─────────────────────────────────────────────────────────────
// grants scope 3종
// ─────────────────────────────────────────────────────────────

describe('grants scope 3종', () => {
  it('once 는 한 번만 통한다', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });
    const target = query({ tool: 'download', sideEffect: 'write' });

    expect(policy.evaluate(target).decision).toBe('ask');
    policy.recordGrant('download', 'portal.example.co.kr', 'once', RUN);

    expect(policy.evaluate(target).decision).toBe('allow');
    // 소비되었으므로 다시 물어야 한다.
    expect(policy.evaluate(target).decision).toBe('ask');
  });

  it('thread 는 같은 실행 단위에서만 통한다', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });
    policy.recordGrant('download', 'portal.example.co.kr', 'thread', RUN);

    expect(policy.evaluate(query({ tool: 'download', sideEffect: 'write' })).decision).toBe('allow');
    expect(
      policy.evaluate(query({ tool: 'download', sideEffect: 'write', runId: 'run-2' })).decision
    ).toBe('ask');
  });

  it('domain 은 실행 단위를 넘어 통하고 파일에 남는다', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });
    policy.recordGrant('download', 'portal.example.co.kr', 'domain', RUN);

    expect(
      policy.evaluate(query({ tool: 'download', sideEffect: 'write', runId: 'run-9' })).decision
    ).toBe('allow');

    // 다시 로드해도 남아 있다.
    const reloaded = Policy.load(dir);
    expect(reloaded.listGrants()).toHaveLength(1);
    expect(reloaded.listGrants()[0]?.scope).toBe('domain');
  });

  it('다른 host 의 grant 는 적용되지 않는다', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });
    policy.recordGrant('download', 'other.example', 'domain', RUN);
    expect(policy.evaluate(query({ tool: 'download', sideEffect: 'write' })).decision).toBe('ask');
  });

  it('회수하면 다시 물어본다', () => {
    const policy = policyWith({ sites: { default: 'allow', hosts: {} } });
    policy.recordGrant('download', 'portal.example.co.kr', 'domain', RUN);
    expect(policy.evaluate(query({ tool: 'download', sideEffect: 'write' })).decision).toBe('allow');

    expect(policy.revokeGrant(0)).toBe(true);
    expect(policy.listGrants()).toHaveLength(0);
    expect(policy.evaluate(query({ tool: 'download', sideEffect: 'write' })).decision).toBe('ask');
  });

  it('없는 인덱스 회수는 실패한다', () => {
    const policy = policyWith({});
    expect(policy.revokeGrant(0)).toBe(false);
    expect(policy.revokeGrant(-1)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 관리자 잠금
// ─────────────────────────────────────────────────────────────

describe('관리자 잠금', () => {
  it('잠금 상태에서는 domain·thread grant 를 추가할 수 없다', () => {
    const policy = policyWith({ locked: true, sites: { default: 'allow', hosts: {} } });

    expect(policy.isLocked()).toBe(true);
    expect(policy.recordGrant('download', 'portal.example.co.kr', 'domain', RUN)).toBe(false);
    expect(policy.recordGrant('download', 'portal.example.co.kr', 'thread', RUN)).toBe(false);
    expect(policy.listGrants()).toHaveLength(0);
  });

  it('잠금 상태에서도 once 승인은 가능하다 — 사람이 그 순간 허락한 것이다', () => {
    const policy = policyWith({ locked: true, sites: { default: 'allow', hosts: {} } });
    expect(policy.recordGrant('download', 'portal.example.co.kr', 'once', RUN)).toBe(true);
    expect(policy.evaluate(query({ tool: 'download', sideEffect: 'write' })).decision).toBe('allow');
  });

  it('잠금 상태에서는 거부 목록·사이트 설정을 바꿀 수 없다', () => {
    const policy = policyWith({ locked: true });
    expect(policy.setDeny(['x.example'], [])).toBe(false);
    expect(policy.setSiteDecision('x.example', 'allow')).toBe(false);
    expect(policy.siteDecision('x.example')).toBe('ask');
  });

  it('잠금이 아니면 편집된다', () => {
    const policy = policyWith({});
    expect(policy.setDeny(['x.example'], ['javascript'])).toBe(true);
    expect(policy.siteDecision('x.example')).toBe('deny');
    expect(policy.isToolDenied('javascript')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// zod 로드 검증
// ─────────────────────────────────────────────────────────────

describe('policy.json 로드', () => {
  it('파일이 없으면 기본값으로 만든다', () => {
    const policy = Policy.load(dir);
    expect(fs.existsSync(path.join(dir, 'policy.json'))).toBe(true);
    expect(policy.siteDecision('any.example')).toBe('ask');
  });

  it('형식이 어긋나면 던진다 — 조용히 기본값으로 넘어가지 않는다', () => {
    fs.writeFileSync(
      path.join(dir, 'policy.json'),
      JSON.stringify({ sites: { default: 'maybe' } }),
      'utf-8'
    );
    expect(() => Policy.load(dir)).toThrow(PolicyLoadError);
  });

  it('알 수 없는 scope 는 거부된다', () => {
    fs.writeFileSync(
      path.join(dir, 'policy.json'),
      JSON.stringify({ grants: [{ subject: 'x', host: 'y', scope: 'forever', grantedAt: 1 }] }),
      'utf-8'
    );
    expect(() => Policy.load(dir)).toThrow(PolicyLoadError);
  });

  it('JSON 이 깨졌으면 사유를 담아 던진다', () => {
    fs.writeFileSync(path.join(dir, 'policy.json'), '{not json', 'utf-8');
    try {
      Policy.load(dir);
      throw new Error('던지지 않았습니다');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyLoadError);
      expect((error as PolicyLoadError).issues.join(' ')).toContain('JSON 파싱 실패');
    }
  });

  it('locked 가 boolean 이 아니면 거부된다', () => {
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ locked: 'yes' }), 'utf-8');
    expect(() => Policy.load(dir)).toThrow(PolicyLoadError);
  });
});

// ─────────────────────────────────────────────────────────────
// PII 마스킹
// ─────────────────────────────────────────────────────────────

describe('PII 마스킹', () => {
  it('사번 7자리를 가린다', () => {
    const result = maskText('사번 1000037 입니다');
    expect(result.text).not.toContain('1000037');
    expect(result.hits.employeeNo).toBe(1);
    expect(result.review).toBe(true);
  });

  it('8자리 이상 숫자는 사번으로 보지 않는다', () => {
    const result = maskText('주문번호 202601011234');
    expect(result.text).toContain('202601011234');
    expect(result.hits.employeeNo).toBe(0);
  });

  it('전화번호를 가린다', () => {
    const result = maskText('연락처 010-2000-1000');
    expect(result.text).not.toContain('010-2000-1000');
    expect(result.text).toContain('****');
    expect(result.hits.phone).toBe(1);
  });

  it('이메일을 가린다', () => {
    const result = maskText('메일 user01@example.co.kr 로 보내세요');
    expect(result.text).not.toContain('user01@example.co.kr');
    expect(result.hits.email).toBe(1);
  });

  it('한 문자열에 여러 종류가 섞여도 모두 가린다', () => {
    const result = maskText('김민준 1000000 010-2000-1000 user00@example.co.kr');
    expect(findPii(result.text).filter((item) => item.kind !== 'email')).toHaveLength(0);
    expect(result.hits.employeeNo).toBe(1);
    expect(result.hits.phone).toBe(1);
    expect(result.hits.email).toBe(1);
  });

  it('개인정보가 없으면 review 는 false 다', () => {
    const result = maskText('공지 목록 20건');
    expect(result.review).toBe(false);
    expect(result.text).toBe('공지 목록 20건');
  });

  it('객체 안의 문자열까지 재귀로 가린다', () => {
    const input = {
      rows: [{ name: '이서연', no: '1000037', contact: { phone: '010-2007-1013' } }],
      count: 1
    };
    const result = maskDeep(input);

    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain('1000037');
    expect(serialized).not.toContain('010-2007-1013');
    expect(result.review).toBe(true);
    // 숫자는 건드리지 않는다.
    expect((result.value as typeof input).count).toBe(1);
  });

  it('종류를 지정하면 그것만 가린다', () => {
    const result = maskText('1000037 / user00@example.co.kr', ['email']);
    expect(result.text).toContain('1000037');
    expect(result.text).not.toContain('user00@example.co.kr');
  });

  it('findPii 는 남아 있는 개인정보를 찾아낸다 — 검증에 쓰는 도구다', () => {
    expect(findPii('사번 1000037')).toHaveLength(1);
    expect(findPii('아무것도 없음')).toHaveLength(0);
  });
});

describe('쓰기 키워드 — 알려진 오탐', () => {
  /**
   * 문구만으로는 명사와 동사를 가릴 수 없다.
   *
   * "결재 규정" 은 결재를 **설명하는 문서**의 제목이고, 그 링크를 누르는 것은 읽기다.
   * 그런데 판정은 낱말이 들어 있는지만 보므로 쓰기 클릭으로 본다 — 안전한 쪽으로 틀리지만
   * (막고 물어본다) 사내 위키에서는 불필요한 승인이 된다.
   *
   * 이 테스트는 그 사실을 **고정**한다. 나중에 규칙을 정교하게 만들면 여기가 먼저 깨져서
   * "의도한 변경" 임을 확인하게 된다. 모의 포털 E 의 장 제목이 이 낱말들을 피하는 이유도 이것이다
   * (src/main/browser/portals/wiki.ts, artifacts/m4a/REPORT.md).
   */
  it('명사로 쓰인 낱말도 쓰기로 본다 — 현재 한계', () => {
    for (const label of ['결재 규정', '휴가 신청 안내', '자산 등록 대장', '승인 절차 문서']) {
      expect(isWriteKeyword(label), label).toBe(true);
    }
  });

  it('포털 E 의 장 제목 10종은 오탐에 걸리지 않는다', () => {
    const topics = [
      '보안 지침',
      '조직 안내',
      '경비 처리',
      '자산 목록',
      '출입 통제',
      '개발 표준',
      '장애 대응',
      '외주 계약',
      '교육 과정',
      '용어 사전'
    ];

    for (const topic of topics) {
      expect(isWriteKeyword(topic), topic).toBe(false);
      // 실제 문서 제목은 "<주제> v1.2" 꼴이다 — 접미사가 붙어도 걸리지 않아야 한다.
      expect(isWriteKeyword(`${topic} v3.7`), topic).toBe(false);
    }
  });
});
