/**
 * 검증기 KRX 원자료(한국 시가총액) — 앱(src/lib/markets/quote/krx.ts)과 무관하게 KRX OPEN API 를 직접 부른다.
 *  - 일별 전종목 시세(stk_bydd_trd·ksq_bydd_trd): 종목별 MKTCAP·종가·상장주식수
 *  - 종목 기본정보(stk_isu_base_info·ksq_isu_base_info): 주식 종류(보통주·구형우선주·신형우선주) — 우선주 판정을 앱의 "이름이 보통주 이름으로
 *    시작하고 '우'" 규칙과 다르게 KRX 가 준 주식 종류로 한다(같은 발행사 = 단축코드 앞 5자리)
 * 지난 날짜는 불변이라 디스크 캐시(오늘·최근 7일의 빈 응답은 캐시하지 않음 — 아직 게시 전일 수 있다). 조회 실패는 던진다.
 */
const BASE = "https://data-dbg.krx.co.kr/svc/apis/sto";
let KEY = null, CACHE = null;
export const krxStats = { requests: 0 };
export function configureKrx({ key, cache }) {
  KEY = key;
  CACHE = cache;
}
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
const num = (v) => (v == null || String(v).trim() === "" || v === "-" ? null : Number(String(v).replace(/,/g, "")));

async function fetchSvc(svc, basDd) {
  if (!KEY) throw new Error("KRX_API_KEY 미설정");
  for (let i = 0; ; i++) {
    try {
      krxStats.requests++;
      const r = await fetch(`${BASE}/${svc}?basDd=${basDd}`, { headers: { AUTH_KEY: KEY }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`KRX ${svc} ${basDd} HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j.OutBlock_1)) throw new Error(`KRX ${svc} ${basDd} 응답 형식 이상`);
      return j.OutBlock_1;
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise((res) => setTimeout(res, [1000, 3000, 9000][i]));
    }
  }
}

const memo = new Map();
/** 날짜 하루의 전종목 — Map(단축코드 → { n, close, mcap, shares, kind }) — kind 는 기본정보의 주식 종류. 휴장일은 빈 맵 */
export function krxDay(basDd) {
  if (!memo.has(basDd)) memo.set(basDd, (async () => {
    const today = kstToday();
    const toD = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
    const recent = (toD(today) - toD(basDd)) / 864e5 < 8;
    const cached = basDd < today && CACHE ? CACHE.get("krx-day", basDd, "v1") : undefined;
    if (cached !== undefined) return new Map(cached);
    const [k1, k2] = await Promise.all([fetchSvc("stk_bydd_trd", basDd), fetchSvc("ksq_bydd_trd", basDd)]);
    const rows = [...k1, ...k2];
    const m = new Map();
    if (rows.length) {
      const [b1, b2] = await Promise.all([fetchSvc("stk_isu_base_info", basDd), fetchSvc("ksq_isu_base_info", basDd)]);
      const kind = new Map([...b1, ...b2].map((r) => [String(r.ISU_SRT_CD).trim(), String(r.KIND_STKCERT_TP_NM ?? "").trim()]));
      for (const r of rows) {
        const c = String(r.ISU_CD).trim();
        m.set(c, { n: String(r.ISU_NM).trim(), close: num(r.TDD_CLSPRC), mcap: num(r.MKTCAP), shares: num(r.LIST_SHRS), kind: kind.get(c) ?? null });
      }
    }
    // 오늘은 캐시 안 함. 빈 날(휴장 또는 아직 게시 전)은 8일 지난 뒤에만
    if (basDd < today && CACHE && (m.size || !recent)) CACHE.put("krx-day", basDd, "v1", [...m]);
    return m;
  })());
  return memo.get(basDd);
}

const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
/**
 * 날짜(YYYYMMDD) 당일 또는 그 이전 가장 가까운 거래일의 보통주·우선주 시가총액. 상한 10일. 그 종목이 없으면(상장 전) null
 * 우선주 = 같은 발행사(단축코드 앞 5자리)이면서 KRX 주식 종류가 "…우선주" 인 종목들의 MKTCAP 합
 */
export async function krxCapsOn(code, dateYmd, { maxBack = 10 } = {}) {
  const d = new Date(Date.UTC(Number(dateYmd.slice(0, 4)), Number(dateYmd.slice(4, 6)) - 1, Number(dateYmd.slice(6, 8))));
  for (let i = 0; i < maxBack; i++, d.setUTCDate(d.getUTCDate() - 1)) {
    const basDd = ymd(d);
    if (basDd > kstToday()) continue;
    const day = await krxDay(basDd);
    if (!day.size) continue;
    const c = day.get(code);
    if (!c) return { date: basDd, common: null, preferred: null, close: null, prefIssues: [], tradingDay: true };
    const prefs = [...day].filter(([k, v]) => k !== code && k.slice(0, 5) === code.slice(0, 5) && /우선주/.test(v.kind ?? ""));
    if (prefs.some(([, v]) => v.mcap == null)) throw new Error(`KRX ${basDd} 우선주 시가총액 빈 값`);
    return {
      date: basDd,
      common: c.mcap,
      close: c.close,
      shares: c.shares,
      preferred: prefs.reduce((a, [, v]) => a + v.mcap, 0),
      prefIssues: prefs.map(([k, v]) => `${k} ${v.n}`),
      kindOk: c.kind != null,
    };
  }
  return null;
}
