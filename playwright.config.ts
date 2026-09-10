import { defineConfig } from '@playwright/test';

/**
 * 스모크 전용 설정. 브라우저를 띄우지 않고 Electron 앱만 실행하므로
 * `playwright install` 이 필요 없다(외부 다운로드 없음).
 */
export default defineConfig({
  testDir: './scripts',
  testMatch: /(smoke|tool-tests|mcp-scenarios|mcp-scenarios-m3|undo-tests)\.ts$/,
  // 두 스펙이 같은 userData 프로필을 재사용하므로 순차 실행이어야 한다.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  forbidOnly: true
});
