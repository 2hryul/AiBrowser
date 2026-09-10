import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSuggestions,
  loadSearchConfig,
  normalizeAddress,
  resolveSearchUrl,
  type SearchConfig,
  type SuggestSources
} from '../src/main/browser/Omnibox';
import type { Bookmark, HistorySuggestion } from '../src/shared/types';

const NO_SEARCH: SearchConfig = { defaultEngine: null, engines: [] };

function sources(over: Partial<SuggestSources> = {}): SuggestSources {
  return {
    bookmarks: () => [],
    history: () => [],
    search: NO_SEARCH,
    ...over
  };
}

function bookmark(url: string, title: string, id = 1): Bookmark {
  return { id, url, title, folder: '', position: id, createdAt: 0 };
}

function visit(url: string, title: string, visitCount: number): HistorySuggestion {
  return { url, title, visitCount, lastVisitedAt: 0 };
}

describe('normalizeAddress', () => {
  it('스킴이 있으면 그대로 쓴다', () => {
    expect(normalizeAddress('https://a.example/b')).toBe('https://a.example/b');
    expect(normalizeAddress('app://home/')).toBe('app://home/');
    expect(normalizeAddress('about:blank')).toBe('about:blank');
  });

  it('호스트 형태면 https 를 붙인다', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com/');
    expect(normalizeAddress('localhost:5173')).toBe('https://localhost:5173/');
  });

  it('home 은 홈으로', () => {
    expect(normalizeAddress('home')).toBe('app://home/');
    expect(normalizeAddress('app://home')).toBe('app://home/');
  });

  it('허용 목록 밖 스킴과 검색어는 거부한다', () => {
    expect(normalizeAddress('file:///C:/secret.txt')).toBeNull();
    expect(normalizeAddress('javascript:alert(1)')).toBeNull();
    expect(normalizeAddress('문서 보관 규정')).toBeNull();
    expect(normalizeAddress('   ')).toBeNull();
  });
});

describe('옴니박스 제안', () => {
  it('"hom" 은 app://home 이 1순위다', () => {
    const result = buildSuggestions('hom', sources());
    expect(result[0]?.url).toBe('app://home/');
    expect(result[0]?.kind).toBe('url');
  });

  it('히스토리·북마크가 있어도 "hom" 1순위는 app://home 이다', () => {
    const result = buildSuggestions(
      'hom',
      sources({
        bookmarks: () => [bookmark('https://homepage.example.co.kr/', '홈페이지')],
        history: () => [visit('https://homeplus.example.co.kr/', '홈플러스', 40)]
      })
    );
    expect(result[0]?.url).toBe('app://home/');
    expect(result.map((s) => s.url)).toContain('https://homepage.example.co.kr/');
  });

  it('완전한 주소는 직접 이동이 1순위', () => {
    const result = buildSuggestions(
      'portal.example.co.kr',
      sources({ history: () => [visit('https://other.example/', '다른 곳', 99)] })
    );
    expect(result[0]?.kind).toBe('url');
    expect(result[0]?.url).toBe('https://portal.example.co.kr/');
  });

  it('북마크가 히스토리보다 위에 온다', () => {
    const result = buildSuggestions(
      'itsm',
      sources({
        bookmarks: () => [bookmark('https://itsm.example.co.kr/', 'ITSM')],
        history: () => [visit('https://itsm.example.co.kr/tickets', 'ITSM 티켓', 50)]
      })
    );
    expect(result[0]?.kind).toBe('bookmark');
    expect(result[1]?.kind).toBe('history');
  });

  it('같은 구간에서는 방문 횟수가 많은 쪽이 위', () => {
    const result = buildSuggestions(
      'example',
      sources({
        history: () => [visit('https://a.example/', 'A', 1), visit('https://b.example/', 'B', 30)]
      })
    );
    const urls = result.filter((s) => s.kind === 'history').map((s) => s.url);
    expect(urls[0]).toBe('https://b.example/');
  });

  it('같은 URL 은 한 번만 나온다', () => {
    const url = 'https://dup.example.co.kr/';
    const result = buildSuggestions(
      'dup',
      sources({ bookmarks: () => [bookmark(url, '중복')], history: () => [visit(url, '중복', 5)] })
    );
    expect(result.filter((s) => s.url === url)).toHaveLength(1);
  });

  it('검색엔진이 없으면 검색 제안을 만들지 않는다', () => {
    const result = buildSuggestions('문서 보관 규정', sources());
    expect(result.every((s) => s.kind !== 'search')).toBe(true);
  });

  it('검색엔진이 설정되면 맨 아래에 검색 제안이 붙는다', () => {
    const search: SearchConfig = {
      defaultEngine: 'corp',
      engines: [
        { id: 'corp', name: '사내 검색', urlTemplate: 'https://s.example.co.kr/q?query={q}' }
      ]
    };
    const result = buildSuggestions('문서 보관', sources({ search }));
    const last = result[result.length - 1];
    expect(last?.kind).toBe('search');
    expect(last?.url).toBe('https://s.example.co.kr/q?query=%EB%AC%B8%EC%84%9C%20%EB%B3%B4%EA%B4%80');
  });

  it('빈 입력은 제안이 없다', () => {
    expect(buildSuggestions('   ', sources())).toEqual([]);
  });
});

describe('검색엔진 설정', () => {
  it('저장소의 config/search.json 은 기본적으로 엔진이 없다', () => {
    const config = loadSearchConfig(path.resolve(import.meta.dirname, '..', 'config'));
    expect(config.engines).toEqual([]);
    expect(config.defaultEngine).toBeNull();
    expect(resolveSearchUrl(config, '아무거나')).toBeNull();
  });

  it('파일이 없으면 빈 설정', () => {
    expect(loadSearchConfig(path.join(os.tmpdir(), 'helm-no-such-dir'))).toEqual({
      defaultEngine: null,
      engines: []
    });
  });

  it('{q} 가 없는 엔진은 무시한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-search-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'search.json'),
        JSON.stringify({
          defaultEngine: 'bad',
          engines: [
            { id: 'bad', name: '틀림', urlTemplate: 'https://x.example/search' },
            { id: 'good', name: '맞음', urlTemplate: 'https://x.example/search?q={q}' }
          ]
        })
      );
      const config = loadSearchConfig(dir);
      expect(config.engines.map((e) => e.id)).toEqual(['good']);
      // defaultEngine 이 걸러진 엔진을 가리키면 남은 첫 엔진으로 대체된다.
      expect(config.defaultEngine).toBe('good');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('깨진 JSON 은 빈 설정으로 떨어진다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-search-bad-'));
    try {
      fs.writeFileSync(path.join(dir, 'search.json'), '{not json');
      expect(loadSearchConfig(dir).engines).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
