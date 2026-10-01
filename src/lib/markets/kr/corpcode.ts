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
  const code = stockCode
    .replace(/[^0-9]/g, "")
    .padStart(6, "0")
    .slice(-6);
  const entry = byStock.get(code);
  if (!entry) {
    throw new AdapterError(`DART 상장사 목록에 없는 종목코드: ${stockCode}`, {
      status: 404,
    });
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

/**
 * 회사명 비교용 정규화 — 대소문자·공백·"(주)"/"㈜" 차이만 흡수한다. 그 이상
 * (접두어·약칭)은 일부러 안 맞춘다. 리서치 수집 라우트가 이름으로 종목코드를
 * 풀 때 "가장 비슷한 것"을 고르면 엉뚱한 회사에 붙는다(실측 2026-09-28: 현대차→
 * 현대차증권, CJ→씨제이인터넷, 신흥국→신흥). 약칭은 호출부의 별칭 표로만 푼다.
 */
export function normalizeCorpName(s: string): string {
  return s
    .toLowerCase()
    .replaceAll("(주)", "")
    .replaceAll("㈜", "")
    .split(" ")
    .join("")
    .trim();
}

/**
 * 정규화한 이름이 **완전히 같은** 법인 전부. 표가 현재 상장사만 담게 정제된
 * 뒤(build-kr-corpcodes.mjs)로는 동명 법인이 없어 보통 0 또는 1건이지만,
 * 호출부는 2건 이상이면 애매한 것으로 보고 붙이지 않는다.
 */
export function findCorpsByExactName(query: string): CorpEntry[] {
  const q = normalizeCorpName(query);
  if (!q) return [];
  const out: CorpEntry[] = [];
  const seen = new Set<string>();
  for (const { name, entry } of nameIndex) {
    if (seen.has(entry.stockCode)) continue;
    if (normalizeCorpName(name) === q) {
      out.push(entry);
      seen.add(entry.stockCode);
    }
  }
  return out;
}
