import "server-only";
import { AdapterError } from "../types";
import corpcodesRaw from "./data/corpcodes.json";

/**
 * OpenDART 상장사 corp_code 매핑.
 *
 * 원본 corpCode.xml(28MB, 11만+ 법인)은 서버리스에서 파싱 부담이 커서,
 * 상장사(약 3,900개)만 추출한 사전 빌드 JSON(`data/corpcodes.json`)을 사용한다.
 * 갱신: `node scripts/build-kr-corpcodes.mjs` 실행 후 커밋.
 */

interface RawEntry {
  c: string; // corp_code
  s: string; // stock_code
  n: string; // 한글명
  e: string; // 영문명
}

export interface CorpEntry {
  corpCode: string;
  corpName: string;
  corpEngName: string;
  stockCode: string;
}

const entries: RawEntry[] = corpcodesRaw as RawEntry[];

const byStock = new Map<string, CorpEntry>();
const nameIndex: { name: string; entry: CorpEntry }[] = [];

for (const r of entries) {
  const entry: CorpEntry = {
    corpCode: r.c,
    stockCode: r.s,
    corpName: r.n,
    corpEngName: r.e,
  };
  byStock.set(r.s, entry);
  nameIndex.push({ name: r.n.toLowerCase(), entry });
  if (r.e) nameIndex.push({ name: r.e.toLowerCase(), entry });
}

export function resolveCorpCode(_apiKey: string, stockCode: string): CorpEntry {
  const code = stockCode.replace(/[^0-9]/g, "").padStart(6, "0").slice(-6);
  const entry = byStock.get(code);
  if (!entry) {
    throw new AdapterError(`DART 상장사 목록에 없는 종목코드: ${stockCode}`, { status: 404 });
  }
  return entry;
}

export function searchCorps(_apiKey: string, query: string): CorpEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: CorpEntry[] = [];
  const contains: CorpEntry[] = [];
  const seen = new Set<string>();
  for (const { name, entry } of nameIndex) {
    if (seen.has(entry.stockCode)) continue;
    if (name.startsWith(q) || entry.stockCode === q) {
      starts.push(entry);
      seen.add(entry.stockCode);
    } else if (name.includes(q)) {
      contains.push(entry);
      seen.add(entry.stockCode);
    }
    if (starts.length >= 8) break;
  }
  return [...starts, ...contains].slice(0, 8);
}
