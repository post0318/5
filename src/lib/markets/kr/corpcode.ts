import "server-only";
import { strFromU8, unzipSync } from "fflate";
import { AdapterError } from "../types";

/**
 * OpenDART corpCode.xml (ZIP) → stock_code ↔ corp_code 매핑.
 * 약 28MB XML, 10만+ 법인. 프로세스 메모리에 캐시 (24h).
 */

export interface CorpEntry {
  corpCode: string;
  corpName: string;
  corpEngName: string;
  stockCode: string;
}

interface CorpIndex {
  byStock: Map<string, CorpEntry>;
  byName: { name: string; entry: CorpEntry }[];
  loadedAt: number;
}

let index: CorpIndex | null = null;
const TTL = 1000 * 60 * 60 * 24;

const LIST_RE =
  /<list>\s*<corp_code>([^<]*)<\/corp_code>\s*<corp_name>([^<]*)<\/corp_name>\s*<corp_eng_name>([^<]*)<\/corp_eng_name>\s*<stock_code>([^<]*)<\/stock_code>/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function build(apiKey: string): Promise<CorpIndex> {
  const res = await fetch(
    `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) {
    throw new AdapterError(`corpCode 다운로드 실패 (${res.status})`, { status: 502 });
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  // 응답이 실제로는 JSON 에러(키 오류 등)일 수 있음
  if (buf[0] === 0x7b) {
    throw new AdapterError("OpenDART corpCode 응답 오류 — API 키를 확인하세요", { status: 401 });
  }
  const files = unzipSync(buf);
  const xmlName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".xml"));
  if (!xmlName) throw new AdapterError("corpCode ZIP에 XML이 없습니다", { status: 502 });
  const xml = strFromU8(files[xmlName]);

  const byStock = new Map<string, CorpEntry>();
  const byName: CorpIndex["byName"] = [];
  let m: RegExpExecArray | null;
  LIST_RE.lastIndex = 0;
  while ((m = LIST_RE.exec(xml))) {
    const stockCode = m[4].trim();
    const entry: CorpEntry = {
      corpCode: m[1].trim(),
      corpName: decodeEntities(m[2]),
      corpEngName: decodeEntities(m[3]),
      stockCode,
    };
    if (stockCode && /^\d{6}$/.test(stockCode)) {
      byStock.set(stockCode, entry);
      byName.push({ name: entry.corpName.toLowerCase(), entry });
      if (entry.corpEngName) {
        byName.push({ name: entry.corpEngName.toLowerCase(), entry });
      }
    }
  }
  return { byStock, byName, loadedAt: Date.now() };
}

export async function getCorpIndex(apiKey: string): Promise<CorpIndex> {
  if (index && Date.now() - index.loadedAt < TTL) return index;
  index = await build(apiKey);
  return index;
}

export async function resolveCorpCode(apiKey: string, stockCode: string): Promise<CorpEntry> {
  const idx = await getCorpIndex(apiKey);
  const entry = idx.byStock.get(stockCode);
  if (!entry) {
    throw new AdapterError(`DART에서 종목코드를 찾을 수 없습니다: ${stockCode}`, { status: 404 });
  }
  return entry;
}

export async function searchCorps(apiKey: string, query: string): Promise<CorpEntry[]> {
  const idx = await getCorpIndex(apiKey);
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: CorpEntry[] = [];
  const contains: CorpEntry[] = [];
  const seen = new Set<string>();
  for (const { name, entry } of idx.byName) {
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
