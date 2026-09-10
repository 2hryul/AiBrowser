/**
 * 포털 C 의 EUC-KR 문서 생성기.
 *
 * Node 의 TextEncoder 는 UTF-8 만 만들 수 있어 구형 인코딩 페이지를 코드에서 즉석으로
 * 만들 수 없다. 그래서 iconv-lite 로 한 번 인코딩해 파일로 커밋하고, 런타임에는 그 바이트를
 * 그대로 내려보낸다(런타임에 iconv 의존 없음).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';

const OUT = path.resolve(import.meta.dirname, '..', 'fixtures', 'portals', 'portal-c-euckr.html');

/** 치환문자(U+FFFD) 없이 디코딩되는지 확인할 표식. EUC-KR 로 표현 가능한 글자만 쓴다. */
const MARKER = '구형인코딩본문표식';

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="EUC-KR" />
<title>규정 제3호 - 인사 관리 기준</title>
</head>
<body>
<h1 id="doc-title">규정 제3호 - 인사 관리 기준</h1>
<p id="doc-body">${MARKER}. 본 규정은 사내 문서 관리 기준을 정한다. 한글 본문이 구형 인코딩으로 제공된다.</p>
<p>가나다라마바사아자차카타파하 영문 ABC 숫자 12345 기호 ()[]{}!?</p>
<p><a id="attachment" href="app://portal-c/attachment?id=3" download>첨부: 규정 제3호.pdf</a></p>
</body>
</html>
`;

const bytes = iconv.encode(html, 'euc-kr');
writeFileSync(OUT, bytes);

// 왕복 검증 — 인코딩이 깨졌으면 여기서 바로 드러난다.
const decoded = iconv.decode(bytes, 'euc-kr');
if (!decoded.includes(MARKER)) {
  throw new Error('[make-portal-fixtures] EUC-KR 왕복 실패: 본문 표식이 사라졌습니다');
}
if (decoded.includes('�')) {
  throw new Error('[make-portal-fixtures] EUC-KR 왕복 실패: 치환문자가 섞였습니다');
}
// 완전 일치까지 본다 — EUC-KR 로 표현할 수 없는 글자가 '?' 로 뭉개지는 것도 잡는다.
if (decoded !== html) {
  const at = [...html].findIndex((ch, i) => ch !== decoded[i]);
  throw new Error(
    `[make-portal-fixtures] EUC-KR 왕복 실패: ${at} 번째 글자가 바뀌었습니다 ` +
      `(${JSON.stringify(html[at])} -> ${JSON.stringify(decoded[at])})`
  );
}

console.warn(`[make-portal-fixtures] 생성: ${OUT} (${bytes.length} bytes, UTF-8 대비 ${html.length}자)`);
