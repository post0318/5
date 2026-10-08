/**
 * 일본 3대 재무제표 점검(오너 지시 2026-10-08 — "일본 검증은 미국 기준으로"). 앱 조립(jp/statements.ts)과 같은 서류를 읽어:
 *  A. 계산 구조 — 서류마다 본표 계산 연결(_cal.xml)의 부모 = Σ 가중치 × 자식(그 서류가 실은 기간마다, 공시 값 그대로)
 *  B. 재무상태표 — 자산 합계 = 부채·자본(순자산) 합계(화면 열마다)
 *  C. 현금흐름표 — 기말 − 기초 = 현금 증감액(+ 그 아래 조정 줄)(화면 열마다)
 *  D. J-Quants 요약(jp_jq_summary — 결산단신 숫자) 대조: 매출·영업이익·순이익(지배)·총자산·자본·영업/투자/재무 CF·기말 현금
 * 실행: NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/jp-fin-check.mts [7203 6758 …]
 * 결과는 화면(표준 출력)만 — DB 에 쓰지 않는다(조립 저장본 jp_fin 은 앱 함수가 평소처럼 채운다).
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const SAMPLES = ["7203", "6758", "9984", "285A", "6981", "7011", "8002", "4063", "6178"];

async function main() {
  const { jpPickedRows, jpLoadSources, getJpFinModel, jpStatementView, periodsOf } = await import("@/lib/markets/jp/statements");
  const { getDb } = await import("@/lib/db");
  const syms = process.argv.slice(2).length ? process.argv.slice(2) : SAMPLES;
  const jq = (await getDb()).collection<Record<string, string>>("jp_jq_summary");
  const fmt = (v: number) => (v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const summary: string[] = [];

  for (const sym of syms) {
    console.log(`\n######## ${sym}`);
    const picked = await jpPickedRows(sym);
    const src = await jpLoadSources(picked);
    if (src.warn.length) console.log("  경고:", src.warn.join(" / "));

    // A. 계산 구조
    let calcN = 0;
    let calcBad = 0;
    let calcRound = 0;
    for (const s of [...src.annual, ...src.half]) {
      for (const [kind, st] of Object.entries(s.fin.stmts)) {
        if (!st) continue;
        const pks = periodsOf(s, kind as "bs");
        const kids = new Map<string, [string, number][]>();
        for (const [p, c, w] of st.calc) kids.set(p, [...(kids.get(p) ?? []), [c, w]]);
        for (const [p, cs] of kids) {
          for (const pk of pks) {
            const pv = s.fin.facts[p]?.[pk];
            if (pv == null) continue;
            let sum = 0;
            let any = false;
            for (const [c, w] of cs) {
              const cv = s.fin.facts[c]?.[pk];
              if (cv != null) {
                sum += w * cv;
                any = true;
              }
            }
            if (!any) continue;
            calcN++;
            const diff = pv - sum;
            if (diff === 0) continue;
            // 백만엔 미만 절사 표시의 반올림 차이 — 자식 수 × 100만 이내
            if (Math.abs(diff) <= cs.length * 1e6) {
              calcRound++;
              continue;
            }
            calcBad++;
            if (calcBad <= 8) console.log(`  A 불일치 ${s.row._id} ${kind} ${pk} ${p} 공시 ${fmt(pv)} · Σ자식 ${fmt(sum)} · 차 ${fmt(diff)} (자식 ${cs.map((x) => x[0]).join(",")})`);
          }
        }
      }
    }
    console.log(`  A 계산 구조 ${calcN}건 — 정확 ${calcN - calcBad - calcRound}, 백만엔 반올림 이내 ${calcRound}, 불일치 ${calcBad}`);

    const model = await getJpFinModel(sym);
    const views = {
      annual: { is: jpStatementView(model, sym, "is", "annual"), bs: jpStatementView(model, sym, "bs", "annual"), cf: jpStatementView(model, sym, "cf", "annual") },
      quarter: { is: jpStatementView(model, sym, "is", "quarter"), bs: jpStatementView(model, sym, "bs", "quarter"), cf: jpStatementView(model, sym, "cf", "quarter") },
    };
    type St = (typeof views)["annual"]["is"];
    const items = (st: St) => st.sections.flatMap((x) => x.items);
    const find = (st: St, keyRe: RegExp, labelRe?: RegExp) =>
      items(st).find((i) => keyRe.test(i.accountId ?? "")) ?? (labelRe ? items(st).find((i) => labelRe.test(i.accountName) && !i.accountName.startsWith("※")) : undefined);

    // B·C
    let bOk = 0;
    let bBad = 0;
    let cOk = 0;
    let cBad = 0;
    for (const period of ["annual", "quarter"] as const) {
      const { bs, cf } = views[period];
      const ta = find(bs, /:(jppfs_cor:Assets|jpigp_cor:AssetsIFRS)#/, /^資産(の部)?合計$/);
      const le = find(bs, /:(jppfs_cor:LiabilitiesAndNetAssets|jpigp_cor:LiabilitiesAndEquityIFRS)#/, /^(負債(及び|・)?(純資産|資本)(の部)?合計)$/);
      for (const p of bs.periods) {
        const a = ta?.values[p.label];
        const b = le?.values[p.label];
        if (a == null || b == null) continue;
        if (a === b) bOk++;
        else {
          bBad++;
          console.log(`  B 불일치 ${period} ${p.label} 자산 ${fmt(a)} · 부채·자본 ${fmt(b)}`);
        }
      }
      const cfItems = items(cf);
      const inc = cfItems.find((i) => /:jp[a-z]+_cor:NetIncreaseDecreaseInCashAndCashEquivalents(IFRS)?#/.test(i.accountId ?? ""));
      const END_RE = /期末残高|(財政状態計算書|貸借対照表)の現金/;
      for (const p of cf.periods) {
        const has = (i: (typeof cfItems)[number]) => i.values[p.label] != null;
        const beg = cfItems.find((i) => /期首残高/.test(i.accountName) && has(i));
        // 기말 = 증감액 줄 뒤 첫 기말 잔액 줄(소니처럼 "기말 잔액 − 분배 목적 자산에 포함된 현금 = 재무상태표 현금" 이 이어지는 표가 있다)
        const iInc0 = inc ? cfItems.indexOf(inc) : -1;
        const endI = cfItems.find((i, ix) => ix > iInc0 && END_RE.test(i.accountName) && has(i));
        const n = inc?.values[p.label];
        if (!beg || !endI || n == null) continue;
        const e = endI.values[p.label]!;
        const b = beg.values[p.label]!;
        // 증감액 줄 뒤 · 기말 줄 앞의 다른 금액 줄(연결 범위 변동·매각예정 자산에 포함된 현금 등)
        const iInc = cfItems.indexOf(inc!);
        const iEnd = cfItems.indexOf(endI);
        let adj = 0;
        const adjNames: string[] = [];
        cfItems.forEach((it, i) => {
          if (i <= iInc || i >= iEnd || it === beg || it.isSubtotal || END_RE.test(it.accountName) || /期首残高/.test(it.accountName)) return;
          const v = it.values[p.label];
          if (v != null) {
            adj += v;
            adjNames.push(it.accountName);
          }
        });
        const resid = e - b - n - adj;
        // 百万엔 미만 절사 표시 — 2백만 이내는 반올림
        if (Math.abs(resid) <= 2e6) cOk++;
        else {
          cBad++;
          console.log(`  C 불일치 ${period} ${p.label} 기말 ${fmt(e)} − 기초 ${fmt(b)} − 증감 ${fmt(n)} − 조정(${adjNames.join("·") || "없음"}) ${fmt(adj)} = ${fmt(resid)}`);
        }
      }
      if (!inc) console.log(`  C ${period}: 현금 증감액 줄(NetIncreaseDecreaseInCashAndCashEquivalents) 없음 — 검사 생략`);
    }
    console.log(`  B 재무상태표 항등식 일치 ${bOk}, 불일치 ${bBad} · C 현금 증감 일치 ${cOk}, 불일치 ${cBad}`);

    // D. J-Quants
    const code = sym.length === 4 ? `${sym}0` : sym;
    const rows = await jq.find({ Code: code, CurPerType: { $in: ["FY", "2Q"] } }).sort({ DiscDate: 1 }).toArray();
    const latest = new Map<string, Record<string, string>>();
    for (const r of rows) if (/Consolidated|NonConsolidated/.test(r.DocType ?? "")) latest.set(`${r.CurPerType}:${r.CurPerEn}`, r);
    const map: [string, (st: typeof views.annual) => { it: ReturnType<typeof find>; v: "is" | "bs" | "cf" }][] = [
      ["Sales", (v) => ({ it: items(v.is).find((i) => i.isHighlight && /(売上|収益)/.test(i.accountName)), v: "is" })],
      ["OP", (v) => ({ it: find(v.is, /:(jppfs_cor:OperatingIncome|jpigp_cor:OperatingProfitLossIFRS)#/), v: "is" })],
      ["NP", (v) => ({ it: find(v.is, /:(jppfs_cor:ProfitLossAttributableToOwnersOfParent|jpigp_cor:ProfitLossAttributableToOwnersOfParentIFRS)#/), v: "is" })],
      ["TA", (v) => ({ it: find(v.bs, /:(jppfs_cor:Assets|jpigp_cor:AssetsIFRS)#/, /^資産(の部)?合計$/), v: "bs" })],
      ["Eq", (v) => ({ it: find(v.bs, /:(jppfs_cor:NetAssets|jpigp_cor:EquityIFRS)#/, /^(純資産(の部)?合計|資本合計)$/), v: "bs" })],
      ["CFO", (v) => ({ it: find(v.cf, /:jp[a-z]+_cor:NetCashProvidedByUsedInOperatingActivities(IFRS)?#/), v: "cf" })],
      ["CFI", (v) => ({ it: find(v.cf, /:jp[a-z]+_cor:NetCashProvidedByUsedInInvest(ment|ing)Activities(IFRS)?#/), v: "cf" })],
      ["CFF", (v) => ({ it: find(v.cf, /:jp[a-z]+_cor:NetCashProvidedByUsedInFinancingActivities(IFRS)?#/), v: "cf" })],
    ];
    let dOk = 0;
    let dBad = 0;
    let dMiss = 0;
    for (const [k, r] of latest) {
      const [type, end] = k.split(":");
      const v = type === "FY" ? views.annual : views.quarter;
      const label = v.is.periods.find((p) => p.endDate === end && (type === "FY" ? !/LTM|H/.test(p.label) : / H1$/.test(p.label)))?.label;
      if (!label) continue;
      const diffs: string[] = [];
      for (const [field, get] of map) {
        const want = r[field];
        if (want == null || want === "") continue;
        const { it } = get(v);
        const got = it?.values[label];
        if (got == null) {
          dMiss++;
          diffs.push(`${field} 앱 빈칸(J-Quants ${fmt(Number(want))})`);
          continue;
        }
        if (got === Number(want)) dOk++;
        else {
          dBad++;
          // 앱 열은 그 기간을 실은 가장 나중 서류(이듬해 재작성 값) — 그 기간이 당기인 원 서류 값과도 비교해 재작성 여부를 밝힌다
          const k = (it!.accountId ?? "").replace(/^[a-z]+:/, "").replace(/#\d+$/, "");
          const per = v.is.periods.find((x) => x.label === label)!;
          const docs = type === "FY" ? src.annual : src.half;
          const orig = docs.filter((d) => (type === "FY" ? d.fin.fyEnd : d.fin.perEnd) === end).sort((x, y) => y.at.localeCompare(x.at))[0];
          const pk = field === "TA" || field === "Eq" ? `I${end}` : `D${type === "FY" ? orig?.fin.fyStart : orig?.fin.fyStart}_${end}`;
          const ov = orig?.fin.facts[k]?.[pk];
          const why = ov == null ? "원 서류 값 없음" : ov === Number(want) ? `원 서류 ${orig!.row._id} 값과 일치 → 이후 서류의 재작성 값` : `원 서류 ${orig!.row._id} ${fmt(ov)}`;
          diffs.push(`${field} 앱 ${fmt(got)} · J-Quants ${fmt(Number(want))} (${it!.accountName}; ${why})`);
          void per;
        }
      }
      if (diffs.length) console.log(`  D ${type} ${end}: ${diffs.join(" / ")}`);
    }
    console.log(`  D J-Quants 대조 일치 ${dOk}, 차이 ${dBad}, 앱 빈칸 ${dMiss}`);
    const a = views.annual.is.periods.map((p) => p.label).join(",");
    const h = views.quarter.is.periods.map((p) => p.label).join(",");
    summary.push(`${sym}\t${model.std}\t연간 ${a}\t반기 ${h}\tA ${calcN - calcBad}/${calcN}\tB ${bOk}/${bOk + bBad}\tC ${cOk}/${cOk + cBad}\tD ${dOk}/${dOk + dBad + dMiss}`);
  }
  console.log("\n" + summary.join("\n"));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
