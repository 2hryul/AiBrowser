import fs from 'node:fs';
import path from 'node:path';
import { ESLint, RuleTester, type Rule } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';
import rules from '../eslint-rules/require-tool-inverse.mjs';

/**
 * require-tool-inverse 규칙 테스트 (GOAL-M3 성공 조건 6).
 *
 * 두 층을 본다.
 *  1. 규칙 자체 — RuleTester 로 위반/정상 판정
 *  2. 실제 배선 — `src/main/tools/` 에 위반 파일을 만들면 프로젝트 lint 가 실패하는지
 *
 * 2번이 없으면 "규칙은 맞지만 eslint.config.mjs 에 안 걸려 있다" 는 상태를 놓친다.
 */

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'src', 'main', 'tools', '__inverse_probe__.ts');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' }
});

const rule = rules.rules['require-tool-inverse'] as unknown as Rule.RuleModule;

/** 위반 도구 — 상태를 바꾸는데 되돌릴 수 있다고만 적어 두고 역연산이 없다. */
const BAD_TOOL = `import { registerTool, type Tool } from './index';

const probe: Tool<{ value: string }, { ok: boolean }> = {
  name: 'probe_write',
  description: '테스트용. 되돌릴 수 있다고 표시했지만 inverse 가 없다.',
  input: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  output: { type: 'object', properties: { ok: { type: 'boolean' } } },
  sideEffect: 'write',
  irreversible: false,
  async run() {
    return { ok: true };
  }
};

export function registerProbeTool(): void {
  registerTool(probe);
}
`;

afterEach(() => {
  fs.rmSync(PROBE, { force: true });
});

describe('require-tool-inverse 규칙', () => {
  it('위반은 잡고 정상 도구는 통과시킨다', () => {
    ruleTester.run('require-tool-inverse', rule, {
      valid: [
        // 역연산이 있는 되돌릴 수 있는 도구
        {
          code: `const t = { name: 'a', sideEffect: 'input', irreversible: false, inverse: () => null, run: async () => 1 };`
        },
        // 되돌릴 수 없다고 선언한 도구 — inverse 를 요구하지 않는다
        {
          code: `const t = { name: 'b', sideEffect: 'write', irreversible: true, run: async () => 1 };`
        },
        // 읽기 도구는 되돌릴 것이 없다
        {
          code: `const t = { name: 'c', sideEffect: 'read', irreversible: false, run: async () => 1 };`
        },
        // 도구가 아닌 객체는 건드리지 않는다
        { code: `const cfg = { name: 'd', irreversible: false };` },
        // irreversible 이 리터럴이 아니면 판정하지 않는다(변수·계산값)
        {
          code: `const t = { name: 'e', sideEffect: 'write', irreversible: flag, run: async () => 1 };`
        }
      ],
      invalid: [
        {
          code: `const t = { name: 'f', sideEffect: 'write', irreversible: false, run: async () => 1 };`,
          errors: [{ messageId: 'missingInverse' }]
        },
        {
          code: `const t = { name: 'g', sideEffect: 'input', irreversible: false, run: async () => 1 };`,
          errors: [{ messageId: 'missingInverse' }]
        },
        {
          code: `const t = { name: 'h', sideEffect: 'persist', irreversible: false, run: async () => 1 };`,
          errors: [{ messageId: 'missingInverse' }]
        },
        // 반대 방향 모순 — 되돌릴 수 없다면서 역연산이 있다
        {
          code: `const t = { name: 'i', sideEffect: 'write', irreversible: true, inverse: () => null, run: async () => 1 };`,
          errors: [{ messageId: 'inverseOnIrreversible' }]
        }
      ]
    });
  });

  it('src/main/tools 에 위반 파일을 추가하면 프로젝트 lint 가 실패한다', async () => {
    fs.writeFileSync(PROBE, BAD_TOOL, 'utf-8');

    // 프로젝트 설정을 그대로 읽는다 — 규칙이 실제로 배선되어 있는지가 이 테스트의 목적이다.
    const eslint = new ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles([PROBE]);

    const messages = results.flatMap((result) => result.messages);
    const hit = messages.filter((message) => message.ruleId?.includes('require-tool-inverse'));

    expect(hit.length, `규칙이 걸리지 않았습니다: ${JSON.stringify(messages)}`).toBeGreaterThan(0);
    expect(hit[0]?.severity, '경고가 아니라 오류여야 한다').toBe(2);
    expect(hit[0]?.message).toContain('inverse');

    // 오류 총계가 0 이면 `eslint --max-warnings=0` 도 통과해 버린다.
    expect(results.reduce((sum, result) => sum + result.errorCount, 0)).toBeGreaterThan(0);
  });

  it('위반 파일을 지우면 프로젝트 lint 가 다시 통과한다', async () => {
    fs.rmSync(PROBE, { force: true });

    const eslint = new ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles([path.join(ROOT, 'src', 'main', 'tools')]);
    const errors = results.flatMap((result) => result.messages);

    expect(errors, `기존 도구가 규칙을 위반합니다: ${JSON.stringify(errors)}`).toEqual([]);
  });
});
