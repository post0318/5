/**
 * 검증기 KRX 원자료(한국 시가총액) — 앱(src/lib/markets/quote/krx.ts)과 무관하게 KRX OPEN API 를 직접 부른다.
 *  - 일별 전종목 시세(stk_bydd_trd·ksq_bydd_trd): 종목별 MKTCAP·종가·상장주식수
 *  - 종목 기본정보(stk_isu_base_info·ksq_isu_base_info): 주식 종류(보통주·구형우선주·신형우선주) — 우선주 판정을 앱의 "이름이 보통주 이름으로
 *    시작하고 '우'" 규칙과 다르게 KRX 가 준 주식 종류로 한다(같은 발행사 = 단축코드 앞 5자리)
 * 지난 날짜는 불변이라 디스크 캐시 — 빈 응답은 휴장일(검증기 달력 calendar.mjs)일 때만 캐시. 조회 실패는 던진다.
 * **거래일의 빈 응답 = KRX 조회 실패**(오너 결정 2026-10-05): 휴장일이 아닌데 비었으면 1·3·9초 뒤 다시 받고, 끝내 비면 던진다(호출부 오류 → 종료코드 1,
 * 검증불가 아님). 그 거래일부터 다음 거래일까지(KST)는 아직 게시 전일 수 있어 앞 거래일로 넘어간다(앱 krx.ts 와 같은 규칙).
 */
import { emptyKind } from "./calendar.mjs";
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
/** 날짜 하루의 전종목 — Map(단축코드 → { n, close, mcap, shares, kind }) — kind 는 기본정보의 주식 종류. 휴장일·게시 전은 빈 맵, 지난 거래일 빈 응답은 던짐 */
export function krxDay(basDd) {
  if (!memo.has(basDd)) memo.set(basDd, (async () => {
    const today = kstToday();
    const cached = basDd < today && CACHE ? CACHE.get("krx-day", basDd, "v1") : undefined;
    if (cached !== undefined && cached.length) return new Map(cached);
    let [k1, k2] = await Promise.all([fetchSvc("stk_bydd_trd", basDd), fetchSvc("ksq_bydd_trd", basDd)]);
    let kind = null;
    if (!k1.length || !k2.length) {
      kind = await emptyKind(basDd);
      if (kind === "expected" || kind === "unknown") {
        for (const ms of [1000, 3000, 9000]) {
          await new Promise((res) => setTimeout(res, ms));
          [k1, k2] = await Promise.all([fetchSvc("stk_bydd_trd", basDd), fetchSvc("ksq_bydd_trd", basDd)]);
          if (k1.length && k2.length) break;
        }
        if (!k1.length || !k2.length)
          throw new Error(kind === "unknown" ? `KRX ${basDd} 빈 응답 — 휴장일 달력에 그 해가 없어 휴장인지 모름` : `KRX ${basDd} 빈 응답(${!k1.length && !k2.length ? "유가·코스닥" : !k1.length ? "유가" : "코스닥"}) — 휴장일 아닌 거래일, 3번 재시도 후(조회 실패)`);
      }
    }
    const rows = [...k1, ...k2];
    const m = new Map();
    if (rows.length) {
      const [b1, b2] = await Promise.all([fetchSvc("stk_isu_base_info", basDd), fetchSvc("ksq_isu_base_info", basDd)]);
      const kindOf = new Map([...b1, ...b2].map((r) => [String(r.ISU_SRT_CD).trim(), String(r.KIND_STKCERT_TP_NM ?? "").trim()]));
      for (const r of rows) {
        const c = String(r.ISU_CD).trim();
        m.set(c, { n: String(r.ISU_NM).trim(), close: num(r.TDD_CLSPRC), mcap: num(r.MKTCAP), shares: num(r.LIST_SHRS), kind: kindOf.get(c) ?? null });
      }
    }
    // 오늘은 캐시 안 함. 빈 날은 휴장일만(게시 전 빈 응답은 다음 실행 때 다시 받는다)
    if (basDd < today && CACHE && (m.size || kind === "holiday")) CACHE.put("krx-day", basDd, "v1", [...m]);
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
  // 건너뛴 게시 전 거래일(그 거래일~다음 거래일) — 앱이 그 날 자료를 이미 받았을 수 있어 호출부가 사유를 남기도록(휴장일은 넣지 않음)
  const pendingDays = [];
  for (let i = 0; i < maxBack; i++, d.setUTCDate(d.getUTCDate() - 1)) {
    const basDd = ymd(d);
    if (basDd > kstToday()) continue;
    const day = await krxDay(basDd);
    if (!day.size) { if ((await emptyKind(basDd)) === "pending") pendingDays.push(basDd); continue; }
    const c = day.get(code);
    if (!c) return { date: basDd, common: null, preferred: null, close: null, prefIssues: [], tradingDay: true, pendingDays };
    const prefs = [...day].filter(([k, v]) => k !== code && k.slice(0, 5) === code.slice(0, 5) && /우선주/.test(v.kind ?? ""));
    if (prefs.some(([, v]) => v.mcap == null)) throw new Error(`KRX ${basDd} 우선주 시가총액 빈 값`);
    return {
      date: basDd,
      common: c.mcap,
      close: c.close,
      shares: c.shares,
      preferred: prefs.reduce((a, [, v]) => a + v.mcap, 0),
      prefIssues: prefs.map(([k, v]) => `${k} ${v.n}`),
      prefShares: prefs.map(([k, v]) => [k, v.shares]),
      kindOk: c.kind != null,
      pendingDays,
    };
  }
  return null;
}
