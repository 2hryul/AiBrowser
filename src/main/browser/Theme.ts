import { nativeTheme } from 'electron';
import type { ThemeSource } from '../../shared/types';

/**
 * 다크모드.
 * nativeTheme.themeSource 를 바꾸면 셸(prefers-color-scheme)과 웹 페이지가 함께 따라간다.
 * 셸이 자체 토글을 갖는 대신 OS 설정과 같은 축을 쓰게 해서 크롬과 동작을 맞춘다.
 */
export function setThemeSource(source: ThemeSource): ThemeSource {
  nativeTheme.themeSource = source;
  return nativeTheme.themeSource;
}

export function getThemeSource(): ThemeSource {
  return nativeTheme.themeSource;
}

export function isDarkMode(): boolean {
  return nativeTheme.shouldUseDarkColors;
}

/** system → dark → light → system 순환. 툴바 버튼 한 개로 셋을 돈다. */
export function cycleThemeSource(): ThemeSource {
  const next: Record<ThemeSource, ThemeSource> = {
    system: 'dark',
    dark: 'light',
    light: 'system'
  };
  return setThemeSource(next[getThemeSource()]);
}
