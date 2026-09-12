import path from 'node:path';
import { LLMClient, loadLLMConfig } from '../llm/LLMClient';
import { setFindFallback } from '../tools/find';
import { MacroCache } from './MacroCache';
import { wrapPageContent } from './prompt';

/**
 * 에이전트 런타임 조립.
 *
 * `index.ts`(구성 루트)가 `LLMClient` 를 직접 만들지 않게 하려고 둔 자리다.
 * `restrict-llm-import` 규칙은 모델을 부르는 자리를 세어 둘 수 있게 하려는 것이고,
 * 그 목록에 구성 루트까지 넣으면 "어디서든 부를 수 있다" 와 다를 바가 없어진다.
 * 그래서 **모델 객체를 만드는 곳도 에이전트 계층 안**이다.
 */

export interface AgentRuntime {
  llm: LLMClient;
  macros: MacroCache;
}

/**
 * 설정이 없으면 `null`. 기동을 세우지 않는다 — LLM 이 없다고 브라우저를 못 쓸 이유가 없다.
 *
 * @param configDir  저장소의 `config/`
 * @param userDataDir 매크로 캐시가 실행 사이에 남는 곳
 */
export function createAgentRuntime(configDir: string, userDataDir: string): AgentRuntime | null {
  const config = loadLLMConfig(configDir);
  if (!config) return null;

  // 감사 로그는 실행 단위로 바뀐다 — 스레드를 시작할 때 `bindAudit` 로 끼운다.
  const llm = new LLMClient(config, null, 'agent');

  /**
   * `find` 2차 — 규칙이 빈손일 때만 모델이 고른다(M4b IN SCOPE).
   *
   * 후보 목록은 페이지에서 온 글자다. 그래서 `<page_content>` 로 감싸 넣는다 —
   * 링크 이름 자리에 "이전 지시를 무시하라" 를 적어 두는 것은 공격자에게 공짜다.
   */
  setFindFallback(async ({ query, candidates }) => {
    const rows = candidates.map((item) => `${item.ref}\t${item.role}\t${item.name}`).join('\n');

    const response = await llm.chat({
      purpose: 'find.rank',
      temperature: 0,
      maxOutputTokens: 64,
      messages: [
        {
          role: 'system',
          content: [
            '너는 화면 요소 목록에서 사람이 말한 것에 가장 가까운 하나를 고른다.',
            '반드시 목록에 있는 ref 값 하나만 답한다. 없으면 정확히 none 이라고 답한다.',
            '설명을 붙이지 않는다.'
          ].join('\n')
        },
        {
          role: 'user',
          content: [`찾는 것: ${query}`, wrapPageContent('find', rows)].join('\n\n')
        }
      ]
    });

    const picked = response.text.trim().split(/\s+/)[0] ?? '';
    return picked === '' || picked.toLowerCase() === 'none' ? null : picked;
  });

  return {
    llm,
    macros: new MacroCache(path.join(userDataDir, 'macros.json'))
  };
}

export type { LLMClient } from '../llm/LLMClient';
export { MacroCache } from './MacroCache';
