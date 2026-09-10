import { listTools, resetRegistryForTest } from './index';
import { registerTabTools } from './tabs';
import { registerNavigateTools } from './navigate';
import { registerReadPageTool } from './read_page';
import { registerGetPageTextTool } from './get_page_text';
import { registerFindTool } from './find';
import { registerComputerTool } from './computer';
import { registerFormInputTool } from './form_input';
import { registerJavascriptTool } from './javascript';
import { registerReadNetworkRequestsTool } from './read_network_requests';
import { registerReadConsoleMessagesTool } from './read_console_messages';
import { registerDownloadTools } from './download';
import { registerAskTools } from './ask_user';

/**
 * ToolSurface 등록. 내장 에이전트(M4)와 MCP 서버가 같은 레지스트리를 본다.
 * 등록을 한 곳에 모아 두면 "무엇이 노출되는가" 를 한눈에 볼 수 있다.
 */

let registered = false;

export function registerAllTools(): void {
  if (registered) return;
  registered = true;

  registerTabTools();
  registerNavigateTools();
  registerReadPageTool();
  registerGetPageTextTool();
  registerFindTool();
  registerComputerTool();
  registerFormInputTool();
  registerJavascriptTool();
  registerReadNetworkRequestsTool();
  registerReadConsoleMessagesTool();
  registerDownloadTools();
  registerAskTools();
}

/** 테스트가 깨끗한 레지스트리에서 다시 시작할 때. */
export function reRegisterAllToolsForTest(): void {
  resetRegistryForTest();
  registered = false;
  registerAllTools();
}

/** 노출되는 도구 이름 — docs/tool-compat.md 와 대조한다. */
export function toolNames(): string[] {
  registerAllTools();
  return listTools().map((tool) => tool.name);
}
