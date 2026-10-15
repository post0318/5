/**
 * 저장 때 형식 검사(설계 10 §3.5-10). 받은 쪽이 저장 전에 부른다 — 통과한 바이트만 보관소에 들어간다.
 * 반환 {ok:true} 또는 {ok:false, why}.
 *  - 빈 본문 거부
 *  - JSON: 끝까지 파싱 + 필수 필드
 *  - XML: 끝까지 짝이 맞는지(잘린 파일 거부) — 태그 짝·주석·CDATA·처리 지시만 보는 가벼운 검사(스키마 검사 아님)
 *  - zip: 중앙 디렉터리 + 모든 항목 압축 해제 + CRC32 전체 대조
 */
import { crc32, inflateRawSync } from "node:zlib";

const ok = { ok: true };
const bad = (why) => ({ ok: false, why });

export function checkNonEmpty(buf) {
  if (!buf || buf.length === 0) return bad("빈 본문");
  if (buf.toString("utf8", 0, Math.min(buf.length, 4096)).trim() === "") return bad("공백뿐인 본문");
  return ok;
}

/**
 * @param {Buffer} buf
 * @param {(j:any)=>string|null} [require] 필수 필드 검사 — 문제가 있으면 사유 문자열
 */
export function checkJson(buf, require) {
  const e = checkNonEmpty(buf);
  if (!e.ok) return e;
  let j;
  try {
    j = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    return bad(`JSON 파싱 실패: ${String(err.message).slice(0, 120)}`);
  }
  if (require) {
    const why = require(j);
    if (why) return bad(why);
  }
  return ok;
}

/** XML 이 끝까지 짝이 맞는지. 문자열 버퍼 하나로 훑는다(수십 MB 인스턴스도 한 번). */
export function checkXml(buf) {
  const e = checkNonEmpty(buf);
  if (!e.ok) return e;
  const s = buf.toString("utf8");
  const stack = [];
  let i = 0, roots = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end < 0) return bad("주석이 닫히지 않음(잘린 파일)");
      i = end + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt + 9);
      if (end < 0) return bad("CDATA 가 닫히지 않음(잘린 파일)");
      i = end + 3;
      continue;
    }
    if (s.startsWith("<?", lt)) {
      const end = s.indexOf("?>", lt + 2);
      if (end < 0) return bad("처리 지시가 닫히지 않음(잘린 파일)");
      i = end + 2;
      continue;
    }
    if (s.startsWith("<!", lt)) {
      // DOCTYPE — 내부 부분집합 [ ... ] 고려
      let j = lt + 2, depth = 0;
      for (; j < n; j++) {
        const c = s[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= n) return bad("DOCTYPE 이 닫히지 않음(잘린 파일)");
      i = j + 1;
      continue;
    }
    // 태그 끝 '>' — 속성값 안의 '>' 는 따옴표로 건너뛴다
    let j = lt + 1, q = null;
    for (; j < n; j++) {
      const c = s[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    if (j >= n) return bad("태그가 닫히지 않음(잘린 파일)");
    const body = s.slice(lt + 1, j);
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (top !== name) return bad(`닫는 태그 불일치: </${name}> (열린 것 <${top ?? "없음"}>)`);
      if (stack.length === 0) roots++;
    } else if (!body.endsWith("/")) {
      const name = body.match(/^[^\s/>]+/)?.[0];
      if (!name) return bad(`태그 이름 없음 @${lt}`);
      stack.push(name);
    } else if (stack.length === 0) roots++;
    i = j + 1;
  }
  if (stack.length) return bad(`열린 태그 ${stack.length}개가 닫히지 않음(잘린 파일) — 마지막 <${stack[stack.length - 1]}>`);
  if (roots < 1) return bad("뿌리 요소 없음");
  return ok;
}

/** zip 전체 검사: 끝 레코드 → 중앙 디렉터리 → 각 항목 로컬 헤더 → 압축 해제 → CRC32·크기 대조 */
export function checkZip(buf) {
  if (!buf || buf.length < 22) return bad("zip 이 너무 짧음");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return bad("zip 끝 레코드 없음(잘린 파일)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) return bad("zip64 — 이 검사기 미지원");
  if (cdOff + cdSize > buf.length) return bad("중앙 디렉터리가 파일 밖(잘린 파일)");
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return bad(`중앙 디렉터리 항목 ${k} 서명 오류`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const loff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (buf.readUInt32LE(loff) !== 0x04034b50) return bad(`항목 ${name} 로컬 헤더 서명 오류`);
    const lnlen = buf.readUInt16LE(loff + 26);
    const lxlen = buf.readUInt16LE(loff + 28);
    const start = loff + 30 + lnlen + lxlen;
    if (start + csize > buf.length) return bad(`항목 ${name} 데이터가 파일 밖(잘린 파일)`);
    const data = buf.subarray(start, start + csize);
    let out;
    try {
      if (method === 0) out = data;
      else if (method === 8) out = inflateRawSync(data);
      else return bad(`항목 ${name} 압축 방식 ${method} 미지원`);
    } catch (e) {
      return bad(`항목 ${name} 압축 해제 실패: ${String(e.message).slice(0, 80)}`);
    }
    if (out.length !== usize) return bad(`항목 ${name} 크기 불일치 ${out.length} ≠ ${usize}`);
    if ((crc32(out) >>> 0) !== crc) return bad(`항목 ${name} CRC 불일치`);
  }
  return ok;
}

/** zip 안 파일 목록과 내용(검사를 통과한 zip 만) */
export function unzipEntries(buf) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip 끝 레코드 없음");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const loff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    const start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    const data = buf.subarray(start, start + csize);
    out.push({ name, data: method === 0 ? Buffer.from(data) : inflateRawSync(data) });
  }
  return out;
}
