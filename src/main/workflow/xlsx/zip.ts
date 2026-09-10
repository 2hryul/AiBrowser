import zlib from 'node:zlib';

/**
 * 최소 ZIP 읽기·쓰기. xlsx 는 XML 몇 개를 담은 ZIP 이라 이것만 있으면 된다.
 *
 * **왜 직접 쓰는가**: `exceljs` 는 MIT 지만 의존성 트리에 `buffers@0.1.1`(license 필드·LICENSE
 * 파일·README 언급 **전부 없음** = 권리 부여 없음)과 `jszip`(MIT OR GPL-3.0-or-later)이 들어온다.
 * GOAL-M5 STOP CONDITIONS 가 "xlsx 라이브러리가 라이선스 허용 목록 밖이면 STOP" 이라
 * 멈추는 대신 의존성을 없앴다. 서명 배포(M6)를 앞둔 사내 앱에서 라이선스 미상 패키지를
 * 끌고 가는 것이 더 큰 문제다.
 *
 * 지원 범위는 xlsx 에 필요한 만큼이다: 단일 디스크, 압축 방식 0(store)·8(deflate),
 * ZIP64 없음(시트가 4GB 를 넘을 일은 없다).
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// ─────────────────────────────────────────────────────────────
// CRC32 — 의존성 없이 쓰려면 표를 직접 만든다
// ─────────────────────────────────────────────────────────────

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// ─────────────────────────────────────────────────────────────
// 쓰기
// ─────────────────────────────────────────────────────────────

/**
 * 고정 타임스탬프.
 *
 * 시각을 넣으면 같은 데이터로 만든 파일의 바이트가 매번 달라진다. fixture 는 결정적이어야
 * 테스트가 값을 단언할 수 있으므로 1980-01-01(ZIP 최소값)로 고정한다.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

export function zipWrite(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBlock, eocd]);
}

// ─────────────────────────────────────────────────────────────
// 읽기
// ─────────────────────────────────────────────────────────────

export class ZipError extends Error {
  constructor(message: string) {
    super(`[zip] ${message}`);
    this.name = 'ZipError';
  }
}

/** 이름 → 내용. xlsx 는 항목이 10개 안팎이라 전부 펼쳐 담아도 된다. */
export function zipRead(buffer: Buffer): Map<string, Buffer> {
  const eocdOffset = findEocd(buffer);
  if (eocdOffset < 0) throw new ZipError('EOCD 를 찾지 못했습니다 — ZIP 파일이 아닙니다');

  const total = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  const files = new Map<string, Buffer>();
  let cursor = centralOffset;

  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new ZipError(`중앙 디렉터리 항목 ${index} 의 서명이 다릅니다`);
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const uncompSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf-8');

    files.set(name, readLocal(buffer, localOffset, method, compSize, uncompSize, name));
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

function readLocal(
  buffer: Buffer,
  offset: number,
  method: number,
  compSize: number,
  uncompSize: number,
  name: string
): Buffer {
  if (buffer.readUInt32LE(offset) !== LOCAL_SIG) {
    throw new ZipError(`${name} 의 로컬 헤더 서명이 다릅니다`);
  }

  // 로컬 헤더의 이름·extra 길이는 중앙 디렉터리와 다를 수 있어 여기서 다시 읽는다.
  const nameLen = buffer.readUInt16LE(offset + 26);
  const extraLen = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  const raw = buffer.subarray(start, start + compSize);

  if (method === 0) return Buffer.from(raw);
  if (method !== 8) throw new ZipError(`${name}: 지원하지 않는 압축 방식 ${method}`);

  const inflated = zlib.inflateRawSync(raw);
  if (uncompSize > 0 && inflated.length !== uncompSize) {
    throw new ZipError(`${name}: 압축 해제 크기가 다릅니다 (${inflated.length} ≠ ${uncompSize})`);
  }

  return inflated;
}

/** EOCD 는 끝에서 찾는다. 주석이 붙을 수 있어 최대 64KB 를 거슬러 본다. */
function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff);

  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset;
  }

  return -1;
}
