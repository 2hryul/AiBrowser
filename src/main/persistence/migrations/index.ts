import { migration001 } from './001-browser';
import { migration002 } from './002-persistence';

/**
 * 스키마 마이그레이션 순서. **append 만** 한다(GOAL-M4 FIXED DECISIONS: 번호 파일).
 *
 * 배열 길이가 목표 `user_version` 이고, 인덱스 n 의 SQL 이 버전 n+1 을 만든다.
 * 파일을 나눠 두면 "어느 버전에서 무엇이 생겼는지" 를 파일 하나만 보고 알 수 있다.
 */
export const MIGRATIONS: readonly string[] = [migration001, migration002];
