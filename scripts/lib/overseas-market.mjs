/**
 * 해외 종목 시장 판별·이름→티커 공통 lib(오너 지시 2026-09-27 — "이름 티커로 잡고 일본 대만 유럽은 각각으로 분류.
 * 대만은 중국에 포함"). 증권사 제목의 "종목명 (TICKER.US)"·"(GM US)"·"(TSM.NY)"·"(7203.JP)"·"(2330.TT)"·"(OR FP)"
 * 같은 표기에서 시장(us/jp/ch/eu)을 가른다. 미국이 아닌 종목을 "kr 산업"으로 흘리지 않기 위한 공통 규칙.
 *
 * 시장 구분: 미국 us / 일본 jp / 중국·홍콩·대만 ch(대만 포함) / 유럽 eu. 그 밖의 거래소(사우디 "AB" 등)는 null —
 * 지어내지 않는다. 종목 표기가 없는 글은 parseOverseasTitle 이 null 을 준다.
 */

// 거래소 접미사(점 표기 .XX 또는 블룸버그식 공백 XX) → 시장
const SUFFIX_MARKET = {
  // 미국
  US: "us", UN: "us", UW: "us", UQ: "us", UA: "us", NY: "us", O: "us", N: "us", OQ: "us", K: "us",
  // 일본
  JP: "jp", JT: "jp", T: "jp",
  // 중국·홍콩·대만(대만은 중국에 포함)
  CH: "ch", HK: "ch", SS: "ch", SZ: "ch", CN: "ch", TT: "ch", TW: "ch", TWO: "ch",
  // 유럽
  FP: "eu", GY: "eu", IM: "eu", NA: "eu", LN: "eu", SW: "eu", SM: "eu", DC: "eu", NO: "eu", FH: "eu", BB: "eu", ID: "eu", AV: "eu", PL: "eu",
  HE: "eu", PA: "eu", DE: "eu", MI: "eu", L: "eu", AS: "eu", ST: "eu", CO: "eu", OL: "eu", MC: "eu", BR: "eu", LS: "eu", VI: "eu", IR: "eu",
};

export function marketFromExchangeSuffix(sfx) {
  return SUFFIX_MARKET[String(sfx ?? "").toUpperCase()] ?? null;
}

// "이름 (TICKER.SFX): 헤드라인" 또는 "이름 (TICKER SFX): 헤드라인"
const TITLE_RE = /^(.+?)\s*\(([A-Z0-9][A-Z0-9-]{0,7})(?:\.([A-Z]{1,3})|\s+([A-Z]{1,3}))\)\s*[:：]\s*(.+)$/;

/**
 * 제목에서 해외 종목을 뽑는다 → { name, ticker, suffix, market, symbol, headline } | null.
 * symbol: 미국은 티커 그대로("AAPL"), 그 외는 "7203.JP"·"2330.TT"·"OR.FP"처럼 접미사 포함(앱의 다른 해외 수집기와 동일).
 * 거래소를 모르는 접미사(예: "2222 AB")는 null — 지어내지 않는다.
 */
export function parseOverseasTitle(title) {
  const m = String(title ?? "").trim().match(TITLE_RE);
  if (!m) return null;
  const [, name, ticker, dot, space, headline] = m;
  const suffix = dot ?? space;
  const market = marketFromExchangeSuffix(suffix);
  if (!market) return null;
  return {
    name: name.trim(), ticker, suffix, market, headline: headline.trim(),
    symbol: market === "us" ? ticker : `${ticker}.${suffix}`,
  };
}

/**
 * 산업 리포트 라벨이 국가명으로 시작하면 그 나라 시장이다("중국 자동차 판매동향" → ch, "일본 …" → jp, "미국 …" → us, "유럽 …" → eu).
 * 국내 산업분석 게시판 글이 라벨로 해외 업종을 다룰 때 kr 로 흘리지 않기 위한 공통 규칙(오너 지시 2026-09-27 — "중국 자동차 판매 동향은 중국 자동차 산업분석이다").
 * 라벨 첫머리만 본다 — 제목 내용으로 나라를 추측하지 않는다(한국 업종 글이 "중국 소비 회복" 같은 제목을 달 수 있다). 모르면 null.
 */
export function marketFromLabel(label) {
  const l = String(label ?? "").trim();
  if (/^(?:중국|차이나)(?!집)/.test(l) || /^China\b/i.test(l)) return "ch";
  if (/^(?:일본|Japan)/i.test(l)) return "jp";
  if (/^(?:미국|USA?\b)/i.test(l)) return "us";
  if (/^(?:유럽|Europe)/i.test(l)) return "eu";
  return null;
}

/**
 * 제목이 "중국 …"으로 시작하는 산업 리포트도 중국 시장(오너 지시 2026-09-27 — "중국 전기차 글은 중국 산업이 맞다": 하나 "중국 전기차, 지금은 배로
 * 2027년부터는 공장에서"는 라벨이 그냥 "자동차"). 중국만 적용한다 — 미국·일본은 "미국 금리 인하와 은행"처럼 제목 머리가 나라여도 국내 업종 글인 경우가 많고,
 * "일본과 한국의 공작기계…"처럼 나라 뒤에 조사가 붙은 제목은 여러 나라 이야기라 제외(뒤에 한글이 바로 오면 안 됨).
 */
export function marketFromTitleLead(title) {
  return /^\s*중국(?![가-힣])/.test(String(title ?? "")) ? "ch" : null;
}

const NATION_MARKET = {
  USA: "us", JPN: "jp", CHN: "ch", HKG: "ch", TWN: "ch",
  FRA: "eu", DEU: "eu", GBR: "eu", ITA: "eu", NLD: "eu", CHE: "eu", ESP: "eu", SWE: "eu", DNK: "eu",
  NOR: "eu", FIN: "eu", BEL: "eu", IRL: "eu", AUT: "eu", PRT: "eu", LUX: "eu", POL: "eu",
};

const cache = new Map();
/**
 * 종목명 → 티커(네이버 해외종목 자동완성 — DS 수집기와 같은 엔드포인트). 이름이 정확히 같거나 첫 결과의
 * 이름이 검색어로 시작할 때만 인정한다(엉뚱한 회사 매칭 방지). 미국(USA)만 자동 인정 — 그 밖의 국가는 접미사 표기가 있을
 * 때만 시장을 정한다. 반환: { symbol, stockName, market } | null.
 */
export async function resolveUsTickerByName(name, { sleepMs = 300 } = {}) {
  const key = String(name ?? "").trim();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let hit = null;
  try {
    const res = await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(key)}&target=stock`, {
      headers: { "User-Agent": "Mozilla/5.0", accept: "application/json" },
    });
    if (res.ok) {
      const items = (await res.json()).items ?? [];
      const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
      const k = norm(key);
      const m = items.find((i) => NATION_MARKET[i.nationCode] === "us" && !/\s/.test(String(i.code ?? "")) && norm(i.name).startsWith(k));
      if (m?.code) hit = { symbol: String(m.code).toUpperCase(), stockName: String(m.name ?? key).replace(/\s+/g, " ").trim(), market: "us" };
    }
  } catch {
    /* 실패하면 null */
  }
  cache.set(key, hit);
  await new Promise((r) => setTimeout(r, sleepMs));
  return hit;
}
