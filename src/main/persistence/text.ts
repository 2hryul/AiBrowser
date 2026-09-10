/**
 * 바이트 상한으로 문자열을 자르는 도구.
 *
 * 바이트로 자르면 UTF-8 문자 중간을 끊게 되고, 그 조각을 문자열로 되돌리면 대체문자(U+FFFD)가
 * 생긴다. 대체문자는 3바이트라 "상한을 지켰다" 고 믿은 결과가 상한을 넘는다(실측으로 잡았다).
 * 그래서 문자 경계까지 물러난 뒤 자른다.
 */

/** UTF-8 이어지는 바이트인지 — 10xxxxxx */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

/** 앞에서부터 maxBytes 이내로 자른다. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) return text;

  let end = maxBytes;
  while (end > 0 && isContinuation(buffer[end])) end -= 1;

  return buffer.subarray(0, end).toString('utf-8');
}

/** 뒤에서부터 maxBytes 이내로 남긴다(최근 내용을 살릴 때). */
export function truncateUtf8Tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) return text;

  let start = buffer.length - maxBytes;
  while (start < buffer.length && isContinuation(buffer[start])) start += 1;

  return buffer.subarray(start).toString('utf-8');
}
