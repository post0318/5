/**
 * 리서치 분류 정답 표 검증 — scripts/golden/research-classification.golden.json 의 각 사례가
 * 최신 수집 결과에서 정해진 분류(또는 제외)가 되는지 본다. 수집기 출력(items)에 앱 서버의 공통 제외·
 * 분류 함수(classifyResearchTopic)를 그대로 적용한다 — 대조표를 만드는 것과 같은 경로.
 *
 * 실행: NODE_OPTIONS="--require <server-only 스텁>" npx tsx scripts/verify-classification.mts --capture=<dir>
 *   <dir>/research/*.jsonl 은 수집기가 POST 한 본문({items,source,market}) 줄들.
 * 정답 표에 사례를 추가할 때는 오너가 확인해 준 것만 넣는다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { classifyResearchTopic, classifyIssueKind, INSIGHT_SOURCES } from "../src/lib/db/shinhan-research";
import { isCommonExcludedResearch } from "../src/lib/research-exclude";
import { normalizeIndustryLabel, INDUSTRY_LABEL_SYNONYMS, ANALYST_SECTOR } from "../src/lib/research-sector";
import { normalizeSectorLabel } from "./lib/sector-label.mjs";

const capture = process.argv.find((a) => a.startsWith("--capture="))?.split("=")[1];
if (!capture) { console.error("--capture=<디렉터리> 필요"); process.exit(2); }
const golden = JSON.parse(readFileSync(new URL("./golden/research-classification.golden.json", import.meta.url), "utf8"));

type Item = { id?: string; title?: string; stockName?: string; category?: string; summary?: string };
type Row = { source: string; market: string; it: Item; dest: string };
const rows: Row[] = [];
const dir = `${capture}/research`;
for (const f of readdirSync(dir)) for (const l of readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").filter(Boolean)) {
  let b: { items?: Item[]; source: string; market?: string }; try { b = JSON.parse(l); } catch { continue; }
  if (!Array.isArray(b.items)) continue;
  const items = b.items;
  const MARKETS = ["kr", "us", "jp", "ch", "eu"] as const;
  const market = MARKETS.find((m) => m === b.market) ?? "kr";
  for (const it of items) {
    const cat = it.category ?? "기업";
    if (isCommonExcludedResearch(`${it.stockName ?? ""} ${it.title ?? ""}`, cat)) continue;
    let dest: string;
    if (/비상장리서치$/.test(b.source)) dest = `${market} 비상장`;
    else if ((INSIGHT_SOURCES as readonly string[]).includes(b.source)) dest = `${market} 인사이트`;
    else if (cat === "기업") dest = `${market} 종목분석`;
    else {
      const t = classifyResearchTopic({ stockName: it.stockName ?? "", title: it.title ?? "", source: b.source ?? "", market, summary: it.summary ?? "" });
      dest = t === "산업분석" ? `${market} 산업분석` : t === "글로벌IB" ? `${market} 산업분석(글로벌IB)` : t === "비상장" ? `${market} 비상장`
        : t === "이슈분석" ? "거시경제 이슈분석" : t === "환율분석" ? "거시경제 환율분석"
        : t === "시황분석:Daily" ? "거시경제 시황분석(Daily)" : t === "시황분석:Monthly" ? "거시경제 시황분석(Monthly)" : "거시경제 시황분석(투자전략)";
    }
    // 서버 수신 라우트와 같은 업종 라벨 정규화(표준 이름).
    if (cat === "산업") it.stockName = normalizeIndustryLabel(it.stockName);
    rows.push({ source: b.source, market, it, dest });
  }
}
// 같은 (source,id) 중복 제거
const seen = new Set<string>(); const uniq = rows.filter((r) => { const k = `${r.source}:${r.it.id}`; if (seen.has(k)) return false; seen.add(k); return true; });

let pass = 0, fail = 0, na = 0;
for (const c of golden.cases) {
  const hits = uniq.filter((r) => (r.source === c.source || r.source.startsWith(c.source)) &&
    (c.titleIncludes ? String(r.it.title ?? "").includes(c.titleIncludes) || String(r.it.stockName ?? "").includes(c.titleIncludes) : true) &&
    (c.stockName ? r.it.stockName === c.stockName : true) &&
    (c.market ? r.market === c.market : true));
  if (c.expect === "EXCLUDE") {
    if (hits.length === 0) { pass++; console.log(`✔ ${c.id} 제외됨 — ${c.why}`); }
    else { fail++; console.log(`✘ ${c.id} 제외돼야 하는데 ${hits.length}건 수집됨 (${hits[0].dest}) — ${c.why}`); }
    continue;
  }
  if (hits.length === 0) { na++; console.log(`… ${c.id} 수집 결과에 없음(기간 밖이거나 미수집) — ${c.titleIncludes}`); continue; }
  // kind(경제/채권)가 지정된 사례는 이슈분석 탭의 경제/채권 구분까지 본다.
  const bad = hits.filter((h) => h.dest !== c.expect || (c.label && h.it.stockName !== c.label) || (c.kind && classifyIssueKind({ stockName: h.it.stockName ?? "", title: h.it.title ?? "" }) !== c.kind));
  if (bad.length === 0) { pass++; console.log(`✔ ${c.id} ${c.expect} (${hits.length}건)`); }
  else { fail++; console.log(`✘ ${c.id} 기대 ${c.expect} / 실제 ${bad[0].dest} — ${c.titleIncludes}`); }
}
// 업종 라벨 정규화 — 서버(TS)와 수집기(mjs) 두 구현이 같은 결과를 내는지 검사한다.
let syncBad = 0;
for (const [canon, words] of INDUSTRY_LABEL_SYNONYMS) {
  const variants = [canon, ...words].flatMap((x) => [x, `${x}업`, `대${x}`, `${x}산업`]);
  for (const w of [...variants, ...Object.keys(ANALYST_SECTOR), "비철금속", "정유화학/철강금속/음식료"]) {
    if (normalizeIndustryLabel(w) !== normalizeSectorLabel(w)) {
      syncBad++;
      console.log(`✘ 정규화 불일치(TS≠mjs): ${w} → ${normalizeIndustryLabel(w)} / ${normalizeSectorLabel(w)}`);
    }
  }
}
if (syncBad) fail += syncBad;
else console.log("✔ 업종 라벨 정규화 TS·mjs 구현 일치");

console.log(`\n정답 표 결과: 통과 ${pass} · 실패 ${fail} · 결과 없음 ${na} (총 ${golden.cases.length})`);
process.exit(fail ? 1 : 0);
