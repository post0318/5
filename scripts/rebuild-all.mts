import { readFileSync } from "node:fs";
import { classifyResearchTopic, INSIGHT_SOURCES } from "../src/lib/db/shinhan-research";
import { isCommonExcludedResearch } from "../src/lib/research-exclude";
import { normalizeIndustryLabel, marketFromIndustryLabel, marketFromTitleLead, classifySector } from "../src/lib/research-sector";

const capture = process.argv.find((a) => a.startsWith("--capture="))?.split("=")[1];
if (!capture) { console.error("--capture=<dir> 필요"); process.exit(2); }

// DATA key -> jsonl basenames (파일명 언더스코어는 공백/원표기 그대로) that feed it
const KEY_FILES: Record<string, string[]> = {
  bnk: ["BNK투자증권"],
  ds: ["DS투자증권"],
  ibk: ["IBK투자증권"],
  kb: ["KB증권", "KB증권_비상장리서치"],
  nh: ["NH투자증권"],
  im: ["iM증권"],
  kyobo: ["교보증권"],
  daishin: ["대신증권"],
  meritz: ["메리츠증권"],
  mirae: ["미래에셋증권"],
  samsung: ["삼성증권", "삼성증권_비상장리서치"],
  sangsangin: ["상상인증권"],
  shinhan: ["신한투자증권", "신한투자증권_비상장리서치"],
  yuanta: ["유안타증권"],
  kiwoom: ["키움증권", "키움증권_비상장리서치"],
  hana: ["하나증권"],
  kis: ["한국투자증권"],
  hanwha: ["한화투자증권"],
};

type Item = { id?: string; title?: string; stockName?: string; symbol?: string; category?: string; summary?: string; opinion?: string; targetPrice?: number | null; analyst?: string; board?: string; date?: string };
type Row = { d: string; s: string; op: string; tp: number | null; t: string; an: string; src: string; bd: string };
type RowD = Row & { dest: string };

// KB "board" 표시 문자열의 연속 중복 세그먼트를 접는다(collect-kb-research.mjs foldTemplate 과 동일 —
// 캡처가 그 수정 전에 떠서 원본 board 텍스트에 중복이 남아있다, 오너 지적 2026-09-27).
function collapseDupSegments(board: string): string {
  const m = board.match(/^(.*> )([^(]*)(\(.*)$/);
  if (!m) return board;
  const segs = m[2].split(">").map((s) => s.trim());
  const out: string[] = [];
  for (const s of segs) if (s && out[out.length - 1] !== s) out.push(s);
  return `${m[1]}${out.join(">")}${m[3]}`;
}

function rowsForFiles(basenames: string[]): RowD[] {
  const rows: RowD[] = [];
  // 같은 항목이 --days 를 넓혀 여러 번 재수집되면 캡처 파일에 중복 줄로 쌓인다 — verify-classification.mts 와
  // 같은 (source, id) 기준 중복 제거(오너 지적 2026-09-27 — DS "의 미국 방산 사업 본격화" 2건 중복).
  const seen = new Set<string>();
  for (const base of basenames) {
    const path = `${capture}/research/${base}.jsonl`;
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      console.error(`  (건너뜀: ${base}.jsonl 없음)`);
      continue;
    }
    for (const l of lines) {
      let b: { items?: Item[]; source: string; market?: string };
      try { b = JSON.parse(l); } catch { continue; }
      if (!Array.isArray(b.items)) continue;
      for (const it of b.items) {
        const key = `${b.source}:${it.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cat = it.category ?? "기업";
        if (isCommonExcludedResearch(`${it.stockName ?? ""} ${it.title ?? ""}`, cat)) continue;
        // KB "금리 전망 테이블"(collect-kb-research.mjs RATE_TABLE_RE) — 캡처가 그 수집기 수정 전에 떠서 여기서도 걸러준다.
        if (/^금리\s*전망\s*테이블$/.test(String(it.title ?? "").trim())) continue;
        // KB "KB Asset Compass" 시리즈(collect-kb-research.mjs EXCLUDED_TAB2_SERIES_RE) — 캡처엔 시리즈명(docTitle)이
        // title 에 없고 PDF 발췌 요약에만 남아있어 그걸로 판별(오너 결정 2026-09-27 — "KB Asset Compass 수집제외").
        if (/KB\s*Asset\s*Compass/i.test(String(it.summary ?? ""))) continue;
        const MARKETS = ["kr", "us", "jp", "ch", "eu"] as const;
        const postMarket = MARKETS.find((m) => m === b.market) ?? "kr";
        const market = postMarket === "kr" && cat === "산업" ? (marketFromIndustryLabel(it.stockName ?? "") ?? marketFromTitleLead(it.title ?? "") ?? postMarket) : postMarket;
        let dest: string;
        if (/비상장리서치$/.test(b.source)) dest = `${market} 비상장`;
        else if ((INSIGHT_SOURCES as readonly string[]).includes(b.source)) dest = `${market} 인사이트`;
        else if (cat === "기업") dest = `${market} 종목분석`;
        else {
          const stockName = normalizeIndustryLabel(it.stockName);
          const t = classifyResearchTopic({ stockName, title: it.title ?? "", source: b.source ?? "", market, summary: it.summary ?? "" });
          const sector = classifySector({ stockName, title: it.title ?? "", summary: it.summary ?? "" }) ?? "기타";
          dest = t === "산업분석" ? `${market} 산업분석 — ${sector}` : t === "글로벌IB" ? `${market} 산업분석(글로벌IB) — ${sector}` : t === "비상장" ? `${market} 비상장`
            : t === "이슈분석" ? "거시경제 이슈분석" : t === "환율분석" ? "거시경제 환율분석"
            : t === "시황분석:Daily" ? "거시경제 시황분석(Daily)" : t === "시황분석:Monthly" ? "거시경제 시황분석(Monthly)" : `${market} 산업분석(투자전략)`;
        }
        const displayS = cat === "기업" ? (it.symbol ?? it.stockName ?? "") : normalizeIndustryLabel(it.stockName ?? "") ?? "";
        rows.push({ d: it.date ?? "", s: displayS, op: it.opinion ?? "", tp: it.targetPrice ?? null, t: it.title ?? "", an: it.analyst ?? "", src: b.source, bd: collapseDupSegments(it.board ?? ""), dest });
      }
    }
  }
  return rows;
}

const out: Record<string, unknown> = {};
for (const [key, files] of Object.entries(KEY_FILES)) {
  const rows = rowsForFiles(files);
  const groups = new Map<string, RowD[]>();
  for (const r of rows) {
    if (!groups.has(r.dest)) groups.set(r.dest, []);
    groups.get(r.dest)!.push(r);
  }
  const groupArr = [...groups.entries()]
    .map(([dest, items]) => ({
      dest,
      n: items.length,
      items: items
        .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
        .map((item): Row => ({ d: item.d, s: item.s, op: item.op, tp: item.tp, t: item.t, an: item.an, src: item.src, bd: item.bd })),
    }))
    .sort((a, b) => b.n - a.n);
  let totalResearch = 0, totalMacro = 0;
  for (const g of groupArr) { if (g.dest.startsWith("거시경제 ")) totalMacro += g.n; else totalResearch += g.n; }
  out[key] = { totalResearch, totalMacro, groups: groupArr };
  console.error(`  ${key}: totalResearch=${totalResearch} totalMacro=${totalMacro} groups=${groupArr.length}`);
}

console.log(JSON.stringify(out));
