/**
 * ESLint 커스텀 규칙 — restrict-llm-import
 *
 * GOAL-M4 CONSTRAINTS: `LLMClient` import 는 정해진 자리에서만 허용한다.
 *
 * 이유는 승인 게이트도 마스킹도 아니고 **판정 가능성**이다. LLM 을 아무 데서나 부를 수 있으면
 * 어떤 값이 모델에서 나왔는지 추적할 수 없고, M5 의 provenance 강등(`llm` 출처 값으로는
 * 오라클을 PASS 시키지 않는다)이 뚫린다. 부르는 자리를 세어 둘 수 있어야 출처를 물릴 수 있다.
 *
 * 허용하는 자리:
 *   - `agent/**`            내장 에이전트 루프와 추출기(Extract)
 *   - `llm/**`              계층 자신(어댑터·클라이언트)
 *   - `workflow/ops/classify.ts`, `workflow/ops/normalize.ts`   규칙이 못 정했을 때의 폴백
 *   - `workflow/recorder/**` 레코더 컴파일러(M7 후보, 자리만 열어 둔다)
 *   - `tools/find.ts`       find 2차(LLM 선택)
 *
 * 그 밖의 파일에서 `llm/` 을 import 하면 에러다. 폴백이 필요하면 위 자리에서 **주입**받아라 —
 * `ClassifyFallback` 이 그렇게 생겼다.
 */

const ALLOWED = [
  /(^|[\\/])src[\\/]main[\\/]agent[\\/]/,
  /(^|[\\/])src[\\/]main[\\/]llm[\\/]/,
  /(^|[\\/])src[\\/]main[\\/]workflow[\\/]ops[\\/]classify\.ts$/,
  /(^|[\\/])src[\\/]main[\\/]workflow[\\/]ops[\\/]normalize\.ts$/,
  /(^|[\\/])src[\\/]main[\\/]workflow[\\/]recorder[\\/]/,
  /(^|[\\/])src[\\/]main[\\/]tools[\\/]find\.ts$/
];

/** `../llm/LLMClient`, `./llm/types` 처럼 llm 계층을 가리키는 경로인가. */
function pointsAtLlmLayer(source) {
  return /(^|[\\/.])llm[\\/]/.test(source) || source.endsWith('/llm');
}

export const restrictLlmImport = {
  meta: {
    type: 'problem',
    docs: {
      description: 'LLM 계층 import 는 GOAL-M4 가 정한 자리에서만 허용한다'
    },
    schema: [],
    messages: {
      forbidden:
        '이 파일에서는 LLM 계층("{{source}}")을 import 할 수 없습니다(GOAL-M4 CONSTRAINTS). ' +
        '허용된 자리는 agent/**, llm/**, workflow/ops/classify|normalize, workflow/recorder/**, ' +
        'tools/find.ts 입니다. 다른 곳에서 모델이 필요하면 폴백 함수를 주입받으세요 — ' +
        '부르는 자리를 세어 둘 수 없으면 값의 출처(provenance)를 물릴 수 없습니다.'
    }
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();

    // 타입 전용 import 까지 막을 필요는 없다 — 타입은 실행 시 사라지고 값을 만들지 않는다.
    const check = (node, source, isTypeOnly) => {
      if (isTypeOnly) return;
      if (!pointsAtLlmLayer(source)) return;
      if (ALLOWED.some((pattern) => pattern.test(filename))) return;

      context.report({ node, messageId: 'forbidden', data: { source } });
    };

    return {
      ImportDeclaration(node) {
        check(node, String(node.source.value), node.importKind === 'type');
      },
      ImportExpression(node) {
        if (node.source.type !== 'Literal') return;
        check(node, String(node.source.value), false);
      }
    };
  }
};

export default {
  rules: { 'restrict-llm-import': restrictLlmImport }
};
