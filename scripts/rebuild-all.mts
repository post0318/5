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
  meritz: ["메리츠증권", "메리츠증권_비상장리서치"],
  mirae: ["미래에셋증권"],
  samsung: ["삼성증권", "삼성증권_비상장리서치"],
  sangsangin: ["상상인증권"],
  shinhan: ["신한투자증권", "신한투자증권_비상장리서치"],
  yuanta: ["유안타증권"],
  kiwoom: ["키움증권", "키움증권_비상장리서치"],
  hana: ["하나증권"],
  kis: ["한국투자증권"],
  hanwha: ["한화투자증권"],
  gm: ["DB증권", "LS증권", "FRB", "국민은행", "SK증권", "신영증권", "유진투자증권", "현대차증권", "흥국증권"],
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
  // 같은 (source, id) 기준 중복 제거(오너 지적 2026-09-27 — DS "의 미국 방산 사업 본격화" 2건 중복). 캡처는
  // append 전용이라 재수집으로 stockName 등이 바뀌어도 옛 줄이 파일에 남는다 — **가장 나중에 쓰인 줄**(최신
  // 수집기 코드 반영분)이 이기도록 먼저 (source,id) 로 원본 아이템만 모으고, 분류는 그 뒤에 한 번만 한다
  // (오너 지적 2026-09-27 — KB "이그전" 재분류가 옛 캡처에 밀려 안 먹히던 문제).
  const latestById = new Map<string, { it: Item; source: string; market?: string }>();
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
        latestById.set(`${b.source}:${it.id}`, { it, source: b.source, market: b.market });
      }
    }
  }
  for (const { it, source, market: itemMarket } of latestById.values()) {
    const cat = it.category ?? "기업";
    if (isCommonExcludedResearch(`${it.stockName ?? ""} ${it.title ?? ""}`, cat)) continue;
    // KB "금리 전망 테이블"(collect-kb-research.mjs RATE_TABLE_RE) — 캡처가 그 수집기 수정 전에 떠서 여기서도 걸러준다.
    if (/^금리\s*전망\s*테이블$/.test(String(it.title ?? "").trim())) continue;
    // KB "KB Asset Compass" 시리즈(collect-kb-research.mjs EXCLUDED_TAB2_SERIES_RE) — 캡처엔 시리즈명(docTitle)이
    // title 에 없고 PDF 발췌 요약에만 남아있어 그걸로 판별(오너 결정 2026-09-27 — "KB Asset Compass 수집제외").
    if (/KB\s*Asset\s*Compass/i.test(String(it.summary ?? ""))) continue;
    // NH "모닝미팅브리프"(collect-nh-research.mjs STRATEGY_BOARDS에서 이미 제외) — 캡처 파일엔 그 수정 전
    // 라인이 그대로 남아있어(누적 append, 재수집해도 옛 줄이 안 지워짐) 여기서 한 번 더 걸러야 한다
    // (오너 지적 2026-09-27 — "수집제외라고 했잖아").
    if (/모닝미팅브리프/.test(it.board ?? "")) continue;
    // KB "글로벌기업 | 포트폴리오+"(collect-kb-research.mjs classifyGlobalRow에서 이미 제외) — 이 항목은
    // 제외 이후 재수집에서 아예 전송 자체가 안 되므로 캡처 파일엔 제외 전 옛 줄만 남아있다(오너 지적
    // 2026-09-27 — "수집제외라고 했는데").
    if (/글로벌기업\s*\|\s*포트폴리오\+?/i.test(it.stockName ?? "")) continue;
    // 한국투자증권 "해외주식 369"(collect-kis-research.mjs에서 이미 제외) — 제외 전 캡처된 옛 줄만 남아있음.
    if (/^해외주식\s*369$/.test(String(it.stockName ?? it.title ?? "").trim())) continue;
    // 메리츠 "N월 N반월 LCD 패널가"(collect-meritz-research.mjs에서 이미 제외) — 제외 전 캡처된 옛 줄만 남아있음.
    if (/^\d{1,2}월\s*(?:상|하)반월\s*LCD\s*패널가$/.test(String(it.title ?? "").trim())) continue;
    // 메리츠 정기 데일리 시리즈(collect-meritz-research.mjs에서 이미 제외) — 제외 전 캡처된 옛 줄만 남아있음.
    if (/^Meritz\s*Overnight\s*Tech\b/i.test(String(it.title ?? "").trim())) continue;
    if (/^Mobility\s*at\s*a\s*glance\b/i.test(String(it.title ?? "").trim())) continue;
    if (/^Morning\s*Talk\b/i.test(String(it.title ?? "").trim())) continue;
    if (/^Daily\s*\(\d{4}[.\s]*\d{1,2}[.\s]*\d{1,2}\)$/i.test(String(it.title ?? "").trim())) continue;
    // 메리츠 "AI 스타트업의 확산..."(비상장으로 재분류) — source="메리츠증권"(구 산업분석)로 남은 옛 줄은 버리고
    // source="메리츠증권 비상장리서치" 줄만 남긴다(오너 지적 2026-09-27 — "AI 스타트업의 확산 국내 비상장이다").
    if (source === "메리츠증권" && String(it.title ?? "").trim() === "AI 스타트업의 확산, 누가 돈을 벌 것인가?") continue;
    const MARKETS = ["kr", "us", "jp", "ch", "eu"] as const;
    const postMarket = MARKETS.find((m) => m === itemMarket) ?? "kr";
    const market = postMarket === "kr" && cat === "산업" ? (marketFromIndustryLabel(it.stockName ?? "") ?? marketFromTitleLead(it.title ?? "") ?? postMarket) : postMarket;
    let dest: string;
    if (/비상장리서치$/.test(source)) dest = `${market} 비상장`;
    else if ((INSIGHT_SOURCES as readonly string[]).includes(source)) dest = `${market} 인사이트`;
    else if (cat === "기업") dest = `${market} 종목분석`;
    else {
      const stockName = normalizeIndustryLabel(it.stockName);
      const t = classifyResearchTopic({ stockName, title: it.title ?? "", source, market, summary: it.summary ?? "" });
      const sector = classifySector({ stockName, title: it.title ?? "", summary: it.summary ?? "" }) ?? "기타";
      dest = t === "산업분석" ? `${market} 산업분석 — ${sector}` : t === "글로벌IB" ? `${market} 산업분석(글로벌IB) — ${sector}` : t === "비상장" ? `${market} 비상장`
        : t === "이슈분석" ? "거시경제 이슈분석" : t === "환율분석" ? "거시경제 환율분석"
        : t === "시황분석:Daily" ? "거시경제 시황분석(Daily)" : t === "시황분석:Monthly" ? "거시경제 시황분석(Monthly)" : `${market} 산업분석(투자전략)`;
    }
    const displayS = cat === "기업" ? (it.symbol ?? it.stockName ?? "") : normalizeIndustryLabel(it.stockName ?? "") ?? "";
    rows.push({ d: it.date ?? "", s: displayS, op: it.opinion ?? "", tp: it.targetPrice ?? null, t: it.title ?? "", an: it.analyst ?? "", src: source, bd: collapseDupSegments(it.board ?? ""), dest });
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
