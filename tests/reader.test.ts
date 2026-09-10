import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractArticle, isReaderable, normalizeText } from '../src/main/browser/Reader';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
const READER = path.join(FIXTURES, 'reader');

interface Expected {
  cases: string[];
  mustContain: string[];
  mustNotContain: string[];
}

const expected = JSON.parse(readFileSync(path.join(READER, 'expected.json'), 'utf-8')) as Expected;

function read(file: string): string {
  return readFileSync(file, 'utf-8');
}

describe('Reader 본문 추출 — 골든 5건', () => {
  it('골든 케이스가 5건이다', () => {
    expect(expected.cases).toHaveLength(5);
  });

  for (const name of expected.cases) {
    it(`${name}: 본문은 살리고 잡동사니는 걷어낸다`, () => {
      const html = read(path.join(READER, `${name}.html`));
      const result = extractArticle(html, `app://fixtures/reader/${name}.html`);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { textContent, title, length } = result.article;

      for (const token of expected.mustContain) {
        expect(textContent, `${name}: 본문 표식 ${token} 누락`).toContain(token);
      }
      for (const token of expected.mustNotContain) {
        expect(textContent, `${name}: 잡동사니 ${token} 혼입`).not.toContain(token);
      }

      expect(title).toContain('보관 규정 개정');
      expect(length).toBeGreaterThan(400);
    });
  }
});

describe('Reader — app://fixtures/article.html (스모크와 같은 페이지)', () => {
  const html = read(path.join(FIXTURES, 'article.html'));
  const url = 'app://fixtures/article.html';

  it('본문 표식을 포함한다', () => {
    const result = extractArticle(html, url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.textContent).toContain('문서보관기준개정본문');
    expect(result.article.title).toBe('사내 문서 보관 규정 개정 안내');
  });

  it('광고 div 와 스크립트는 포함하지 않는다', () => {
    const result = extractArticle(html, url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.textContent).not.toContain('광고영역상단');
    expect(result.article.textContent).not.toContain('광고영역하단');
    expect(result.article.content).not.toContain('__adTracker');
    expect(result.article.content).not.toContain('<script');
  });

  it('읽기 모드 대상으로 판정된다', () => {
    expect(isReaderable(html, url)).toBe(true);
  });
});

describe('Reader — 실패 경로', () => {
  it('빈 HTML 은 empty-html', () => {
    const result = extractArticle('   ', 'app://home/');
    expect(result).toEqual({ ok: false, reason: 'empty-html' });
  });

  it('본문이 없는 페이지는 추출하지 않는다', () => {
    const html = '<!doctype html><html><head><title>빈 페이지</title></head><body><nav><a href="/">홈</a></nav></body></html>';
    const result = extractArticle(html, 'app://home/');
    expect(result.ok).toBe(false);
    expect(isReaderable(html, 'app://home/')).toBe(false);
  });
});

describe('normalizeText', () => {
  it('연속 공백과 빈 줄을 접는다', () => {
    expect(normalizeText('  가  나 \n\n\n  다  \n')).toBe('가 나\n다');
  });
});
