/**
 * 국내 상장사명 매칭 공통 lib — "산업" 게시판에 올라온 리포트 제목이 실은
 * 특정 종목 얘기일 때 종목분석(category:"기업")으로 승격하기 위한 판정.
 * 예: 상상인 산업리포트 "조선 | HD현대중공업 증설 공시 코멘트"(오너 지적
 * 2026-09-26 — "리서치센터 종목인데?"), 한경 컨센서스 IN/MA 분류의 메리츠
 * "HD현대중공업의 엔진 증설 발표…". 한경 수집기에만 있던 로직을 공통 lib로 뺐다.
 *
 * "제목이 그 이름으로 시작하는 것 중 가장 긴 이름"을 corpcodes.json(3,930개,
 * DART_API_KEY 불필요)에서 찾는다. startsWith만으로는 "신흥국 실적 상향…"이
 * 상장사 "신흥"(004080)에 우연히 겹쳐 오매칭되므로, 매칭 뒤 남는 글자가 없거나
 * 공백/구두점/영숫자이거나 한글 조사(의/은/는…)로만 이어질 때 인정한다.
 * 해외 개별종목은 다루지 않는다(네이버 자동완성 해석이 필요해 비용·오탐 위험이 큼).
 */
import { readFileSync } from "node:fs";

const CORPS = JSON.parse(
  readFileSync(new URL("../../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
).sort((a, b) => b.n.length - a.n.length);

export const KR_PARTICLES = ["의", "은", "는", "이", "가", "을", "를", "과", "와", "도", "만", "에", "께", "이나", "나", "라도", "마저", "조차", "밖에", "부터", "까지", "로", "으로"];

/** 제목이 국내 상장사명으로 시작하면 { symbol, stockName }, 아니면 null. */
export function resolveKrStock(text) {
  const t = String(text ?? "").trim();
  for (const c of CORPS) {
    if (!t.startsWith(c.n)) continue;
    const rest = t.slice(c.n.length);
    if (!rest || !/^[가-힣]/.test(rest)) return { symbol: c.s, stockName: c.n };
    const particle = KR_PARTICLES.find((p) => rest.startsWith(p));
    if (particle && !/^[가-힣]/.test(rest.slice(particle.length))) return { symbol: c.s, stockName: c.n };
  }
  return null;
}

/** 승격 후 제목에서 회사명과 뒤따르는 조사·구분자를 떼어 낸 헤드라인. */
export function headlineAfterCompany(title, stockName) {
  let rest = String(title ?? "").trim().slice(stockName.length);
  const particle = KR_PARTICLES.find((p) => rest.startsWith(p));
  if (particle) rest = rest.slice(particle.length);
  return rest.replace(/^[\s\-–—:,]+/, "").trim();
}

/**
 * 산업 게시판 항목을 종목분석으로 승격(공통 판정) — 수집기가 항목을 다 만든 뒤, 목표주가
 * 추출·전송 전에 한 번 통과시킨다. 국내(market kr) 산업 항목 중
 *   ① 라벨(stockName)이 상장사명과 정확히 같거나(KB "SK이노베이션"),
 *   ② 대괄호 없는 제목이 상장사명으로 시작(메리츠 "HD현대중공업의 엔진 증설 발표…",
 *      IBK "엘앤에프 Investor Day 2026 후기")
 * 하면 category:"기업"·symbol 로 바꾼다. 이미 종목이거나 symbol 이 있으면 그대로.
 * 업종 얘기(삼성전자 위상 강화가 무선장비 업체에 호재 등 라벨이 업종인 애매한 경우)까지
 * 잡지 않도록 ②는 제목 첫머리 매칭만 쓴다 — 애매한 건 산업분석에 둔다(오너 확인 2026-09-26).
 */
const CORP_BY_NAME = new Map(CORPS.map((c) => [c.n, c]));
export function promoteKrIndustryToStock(item) {
  if (!item || item.category !== "산업" || item.symbol) return item;
  if ((item.market ?? "kr") !== "kr") return item;
  const byLabel = CORP_BY_NAME.get(String(item.stockName ?? "").trim());
  if (byLabel) return { ...item, category: "기업", stockName: byLabel.n, symbol: byLabel.s };
  const title = String(item.title ?? "").trim();
  if (title.startsWith("[")) return item;
  const hit = resolveKrStock(title);
  if (!hit) return item;
  return {
    ...item,
    category: "기업",
    stockName: hit.stockName,
    symbol: hit.symbol,
    title: headlineAfterCompany(title, hit.stockName) || title,
  };
}
