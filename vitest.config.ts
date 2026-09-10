import { defineConfig } from 'vitest/config';

/**
 * 단위 테스트 설정. 메인 프로세스 모듈만 대상으로 하므로 node 환경이다.
 * Electron API 에 의존하는 코드는 단위 테스트 대상이 아니고 스모크(Playwright)에서 검증한다.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default']
  }
});
