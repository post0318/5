/**
 * 한국 시세(설계 10 R-KR10) — KRX 일별 전종목(stk/ksq_bydd_trd) + 종목 기본정보(주식 종류) → MarketDay.
 *  - 종가는 미보정 실제 종가 그대로. 시가총액 = KRX MKTCAP(상장주식수 × 종가, 자기주식 미차감 — 10-14 확인).
 *  - 우선주 = 같은 발행사(단축코드 앞 5자리) + KRX 주식 종류 「…우선주」(Q4).
 *  - 결산일 시가총액 = 그해 마지막 거래일(10일 상한).
 *  - 빈 응답: 주말·KRX 휴장일 → 앞 날짜로, 게시 전(그 거래일부터 다음 거래일까지 KST) → not_yet_published, 지난 거래일 빈 응답 → 1·3·9초 뒤
 *    다시 받고 끝내 비면 fetch_failed(오너 결정 2026-10-05). 휴장일 달력이 그 해를 모르면 fetch_failed(휴장 여부 모름).
 */
import { BLANK } from "../common/rawfact.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kstToday = (now) => new Date(now().getTime() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
const prevDay = (d) => new Date(Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`) - 864e5).toISOString().slice(0, 10).replace(/-/g, "");
const dow = (d) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).getUTCDay();
const num = (v) => (v == null || String(v).trim() === "" || v === "-" ? null : String(v).replace(/,/g, ""));

export function makeKrMarket(krx, { now = () => new Date() } = {}) {
  const holi = new Map();
  async function holidaySet(year) {
    if (!holi.has(year)) {
      const block = await krx.holidays(year);
      holi.set(year, block.length ? new Set(block.map((x) => String(x.calnd_dd).slice(0, 10).replace(/-/g, ""))) : null);
    }
    return holi.get(year);
  }
  /** 날짜 하루 — { status: "ok"|"holiday"|"not_yet_published"|"fetch_failed", rows } */
  async function day(basDd) {
    const tries = [0, 1000, 3000, 9000];
    let last = null;
    for (const w of tries) {
      if (w) await sleep(w);
      const [a, b] = await Promise.all([krx.day("stk_bydd_trd", basDd), krx.day("ksq_bydd_trd", basDd)]);
      last = [a, b];
      if (a.rows.length && b.rows.length) return { status: "ok", rows: [...a.rows, ...b.rows] };
      const d = dow(basDd);
      if (d === 0 || d === 6) return { status: "holiday", why: "weekend" };
      const hs = await holidaySet(Number(basDd.slice(0, 4)));
      if (hs?.has(basDd)) {
        if (a.buf) krx.putHolidayEmpty("stk_bydd_trd", basDd, a.buf);
        if (b.buf) krx.putHolidayEmpty("ksq_bydd_trd", basDd, b.buf);
        return { status: "holiday", why: "krx_holiday" };
      }
      if (basDd >= kstToday(now)) return { status: "not_yet_published" };
      if (!hs) return { status: "fetch_failed", why: "휴장일 달력에 그 해 없음 — 휴장 여부 모름" };
    }
    return { status: "fetch_failed", why: `거래일 빈 응답(${!last[0].rows.length ? "유가" : ""}${!last[1].rows.length ? "코스닥" : ""}) — 재시도 3회 후` };
  }
  /** 기본정보(주식 종류) — 날짜 하루 */
  async function kinds(basDd) {
    const [a, b] = await Promise.all([krx.day("stk_isu_base_info", basDd), krx.day("ksq_isu_base_info", basDd)]);
    const m = new Map();
    for (const r of [...a.rows, ...b.rows]) m.set(String(r.ISU_SRT_CD), String(r.KIND_STKCERT_TP_NM ?? ""));
    return m;
  }

  /**
   * 종목 하나의 그날 시세 — 보통주와 같은 발행사 우선주
   * @returns {{date, status, common?, preferred?:[], why?}}
   */
  async function marketDay(sym, basDd) {
    const d = await day(basDd);
    if (d.status !== "ok") return { date: basDd, status: d.status, why: d.why ?? null };
    const k = await kinds(basDd);
    const pick = (r) => ({ code: String(r.ISU_CD), name: r.ISU_NM, close: num(r.TDD_CLSPRC), mcap: num(r.MKTCAP), listed_shares: num(r.LIST_SHRS), stock_kind: k.get(String(r.ISU_CD)) ?? null });
    const com = d.rows.find((r) => String(r.ISU_CD) === sym);
    const pref = d.rows.filter((r) => String(r.ISU_CD) !== sym && String(r.ISU_CD).slice(0, 5) === sym.slice(0, 5) && /우선주/.test(k.get(String(r.ISU_CD)) ?? ""));
    return { date: basDd, status: com ? "ok" : "confirmed_absent", common: com ? pick(com) : null, preferred: pref.map(pick) };
  }

  /** 그해 마지막 거래일(12-31 부터 거꾸로 10일 상한) 시세 */
  async function yearEnd(sym, year) {
    let d = `${year}1231`;
    const skipped = [];
    for (let i = 0; i < 10; i++) {
      const r = await marketDay(sym, d);
      if (r.status === "ok" || r.status === "confirmed_absent") return { ...r, skipped };
      if (r.status !== "holiday") return { ...r, skipped, blank_reason: r.status === "not_yet_published" ? BLANK.not_yet_published : BLANK.fetch_failed };
      skipped.push({ d, why: r.why });
      d = prevDay(d);
    }
    return { date: null, status: "fetch_failed", blank_reason: BLANK.fetch_failed, why: "10일 안에 거래일 없음", skipped };
  }
  return { day, marketDay, yearEnd };
}
