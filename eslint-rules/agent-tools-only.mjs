/**
 * ESLint 커스텀 규칙 — agent-tools-only
 *
 * GOAL-M4 IN SCOPE: 내장 에이전트는 **ToolSurface 만** 쓴다. CDP 직접 호출은 lint 로 막는다.
 *
 * 이유는 성능도 취향도 아니다. 도구 호출 경로에는 Policy(승인·거부·마스킹) → Handoff(일시정지)
 * → UndoManager(역연산) → AuditLog → Overlay 가 순서대로 걸려 있다. `webContents.debugger` 를
 * 에이전트가 직접 부르면 그 다섯 개를 한꺼번에 건너뛴다 — 승인 없이 제출되고, 사람이 키를
 * 눌러도 멈추지 않고, 되돌릴 수 없고, 로그에 남지 않고, 화면에 표시되지 않는다.
 *
 * 그래서 "에이전트가 브라우저를 만지는 길은 하나" 를 문법 수준에서 고정한다.
 */

const FORBIDDEN = [
  { pattern: /(^|[\\/.])cdp[\\/]/, label: 'CDP 계층(cdp/**)' },
  { pattern: /(^|[\\/.])browser[\\/]/, label: '브라우저 계층(browser/**)' },
  { pattern: /^electron$/, label: 'electron 모듈' }
];

export const agentToolsOnly = {
  meta: {
    type: 'problem',
    docs: {
      description: '내장 에이전트는 ToolSurface 만 쓴다 — CDP·브라우저 계층 직접 호출 금지'
    },
    schema: [],
    messages: {
      forbidden:
        '에이전트에서 {{label}}을(를) 직접 import 할 수 없습니다(GOAL-M4: ToolSurface 만 사용). ' +
        '도구 호출 경로에는 Policy·Handoff·UndoManager·AuditLog·Overlay 가 걸려 있고, ' +
        '직접 부르면 그 다섯을 한꺼번에 건너뜁니다. `callTool` 로 도구를 부르세요.'
    }
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!/(^|[\\/])src[\\/]main[\\/]agent[\\/]/.test(filename)) return {};

    const check = (node, source, isTypeOnly) => {
      // 타입 전용 import 는 실행 시 사라진다 — 우회 수단이 되지 않는다.
      if (isTypeOnly) return;

      const hit = FORBIDDEN.find((item) => item.pattern.test(source));
      if (hit) context.report({ node, messageId: 'forbidden', data: { label: hit.label } });
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
  rules: { 'agent-tools-only': agentToolsOnly }
};
