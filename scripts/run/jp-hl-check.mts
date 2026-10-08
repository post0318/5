/**
 * 일본 하이라이트·재무분석·개요 멀티플·유니버스·컨센서스 점검(오너 지시 2026-10-08 — "일본 검증은 미국 기준으로", 단일 기준 jp-ev.ts).
 * 앱 함수를 그대로 불러(화면과 같은 값) 다음을 본다:
 *  E. 화면 간 일치 — 하이라이트 열 = 재무분석 열 = 컨센서스 행(PER·PBR·EV/EBITDA·EPS), 하이라이트 LTM = 개요 멀티플(getStockOverview) = 유니버스 행
 *  F. 항등식 — EV = 시가총액 + 총차입금 + 비지배지분 − 현금성자산, EBITDA = 영업이익 + 감가상각비(재무분석 순차입금/EBITDA 역산), PBR = 시가총액 ÷ 지배주주 자본
 *  G. 외부 대조(검토 목록) — J-Quants 결산단신 요약(jp_jq_summary: EPS·희석 EPS·BPS·연간 DPS·발행주식·자기주식), Yahoo quoteSummary(주식수·trailing EPS·BPS)
 * 실행: NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/jp-hl-check.mts [7203 …]
 * 결과는 표준 출력만 — DB 에 쓰지 않는다.
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const SAMPLES = ["7203", "6758", "9984", "285A", "6981", "7011", "8002", "4063", "6178"];

async function main() {
  const { getJpHighlights, getJpAnalysis, getJpTtm } = await import("@/lib/markets/jp/jp-views");
  const { getStockOverview } = await import("@/lib/markets/service");
  const { computeUniverseRow } = await import("@/lib/universe/overview");
  const { getConsensusData } = await import("@/lib/markets/consensus");
  const { fetchForwardConsensus } = await import("@/lib/markets/quote/yahoo");
  const { getDb } = await import("@/lib/db");
  const jq = (await getDb()).collection<Record<string, string>>("jp_jq_summary");
  const syms = process.argv.slice(2).length ? process.argv.slice(2) : SAMPLES;
  const same = (a: number | null | undefined, b: number | null | undefined) =>
    a == null || b == null ? a == null && b == null : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const f2 = (x: number | null | undefined) => (x == null ? "–" : Math.abs(x) >= 1e6 ? (x / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 }) : x.toFixed(2));
  const summary: string[] = [];

  for (const sym of syms) {
    console.log(`\n######## ${sym}`);
    const [hl, an, ttm, ov, uni, cons, yq] = await Promise.all([
      getJpHighlights(sym),
      getJpAnalysis(sym),
      getJpTtm(sym),
      getStockOverview("jp", sym, null, { skipQuarterly: true }),
      computeUniverseRow("jp", sym),
      getConsensusData("jp", sym).catch((e) => ({ error: String(e) })),
      fetchForwardConsensus("jp", sym).catch(() => null),
    ]);
    let ok = 0;
    let bad = 0;
    const chk = (what: string, a: number | null | undefined, b: number | null | undefined) => {
      if (same(a, b)) ok++;
      else {
        bad++;
        console.log(`  E 불일치 ${what}: ${f2(a)} · ${f2(b)}`);
      }
    };
    const row = (k: string) => [...hl.rows, ...hl.valuationRows].find((r) => r.key === k);
    const anItem = (name: string) => an.sections[0].items.find((i) => i.accountName === name);
    const ltmI = hl.columns.findIndex((c) => c.kind === "ltm");
    // E1. 하이라이트 열 ↔ 재무분석 열 ↔ 컨센서스 행
    hl.columns.forEach((c, i) => {
      if (c.kind === "estimate") return;
      const al = c.kind === "ltm" ? "현재/LTM" : `${c.key.slice(2)}Y`;
      for (const [k, name] of [["per", "PER"], ["pbr", "PBR"], ["psr", row("psr")?.label ?? "PSR"], ["ev_ebitda", "EV/EBITDA"]] as const) {
        const r = row(k);
        const it = anItem(name);
        if (!r || !it) continue;
        chk(`${c.label} ${name} 하이라이트↔재무분석`, r.values[i], it.values[al]);
      }
      if (c.kind === "fy" && !("error" in cons)) {
        const cr = cons.rows.find((x) => !x.isEstimate && x.fy === Number(c.key.slice(2)));
        if (cr) {
          chk(`${c.label} PER 하이라이트↔컨센서스`, row("per")?.values[i], cr.per);
          chk(`${c.label} PBR 하이라이트↔컨센서스`, row("pbr")?.values[i], cr.pbr);
          if (row("ev_ebitda")) chk(`${c.label} EV/EBITDA 하이라이트↔컨센서스`, row("ev_ebitda")?.values[i], cr.evEbitda);
          chk(`${c.label} EPS 하이라이트↔컨센서스`, row("eps")?.values[i], cr.eps);
          chk(`${c.label} 순이익 하이라이트↔컨센서스`, row("ni")?.values[i], cr.netIncome);
        }
      }
    });
    if ("error" in cons) console.log(`  컨센서스 오류: ${cons.error}`);
    // E2. 하이라이트 LTM ↔ 개요 멀티플(getStockOverview — 화면 computeTrailingMultiples 와 같은 함수) ↔ 유니버스 행
    const m = ov.multiples;
    const fyI = hl.columns.map((c, i) => (c.kind === "fy" ? i : -1)).filter((i) => i >= 0).pop()!;
    if (!m) console.log(`  개요 멀티플 없음(${ov.warnings.join(" / ")})`);
    else {
      chk("LTM 시가총액 하이라이트↔개요", row("mktcap")?.values[ltmI], m.marketCap);
      chk("PER(연간) 하이라이트 최근 FY EPS·현재가 ↔ 개요 PER", ov.quote?.last != null && row("eps")?.values[fyI] ? (row("eps")!.values[fyI]! > 0 ? ov.quote.last / row("eps")!.values[fyI]! : null) : null, m.per);
      chk("LTM PER 하이라이트↔개요 PER(TTM)", row("per")?.values[ltmI], m.perTtm);
      chk("LTM PBR 하이라이트↔개요", row("pbr")?.values[ltmI], m.pbr);
      chk("LTM PSR 하이라이트↔개요", row("psr")?.values[ltmI], m.psr);
      if (row("ev_ebitda")) chk("LTM EV/EBITDA 하이라이트↔개요", row("ev_ebitda")?.values[ltmI], m.evEbitda);
      chk("LTM EPS 하이라이트↔TTM", row("eps")?.values[ltmI], ttm.eps);
      chk("개요 PER ↔ 유니버스", m.per, uni.per);
      chk("개요 PER(TTM) ↔ 유니버스", m.perTtm, uni.perTtm);
      chk("개요 PBR ↔ 유니버스", m.pbr, uni.pbr);
      chk("개요 시가총액 ↔ 유니버스", m.marketCap, uni.marketCap);
      chk("LTM 매출 하이라이트 ↔ 유니버스", row("revenue")?.values[ltmI], uni.revenueAnnual);
      const mr = m.reasons ?? {};
      const empty = (["per", "perTtm", "pbr", "psr", "evEbitda", "marketCap"] as const).filter((k) => m[k] == null);
      if (empty.length) console.log(`  개요 빈칸: ${empty.map((k) => `${k}(${mr[k as keyof typeof mr] ?? "사유 없음"})`).join(" / ")}`);
    }
    // F. 항등식
    let fOk = 0;
    let fBad = 0;
    hl.columns.forEach((c, i) => {
      if (c.kind === "estimate") return;
      const mc = row("mktcap")?.values[i];
      const ev = row("ev")?.values[i];
      if (ev != null && mc != null) {
        // 현금 줄은 음수(− 현금성자산)로 실려 있다
        const want = mc + (row("debt")?.values[i] ?? 0) + (row("nci")?.values[i] ?? 0) + (row("cash")?.values[i] ?? 0);
        if (same(ev, want)) fOk++;
        else {
          fBad++;
          console.log(`  F EV 항등식 ${c.label}: EV ${f2(ev)} · 합 ${f2(want)}`);
        }
      }
    });
    console.log(`  E 화면 간 일치 ${ok}, 불일치 ${bad} · F EV 항등식 ${fOk}/${fOk + fBad}`);

    // G. 외부 대조 — J-Quants(결산단신 요약)
    const code = sym.length === 4 ? `${sym}0` : sym;
    const jrows = await jq.find({ Code: code, CurPerType: "FY" }).sort({ DiscDate: 1 }).toArray();
    const byEnd = new Map<string, Record<string, string>>();
    for (const r of jrows) byEnd.set(r.CurPerEn, r);
    const g: string[] = [];
    for (const [end, r] of byEnd) {
      const i = hl.columns.findIndex((c) => c.kind === "fy" && c.date === end);
      if (i < 0) continue;
      const eps = row("eps")?.values[i];
      const epsNote = row("eps")?.cellNotes?.[i] ?? "";
      const dps = row("dps")?.values[i];
      const dpsNote = row("dps")?.cellNotes?.[i] ?? "";
      const jEps = r.DEPS ? Number(r.DEPS) : r.EPS ? Number(r.EPS) : null;
      const jDiv = r.DivAnn ? Number(r.DivAnn) : null;
      const jSh = r.ShOutFY && r.TrShFY ? Number(r.ShOutFY) - Number(r.TrShFY) : null;
      g.push(
        `  G ${end} J-Quants: EPS ${r.DEPS || r.EPS || "–"} · 앱 ${f2(eps)}${epsNote ? `(${epsNote})` : ""} | DPS ${r.DivAnn || "–"} · 앱 ${f2(dps)}${dpsNote ? `(${dpsNote})` : ""} | BPS ${r.BPS || "–"} | 유통주식 ${jSh?.toLocaleString("en-US") ?? "–"}(발행 ${r.ShOutFY} − 자기 ${r.TrShFY})` +
          (jEps != null && eps != null && !epsNote && Math.abs(jEps - eps) > 0.005 ? " ⚠EPS차" : "") +
          (jDiv != null && dps != null && !dpsNote && Math.abs(jDiv - dps) > 0.005 ? " ⚠DPS차" : ""),
      );
    }
    console.log(g.join("\n"));
    // 앱 유통주식수(시가총액 ÷ 실제 종가 역산은 하지 않는다 — TTM 스냅샷 주식수) · 지배주주 자본 ÷ 앱 주식수 vs J-Quants BPS
    const lastJ = [...byEnd.values()].at(-1);
    const snap = ttm.snapshot;
    console.log(
      `  G 현재 유통주식수 앱 ${snap?.evShares?.toLocaleString("en-US") ?? "–"}${ttm.reasons?.evShares ? `(${ttm.reasons.evShares})` : ""} · J-Quants 최근 ${lastJ ? (Number(lastJ.ShOutFY) - Number(lastJ.TrShFY)).toLocaleString("en-US") : "–"} · Yahoo ${yq?.sharesOutstanding?.toLocaleString("en-US") ?? "–"}` +
        ` | 지배자본÷주식수 ${snap?.equity != null && snap.evShares ? (snap.equity / snap.evShares).toFixed(2) : "–"} · J-Quants BPS ${lastJ?.BPS ?? "–"} · Yahoo BPS ${yq?.bookValue ?? "–"}` +
        ` | EPS(LTM) 앱 ${f2(ttm.eps)} · Yahoo trailing ${yq?.trailingEps ?? "–"}`,
    );
    summary.push(`${sym}\tE ${ok}/${ok + bad}\tF ${fOk}/${fOk + fBad}`);
  }
  console.log("\n" + summary.join("\n"));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
