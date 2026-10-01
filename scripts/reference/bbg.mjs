/**
 * 블룸버그 기준 데이터 조회(검증기용) — .cache/bbg/{종목}.json(bbg-import.mjs 가 만든 판독 결과)에서 결산일별 값.
 * 금액은 백만 달러 × 1e6 = 달러, 표기 단위(unit)는 그 값의 소수 자릿수로(블룸버그 화면은 종목마다 정수 또는 소수 둘째 자리).
 *
 * 항목 ↔ 화면·행(2026-09-28 — MRVL·DAL 등 20종목 화면으로 확인):
 *   BBG GAAP       매출액 · 매출원가 · 매출총이익 · 일반판매관리비(판관비) · 연구개발 · 영업이익 · 순이익, GAAP · 희석 EPS, GAAP
 *   조정(recon)    감가상각 & 무형자산상각(EBITDA 조정에 쓰는 값) · 세전이익(손실), GAAP
 *   표준화         재무상태표 현금·유동자산·유동부채·전체 부채·자본(비지배지분 전)
 *   BBG 조정       영업활동 현금흐름 · 자본지출(요약 화면 — 최근 12개월 열 포함)
 *   운용리스 제외  EBITDA(= GAAP 영업이익 + 감가상각·무형상각, 운용리스 비용 가산 없음 — 앱 정의와 같음)
 */
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.BBG_DIR ?? path.join(process.cwd(), ".cache", "bbg");
const iso = (d) => { const [y, m, dd] = d.split("-").map(Number); return `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`; };
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
const decimals = (v) => (String(v).split(".")[1] ?? "").length;

/** 종목 → null | { at(date) → { [item]: { v, unit } } , kinds } */
export function loadBbg(sym) {
  const f = path.join(DIR, `${sym.toUpperCase()}.json`);
  if (!fs.existsSync(f)) return null;
  const arr = JSON.parse(fs.readFileSync(f, "utf8"));
  // 화면 주기 — 열 간격 중앙값 200일 미만이면 분기 화면. 흐름 항목(손익·현금흐름)은 연간 화면만 쓴다(분기 화면의 12-31 열은 4분기 3개월 값 —
  // 연간 열과 날짜가 같아 섞이면 안 된다, 2026-10-01 GEV 분기 손익). 재무상태표(시점 값)는 분기 화면도 쓴다 — LTM 열(최근 분기말) 대조
  const quarterly = (g) => { const t = g.cols.map((c) => Date.parse(iso(c))).sort((a, b) => a - b), d = t.slice(1).map((x, i) => (x - t[i]) / 864e5).sort((a, b) => a - b); return d.length > 0 && d[Math.floor(d.length / 2)] < 200; };
  // 같은 종류 화면이 여럿이면(연간·분기, 하이라이트 등) 찾는 행이 있는 화면 전부 — 날짜 열이 있는 쪽을 조회 시점에 고른다. 연간 화면 먼저
  const rowsOf = (kind, label, instant) => arr.filter((x) => x.kind === kind && (instant || !quarterly(x))).sort((a, b) => Number(quarterly(a)) - Number(quarterly(b)))
    .flatMap((g) => { const r = g.rows.find((r0) => r0.label === label); return r ? [{ g, r }] : []; });
  const SPEC = {
    rev: ["가장최근 BBG GAAP", ["매출액"]],
    cogs: ["가장최근 BBG GAAP", ["- 매출원가"]],
    gp: ["가장최근 BBG GAAP", ["매출총이익"]],
    sga: ["가장최근 BBG GAAP", ["+ 일반판매관리비"]],
    rnd: ["가장최근 BBG GAAP", ["+ 연구개발 (R&D)"]],
    op: ["가장최근 BBG GAAP", ["영업이익 (손실)"]],
    ni: ["가장최근 BBG GAAP", ["순이익, GAAP"]],
    eps: ["가장최근 BBG GAAP", ["희석 EPS, GAAP"]],
    da: ["가장최근 조정 (recon)", ["+ 감가상각 & 무형자산상각"]],
    pretax: ["가장최근 조정 (recon)", ["세전이익 (손실), GAAP"]],
    ebitda: ["가장최근 운용리스 제외", ["EBITDA"]],
    // 재무상태표(표준화 B/S, 2026-10-01) — 자본은 비지배지분 전(앱 자본 총계와 같은 정의), 비지배지분 포함은 bsEqAll
    bsCash: ["가장최근 표준화", ["+ 현금 & 현금등가물"], true],
    bsCa: ["가장최근 표준화", ["유동자산총계"], true],
    bsCl: ["가장최근 표준화", ["유동부채총계"], true],
    bsL: ["가장최근 표준화", ["전체 부채"], true],
    bsEq: ["가장최근 표준화", ["소수주주지분 전 지분"], true],
    // 총차입금(운용리스 포함) = 단기 부채 + 장기 부채 — 표준화 화면의 두 줄은 차입금·리스부채(금융·운용) 합(DELL 2026-07-31 8,734 + 26,537 = 35,271 확인)
    bsStDebt: ["가장최근 표준화", ["+ 단기 부채"], true],
    bsLtDebt: ["가장최근 표준화", ["+ 장기 부채"], true],
    // 현금흐름표(표준화, 2026-10-01 오너 제공 — 연간 + 최근 12개월 열). 주식보상비용은 이 화면에 따로 없음(기타 비현금 항목에 합산)
    cfOcfS: ["가장최근 표준화", ["영업활동으로 인한 현금"]],
    // 현금흐름표(표준화) 감가상각비 — 조정(recon) 화면에 감가상각 칸이 없는 칸만 대신 쓴다(2026-10-01 CEG LTM 3,669)
    daCf: ["가장최근 표준화", ["+ 감가상각비"]],
    cfIcf: ["가장최근 표준화", ["투자활동에서 현금흐름"]],
    cfFcf: ["가장최근 표준화", ["재무활동에서 현금흐름"]],
    cfCapexS: ["가장최근 표준화", ["+ 자본지출"]],
    cfDiv: ["가장최근 표준화", ["+ 지급배당금"]],
    cfBuyback: ["가장최근 표준화", ["+ 자본금감소"]],
    // 현금흐름(요약 화면 BBG 조정 — 연간 + 최근 12개월 열). 현금흐름표 전체 화면은 스냅샷에 없음
    cfOcf: ["가장최근 BBG 조정", ["영업활동 현금흐름"]],
    cfCapex: ["가장최근 BBG 조정", ["자본지출"]],
  };
  const found = Object.fromEntries(Object.entries(SPEC).map(([k, [kind, labels, instant]]) => [k, labels.flatMap((l) => rowsOf(kind, l, instant))]));
  // 분기 화면의 같은 행(흐름 항목) — 사업연도 합 대조용(2026-10-01 GEV 세전이익: 분기 332 + 645 + 746 + 1,105 = 2,828 인데 연간 열 2,829)
  const qRows = Object.fromEntries(Object.entries(SPEC).map(([k, [kind, labels]]) => [k, labels.flatMap((l) => arr.filter((x) => x.kind === kind && quarterly(x))
    .flatMap((g) => { const r = g.rows.find((r0) => r0.label === l); return r ? [{ g, r }] : []; }))]));
  const today0 = new Date().toISOString().slice(0, 10);
  return {
    kinds: [...new Set(arr.map((x) => x.kind))],
    /** 사업연도(결산일 fyEnd) 네 분기 값 합 — 한 분기 화면에 결산일 전 약 1년 안의 실적 열 4개가 모두 있을 때만. → { v, parts, unit } | null */
    qSum(k, fyEnd) {
      for (const { g, r } of qRows[k] ?? []) {
        const cs = g.cols.filter((c) => iso(c) <= today0 && Date.parse(iso(c)) > Date.parse(fyEnd) - 340 * 864e5 && Date.parse(iso(c)) <= Date.parse(fyEnd) + 7 * 864e5);
        if (cs.length !== 4 || !cs.some((c) => dayDiff(iso(c), fyEnd) <= 7) || cs.some((c) => r.vals[c] == null)) continue;
        const d = Math.max(0, ...cs.map((c) => decimals(r.vals[c])));
        return { v: cs.reduce((t, c) => t + r.vals[c], 0) * 1e6, parts: cs.map((c) => `${iso(c)} ${r.vals[c]}`), unit: 1e6 * 10 ** -d };
      }
      return null;
    },
    at(date) {
      const out = {};
      for (const [k, xs] of Object.entries(found)) {
        let x = null, v;
        for (const c0 of xs) {
          const col = c0.g.cols.find((c) => dayDiff(iso(c), date) <= 7);
          if (col != null && c0.r.vals[col] != null) { x = c0; v = c0.r.vals[col]; break; }
        }
        if (!x) continue;
        const isEps = k === "eps";
        // 표기 단위 = 그 행 값들의 최대 소수 자릿수(끝자리 0 이 생략된 값 — 2064.20 → 2064.2 — 을 거친 단위로 오판하지 않게)
        // 실적 열만(오늘 이후 결산일 열은 컨센서스 예상치 — 소수 둘째 자리라 정수 화면의 단위를 잘못 좁힌다)
        const today = new Date().toISOString().slice(0, 10);
        const d = Math.max(0, ...Object.entries(x.r.vals).filter(([c]) => iso(c) <= today).map(([, y]) => decimals(y)));
        out[k] = { v: isEps ? v : v * 1e6, unit: (isEps ? 1 : 1e6) * 10 ** -d };
      }
      return out;
    },
  };
}
