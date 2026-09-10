/**
 * 다운로드 검증용 sample.pdf 생성기.
 *
 * 외부 파일을 받아오지 않기 위해(GOAL CONSTRAINTS) 최소 구조의 PDF 를 직접 조립한다.
 * xref 오프셋을 실제 바이트 위치로 계산하므로 PDF 뷰어가 여는 유효한 파일이 된다.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', 'fixtures', 'sample.pdf');

const TEXT = 'Helm M1 download fixture';

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  null, // 4: 콘텐츠 스트림 — 아래에서 만든다
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
];

const stream = `BT /F1 14 Tf 20 60 Td (${TEXT}) Tj ET`;
objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

let pdf = '%PDF-1.4\n';
const offsets = [];

objects.forEach((body, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (const offset of offsets) {
  pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

writeFileSync(OUT, pdf, 'latin1');
console.warn(`[make-download-fixture] 생성: ${OUT} (${pdf.length} bytes)`);
