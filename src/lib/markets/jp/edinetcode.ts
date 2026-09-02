import "server-only";
import { unzipSync } from "fflate";
import { AdapterError } from "../types";

/**
 * EDINET 코드 목록 (Edinetcode.zip → EdinetcodeDlInfo.csv, Shift-JIS)
 * 証券コード(5자리) ↔ EDINETコード ↔ 제출자명. 키 불필요.
 */

export interface EdinetEntry {
  edinetCode: string;
  /** 4자리 티커 (証券コード 앞 4자리). 비상장이면 "" */
  ticker: string;
  /** 원본 5자리 証券コード */
  secCode: string;
  name: string;
  nameEng: string;
  listed: boolean;
  consolidated: boolean;
  fiscalMonthDay: string; // "3月31日"
  address: string;
  industry: string;
}

interface CodeIndex {
  byTicker: Map<string, EdinetEntry>;
  byEdinet: Map<string, EdinetEntry>;
  all: EdinetEntry[];
  loadedAt: number;
}

let index: CodeIndex | null = null;
const TTL = 1000 * 60 * 60 * 24;

/** 따옴표 지원 CSV 한 줄 파서 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function build(): Promise<CodeIndex> {
  const res = await fetch(
    "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip",
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) {
    throw new AdapterError(`EDINET 코드 목록 다운로드 실패 (${res.status})`, { status: 502 });
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  const csvName = Object.keys(files).find((n) => /\.csv$/i.test(n));
  if (!csvName) throw new AdapterError("EDINET 코드 ZIP에 CSV가 없습니다", { status: 502 });
  const text = new TextDecoder("shift_jis").decode(files[csvName]);

  const lines = text.split(/\r?\n/);
  // 1행: 타이틀, 2행: 헤더
  const byTicker = new Map<string, EdinetEntry>();
  const byEdinet = new Map<string, EdinetEntry>();
  const all: EdinetEntry[] = [];

  for (let i = 2; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = parseCsvLine(lines[i]);
    if (c.length < 13) continue;
    const secCode = c[11].trim();
    const ticker = /^\d{5}$/.test(secCode) ? secCode.slice(0, 4) : "";
    const entry: EdinetEntry = {
      edinetCode: c[0].trim(),
      ticker,
      secCode,
      name: c[6].trim(),
      nameEng: c[7].trim(),
      listed: c[2].includes("上場"),
      consolidated: c[3].includes("有"),
      fiscalMonthDay: c[5].trim(),
      address: c[9].trim(),
      industry: c[10].trim(),
    };
    byEdinet.set(entry.edinetCode, entry);
    if (ticker) byTicker.set(ticker, entry);
    all.push(entry);
  }
  return { byTicker, byEdinet, all, loadedAt: Date.now() };
}

export async function getEdinetCodeIndex(): Promise<CodeIndex> {
  if (index && Date.now() - index.loadedAt < TTL) return index;
  index = await build();
  return index;
}

export async function resolveEdinetByTicker(ticker: string): Promise<EdinetEntry> {
  const idx = await getEdinetCodeIndex();
  const t = ticker.replace(/\.(T|JP)$/i, "").replace(/[^0-9A-Za-z]/g, "");
  const entry = idx.byTicker.get(t);
  if (!entry) {
    throw new AdapterError(`EDINET에서 종목코드를 찾을 수 없습니다: ${ticker}`, { status: 404 });
  }
  return entry;
}

export async function searchEdinet(query: string): Promise<EdinetEntry[]> {
  const idx = await getEdinetCodeIndex();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: EdinetEntry[] = [];
  const contains: EdinetEntry[] = [];
  for (const e of idx.all) {
    if (!e.ticker) continue; // 상장사만
    const hay = `${e.name} ${e.nameEng} ${e.ticker}`.toLowerCase();
    if (e.ticker === q || e.name.toLowerCase().startsWith(q) || e.nameEng.toLowerCase().startsWith(q)) {
      starts.push(e);
    } else if (hay.includes(q)) {
      contains.push(e);
    }
    if (starts.length >= 8) break;
  }
  return [...starts, ...contains].slice(0, 8);
}
