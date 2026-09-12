import fs from 'node:fs';
import path from 'node:path';
import { ESLint, RuleTester, type Linter, type Rule } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterEach, describe, expect, it } from 'vitest';
import rules from '../eslint-rules/restrict-llm-import.mjs';

/**
 * restrict-llm-import 규칙 테스트 (GOAL-M4 CONSTRAINTS).
 *
 * require-tool-inverse 와 같은 두 층으로 본다 — 규칙 자체, 그리고 실제 배선.
 * 배선을 같이 보지 않으면 "규칙은 맞는데 eslint.config.mjs 에 안 걸려 있다" 를 놓친다.
 */

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'src', 'main', 'persistence', '__llm_probe__.ts');

// `import type` 은 TypeScript 문법이다 — espree 로는 읽히지 않는다.
// 규칙이 타입 전용 import 를 구분하는 것이 핵심이므로 프로젝트와 같은 파서를 쓴다.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser as unknown as Linter.Parser,
    ecmaVersion: 2023,
    sourceType: 'module'
  }
});

const rule = rules.rules['restrict-llm-import'] as unknown as Rule.RuleModule;

/** 허용되지 않은 자리(지속성 스토어)에서 모델을 직접 부르려는 파일. */
const BAD_IMPORT = `import { LLMClient } from '../llm/LLMClient';

export function summarize(): LLMClient | null {
  return null;
}
`;

afterEach(() => {
  fs.rmSync(PROBE, { force: true });
});

describe('restrict-llm-import 규칙', () => {
  it('허용된 자리만 통과시킨다', () => {
    ruleTester.run('restrict-llm-import', rule, {
      valid: [
        // 에이전트 — 모델을 부르는 것이 일이다
        {
          code: `import { LLMClient } from '../llm/LLMClient';`,
          filename: path.join(ROOT, 'src', 'main', 'agent', 'Agent.ts')
        },
        // find 2차(LLM 선택)
        {
          code: `import { LLMClient } from '../llm/LLMClient';`,
          filename: path.join(ROOT, 'src', 'main', 'tools', 'find.ts')
        },
        // 규칙이 못 정했을 때의 폴백
        {
          code: `import type { LLMClient } from '../../llm/LLMClient';`,
          filename: path.join(ROOT, 'src', 'main', 'workflow', 'ops', 'classify.ts')
        },
        // 계층 자신
        {
          code: `import { openAIAdapter } from './adapters/openai';`,
          filename: path.join(ROOT, 'src', 'main', 'llm', 'LLMClient.ts')
        },
        // 타입 전용 import 는 값을 만들지 않는다 — 어디서든 허용
        {
          code: `import type { LLMResponse } from '../llm/types';`,
          filename: path.join(ROOT, 'src', 'main', 'persistence', 'ThreadStore.ts')
        },
        // llm 과 무관한 import 는 건드리지 않는다
        {
          code: `import { maskDeep } from '../control/Masking';`,
          filename: path.join(ROOT, 'src', 'main', 'persistence', 'Inbox.ts')
        }
      ],
      invalid: [
        {
          code: `import { LLMClient } from '../llm/LLMClient';`,
          filename: path.join(ROOT, 'src', 'main', 'persistence', 'NoteStore.ts'),
          errors: [{ messageId: 'forbidden' }]
        },
        {
          code: `import { openAIAdapter } from '../../llm/adapters/openai';`,
          filename: path.join(ROOT, 'src', 'main', 'browser', 'portals', 'wiki.ts'),
          errors: [{ messageId: 'forbidden' }]
        },
        // 동적 import 로 우회할 수 없다
        {
          code: `const mod = await import('../llm/LLMClient');`,
          filename: path.join(ROOT, 'src', 'main', 'control', 'Policy.ts'),
          errors: [{ messageId: 'forbidden' }]
        }
      ]
    });
  });

  it('허용되지 않은 자리에 파일을 추가하면 프로젝트 lint 가 실패한다', async () => {
    fs.writeFileSync(PROBE, BAD_IMPORT, 'utf-8');

    const eslint = new ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles([PROBE]);

    const messages = results.flatMap((result) => result.messages);
    const hit = messages.filter((message) => message.ruleId?.includes('restrict-llm-import'));

    expect(hit.length, `규칙이 걸리지 않았습니다: ${JSON.stringify(messages)}`).toBeGreaterThan(0);
    expect(hit[0]?.severity, '경고가 아니라 오류여야 한다').toBe(2);
    expect(results.reduce((sum, result) => sum + result.errorCount, 0)).toBeGreaterThan(0);
  });

  it('현재 저장소는 이 규칙을 어기지 않는다', async () => {
    fs.rmSync(PROBE, { force: true });

    const eslint = new ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles([path.join(ROOT, 'src')]);
    const violations = results
      .flatMap((result) => result.messages.map((message) => ({ file: result.filePath, message })))
      .filter((item) => item.message.ruleId?.includes('restrict-llm-import'));

    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});
