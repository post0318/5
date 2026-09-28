/**
 * 블룸버그 기준 데이터 조회(검증기용) — .cache/bbg/{종목}.json(bbg-import.mjs 가 만든 판독 결과)에서 결산일별 값.
 * 금액은 백만 달러 × 1e6 = 달러, 표기 단위(unit)는 그 값의 소수 자릿수로(블룸버그 화면은 종목마다 정수 또는 소수 둘째 자리).
 *
 * 항목 ↔ 화면·행(2026-09-28 — MRVL·DAL 등 20종목 화면으로 확인):
 *   BBG GAAP       매출액 · 매출원가 · 매출총이익 · 일반판매관리비(판관비) · 연구개발 · 영업이익 · 순이익, GAAP · 희석 EPS, GAAP
 *   조정(recon)    감가상각 & 무형자산상각(EBITDA 조정에 쓰는 값) · 세전이익(손실), GAAP
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
  // 같은 종류 화면이 둘이면(하이라이트 등) 찾는 행이 있는 쪽
  const pick = (kind, label) => arr.filter((x) => x.kind === kind).find((x) => x.rows.some((r) => r.label === label)) ?? null;
  const row = (kind, label) => { const g = pick(kind, label); return g ? { g, r: g.rows.find((r) => r.label === label) } : null; };
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
  };
  const found = Object.fromEntries(Object.entries(SPEC).map(([k, [kind, labels]]) => [k, labels.map((l) => row(kind, l)).find(Boolean) ?? null]));
  return {
    kinds: [...new Set(arr.map((x) => x.kind))],
    at(date) {
      const out = {};
      for (const [k, x] of Object.entries(found)) {
        if (!x) continue;
        const col = x.g.cols.find((c) => dayDiff(iso(c), date) <= 7);
        const v = col != null ? x.r.vals[col] : undefined;
        if (v == null) continue;
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
