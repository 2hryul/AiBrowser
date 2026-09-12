import path from 'node:path';
import { LLMClient, loadLLMConfig } from '../llm/LLMClient';
import { MacroCache } from './MacroCache';

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

  return {
    // 감사 로그는 실행 단위로 바뀐다 — 스레드를 시작할 때 `bindAudit` 로 끼운다.
    llm: new LLMClient(config, null, 'agent'),
    macros: new MacroCache(path.join(userDataDir, 'macros.json'))
  };
}

export type { LLMClient } from '../llm/LLMClient';
export { MacroCache } from './MacroCache';
