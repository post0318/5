/**
 * 미국·일본 시세·분할(설계 10 R-US11 — U7 미결(D7, 측정 후): 지금은 Yahoo 를 원자료로 두고 「같은 원천(공통 데이터)」 표시)와
 * 20-F 환산용 환율(FRED H.10, R-US8). 원천을 이 파일 한 곳에 둬 측정 뒤 바꾸기 쉽게 한다.
 *  - Yahoo chart: 갱신형(내용 해시 판본, 1일). 신원 = chart.result[0].meta.symbol.
 *  - FRED fredgraph.csv: 갱신형(1일). 신원 = 머리줄 observation_date,{계열}.
 */
import { checkJson, checkNonEmpty } from "./format.mjs";
import { mutable } from "./fetchstore.mjs";
import { makeRequester, RETRY } from "./http.mjs";

const H = 3600e3;

export function makeGlobalMarket({ store, quotaRoot, tool = "verify", fetchImpl, now = () => new Date(), ua }) {
  const yreq = makeRequester({ source: "yahoo", quotaRoot, tool, dailyCap: Number(process.env.YAHOO_DAILY_CAP_VERIFY ?? 2000), gapMs: 500, retry: RETRY.yahoo, fetchImpl, now });
  const freq = makeRequester({ source: "fred", quotaRoot, tool, dailyCap: 200, gapMs: 1000, retry: RETRY.fred, fetchImpl, now });

  /** Yahoo 차트(분할 이력 + 일별 종가). interval = 1d|1mo */
  async function chart(sym, { interval = "1d", from = "2015-01-01" } = {}) {
    const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const r = await mutable({
      store, req: yreq, market: "global", source: "yahoo", key: `chart_${sym}_${interval}_${from}`, ext: "json", ttlMs: 24 * H, now,
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${Math.floor(now().getTime() / 1000)}&interval=${interval}&events=split%2Cdiv`,
      headers: { "user-agent": "Mozilla/5.0" },
      validate: (b) => checkJson(b, (j) => (j?.chart?.result?.[0]?.meta ? null : `chart 오류 ${JSON.stringify(j?.chart?.error ?? null).slice(0, 80)}`)),
      identity: (b) => { const m = JSON.parse(b).chart.result[0].meta; return { ok: String(m.symbol).toUpperCase() === sym.toUpperCase(), got: m.symbol }; },
    });
    return { json: JSON.parse(r.buf.toString("utf8")).chart.result[0], version: r.version };
  }

  /** 분할·병합 Event — 분자·분모가 작은 정수인 것만 분할, 나머지(분사 가격 조정 — WDC→SNDK 1323:1000)는 spinoff 로 따로 */
  async function events(sym) {
    const c = await chart(sym, { interval: "1mo", from: "2000-01-01" });
    const all = Object.values(c.json.events?.splits ?? {}).map((s) => ({
      date: new Date(s.date * 1000).toISOString().slice(0, 10), numerator: s.numerator, denominator: s.denominator, source: "yahoo", common_data: true,
    }));
    const isSplit = (s) => Number.isInteger(s.numerator) && Number.isInteger(s.denominator) && s.numerator <= 100 && s.denominator <= 100 && (s.numerator <= 20 || s.denominator === 1) && (s.denominator <= 20 || s.numerator === 1);
    return { splits: all.filter(isSplit).map((s) => ({ ...s, kind: s.numerator >= s.denominator ? "split" : "reverse_split" })), spinoffs: all.filter((s) => !isSplit(s)).map((s) => ({ ...s, kind: "spinoff_adjustment" })), version: c.version };
  }

  /** 일별 종가(미보정 = Yahoo close 는 분할 보정이라 ④ 가 Event 로 되돌린다 — 표시) */
  async function closes(sym, from = "2015-01-01") {
    const c = await chart(sym, { interval: "1d", from });
    const ts = c.json.timestamp ?? [];
    const q = c.json.indicators?.quote?.[0] ?? {};
    return { rows: ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: q.close?.[i] == null ? null : String(q.close[i]) })), split_adjusted: true, common_data: true, version: c.version, tz: c.json.meta?.exchangeTimezoneName ?? null };
  }

  /** FRED H.10 계열 CSV → FxRate[] */
  async function fred(series, from = "2015-01-01") {
    const r = await mutable({
      store, req: freq, market: "global", source: "fred", key: `fred_${series}_${from}`, ext: "csv", ttlMs: 24 * H, now,
      url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${from}`,
      headers: { "user-agent": ua ?? "market-research", accept: "text/csv,*/*" },
      validate: (b) => { const e = checkNonEmpty(b); if (!e.ok) return e; return /^observation_date,/.test(b.toString("utf8", 0, 40)) ? { ok: true } : { ok: false, why: "CSV 머리줄 이상" }; },
      identity: (b) => { const h = b.toString("utf8", 0, 80).split(/\r?\n/)[0]; return { ok: h === `observation_date,${series}`, got: h }; },
    });
    const L = r.buf.toString("utf8").trim().split(/\r?\n/).slice(1);
    return { series, rows: L.map((l) => l.split(",")).filter((x) => x[1] && x[1] !== ".").map((x) => ({ date: x[0], rate: x[1], series, source: "FRED H.10" })), version: r.version };
  }
  return { chart, events, closes, fred, logs: [yreq.log, freq.log] };
}
