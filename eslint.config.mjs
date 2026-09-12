import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import helmRules from './eslint-rules/no-credential-files.mjs';
import toolRules from './eslint-rules/require-tool-inverse.mjs';
import llmRules from './eslint-rules/restrict-llm-import.mjs';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'artifacts/**',
      '.smoke-profile/**',
      'fixtures/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module'
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // 진단 로그는 warn/error 로만 남긴다(사용자 화면에 섞이는 stdout 방지).
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always']
    }
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'scripts/**/*.{ts,mjs}',
      'tests/**/*.ts',
      'eslint-rules/**/*.mjs',
      '*.ts',
      '*.mjs'
    ],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    // CLAUDE.md 불변 조건 9 — 다른 브라우저의 자격증명 저장소는 코드에서 언급조차 하지 않는다.
    // 저장소 전체에 적용한다(예외 없음). 미끼 파일 이름은 fixtures 의 JSON 데이터에만 있다.
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs}', 'tests/**/*.ts'],
    // 유일한 예외: 규칙 자체의 테스트. 위반 문자열을 "테스트 데이터"로 담아야 하므로
    // 여기까지 규칙을 걸면 규칙을 검증할 방법이 없어진다. 파일을 읽는 코드는 들어 있지 않다.
    ignores: ['tests/no-credential-files.test.ts'],
    plugins: { helm: helmRules },
    rules: {
      'helm/no-credential-files': 'error'
    }
  },
  {
    // 도구 계약: 상태를 바꾸는 도구가 irreversible: false 이면 inverse 가 필수다(CLAUDE.md).
    files: ['src/main/tools/**/*.ts'],
    plugins: { helmTools: toolRules },
    rules: {
      'helmTools/require-tool-inverse': 'error'
    }
  },
  {
    // GOAL-M4 CONSTRAINTS: 모델을 부르는 자리를 세어 둘 수 있어야 값의 출처를 물릴 수 있다.
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    plugins: { helmLlm: llmRules },
    rules: {
      'helmLlm/restrict-llm-import': 'error'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser }
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  }
);
