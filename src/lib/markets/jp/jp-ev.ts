import "server-only";
import { getEodQuote } from "../quote";
import type { QuoteBar, TtmFlows, YahooSplit } from "../types";
import { addDays } from "./edinet-store";
import { longId, type JpColX, type JpFinModel, type JpFinView } from "./statements";
import type { JpStmtKind } from "./xbrl-fin";

/**
 * **일본 단일 기준 — EV·순차입금·EBITDA·EPS·주식수·PBR**(오너 결정 2026-10-08 — "일본 검증은 미국 기준으로, 앱 페이지 구성도 미국·한국을
 * 따른다"). 미국 `us/edgar-ev.ts`·`edgar-shares.ts`·`edgar-pershare.ts`, 한국 `kr/dart-ev.ts` 와 같은 역할 — 하이라이트·재무분석·개요
 * 멀티플(getTtm)·유니버스·컨센서스가 모두 여기서 값을 받는다. 화면마다 따로 계산하지 말 것.
 *
 * 입력 = 3대 재무제표 조립 결과(statements.ts — EDINET 본표 원본 줄, 열마다 출처 서류 하나) + 열 부가 정보(x — 경영지표 EPS·BPS·DPS·
 * 株式の総数等·리스부채 주석) + Yahoo 일봉(분할 이력 포함).
 *
 * 정의
 *  - EV = 시가총액 + 이자부 차입금(사채·차입금·CP·리스부채) + 비지배지분 − 현금성자산. 우선주: 일본 상장사는 보통주만(0).
 *    · 차입금 = 재무상태표 부채 구역의 차입금 줄(이름표 借入·社債·有利子負債·リース負債·リース債務·コマーシャル・ペーパー) 합 — 다른 맞는 줄의
 *      하위 줄은 빼서 이중 합산하지 않는다. 預金·貯金(은행업 예금)은 차입금 아님(미국 은행 규칙과 같음).
 *    · 리스부채(IFRS 16 — 한국과 같이 포함): 본표 줄 → 주석 문장이 차입금 줄에 포함한다고 밝히거나 차입금 줄 내역 문단에 리스부채 행이 있으면
 *      "그 줄에 포함" → 주석 리스부채 장부금액(xbrl-fin leaseNotes — 확인된 값) 가산 → 셋 다 아니면 확인 불가 = EV 공란(한국 krLeaseFor 와 같은
 *      원칙, 그림자 채우기 금지). 반기말(LTM)은 반기 보고서에 금액이 없으면 공란(표시 방법만 최근 有報 것을 따른다). J-GAAP 은 금융리스(リース債務 줄)만.
 *    · 차입금과 기타 금융부채가 한 줄(三菱重工)이면 차입금·EV 공란 + 사유(오너 결정 D4).
 *    · 현금성자산 = 유동자산의 現金及び現金同等物(IFRS)·現金及び預金(J-GAAP) + 定期預金·短期投資·有価証券(유동). その他の金融資産 은 제외
 *      (한국 "기타유동금융자산 제외"와 같음).
 *    · EV 미산정: 금융업(은행·보험 서식 — 예금·보험부채가 영업 부채), 금융사업 연결(재무상태표에 金融事業に係る債権 등 금융사업 자산 줄 —
 *      금융사업 차입금이 연결 차입금에 섞여 분리 불가, 미국 captive-unsplit 와 같음).
 *  - EBITDA = 영업이익 + 감가상각비. 영업이익 = 본표 営業利益 줄. 없으면 ① 事業利益(三菱重工 — 영업이익 자리 줄, 라벨 표시) ② 미국 규칙
 *    (세전이익 + 支払利息 − 持分法損益, 라벨 표시) ③ 支払利息 줄도 없으면 공란 + 사유. 감가상각비 = 현금흐름표 영업활동의 減価償却費·償却費 줄 합
 *    (본표 줄 그대로 — 손상이 함께 묶인 줄(三菱重工 "減価償却費、償却費及び減損損失")은 그대로, 따로 있는 減損損失 줄은 더하지 않는다 — 미국
 *    edgar-cf-structure 와 같은 원칙. J-GAAP のれん償却額(판관비 안 — 영업이익 안)은 포함).
 *  - EPS = 경영지표 희석 EPS(“－”·없음이면 기본 EPS) — 손익 열과 같은 서류. 주당 값(EPS·DPS)은 **현재 주식 기준**으로 분할 보정(Yahoo 분할
 *    이력) — 주가(Yahoo 종가 = 현재 기준)와 같은 기준으로 PER·배당수익률. EPS 는 그 서류 제출일 뒤 분할만 나눈다(일본 기준 — 제출일 전 분할은
 *    이미 소급), DPS 는 결산일 뒤 분할로 나눈다(배당은 기준일의 실제 주식 기준). 보정한 칸은 주석.
 *  - 주식수 = 그 기간 서류 자신의 기말 발행주식수 − 회사 명의 자기주식(自己株式等 표의 제출회사 행). 시가총액 = 그 날 실제 종가 × 그 주식수.
 *    기말 직전에 권리락된 분할(효력일은 기말 뒤 — 三菱重工 2024-03, 신에쓰 2023-03)은 주가가 이미 분할 후 기준이라 주식수 × 비율(제출일 발행주식수로 확인).
 *  - 자기자본(PBR·ROE 분모) = 지배주주 자본(IFRS 親会社の所有者に帰属する持分合計, J-GAAP 純資産 − 新株予約権 − 非支配株主持分).
 *  - 금융업(日本郵政 등 J-GAAP 은행·보험 서식): 매출 = 経常収益, EV·EBITDA 없음.
 */

export const JP_LTM = "현재/LTM";

// ── 본표 줄 읽기 ──
interface Ln {
  k: string;
  id: string;
  label: string;
  depth: number;
  ab: boolean;
  v: (number | null)[];
  /** 표시 구조 조상 개념(가까운 것부터) */
  anc: string[];
}
const local = (k: string) => k.slice(k.indexOf(":") + 1);

function linesOf(model: JpFinModel, view: JpFinView, kind: JpStmtKind): Ln[] {
  const st = view.stmts[kind];
  if (!st) return [];
  const out: Ln[] = [];
  const stack: { depth: number; k: string }[] = [];
  st.lines.forEach(([li, depth], r) => {
    const [sid, label, flags] = model.L[li];
    const id = longId(sid);
    const k = id.replace(/#\d+$/, "");
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    out.push({ k, id, label, depth, ab: (flags & 1) !== 0, v: st.v[r], anc: stack.map((s) => s.k).reverse() });
    stack.push({ depth, k });
  });
  return out;
}

type Pred = (l: Ln) => boolean;
const byK = (...ks: string[]): Pred => (l) => ks.includes(l.k);
const byLabel = (re: RegExp): Pred => (l) => re.test(l.label);

/** 우선순위 술어 차례로, 그 열에 값이 있는 첫 줄 */
function first(lines: Ln[], preds: Pred[], c: number): { v: number; l: Ln } | null {
  for (const p of preds) for (const l of lines) if (!l.ab && p(l) && l.v[c] != null) return { v: l.v[c]!, l };
  return null;
}
/** 술어에 맞는 줄 중 다른 맞는 줄의 하위가 아닌 줄의 합(그 열에 값이 있는 것만). 하나도 없으면 null */
function sumTop(lines: Ln[], pred: Pred, c: number): { v: number; parts: Ln[] } | null {
  const hit = lines.filter((l) => !l.ab && pred(l));
  const hitK = new Set(hit.map((l) => l.k));
  const parts = hit.filter((l) => !l.anc.some((a) => hitK.has(a)) && l.v[c] != null);
  if (!parts.length) return null;
  return { v: parts.reduce((a, l) => a + l.v[c]!, 0), parts };
}
const ancRe = (l: Ln, re: RegExp) => l.anc.some((a) => re.test(local(a)) && !/LiabilitiesAnd/.test(local(a)));
const inLiab = (l: Ln) => ancRe(l, /Liabilit|Labilit/) || /(CL|NCL)(IFRS)?$|LiabilitiesBNK$|LiabilitiesINS$/.test(local(l.k));
const inCurAssets = (l: Ln) => ancRe(l, /^CurrentAssets/) || /CA(IFRS)?$/.test(local(l.k));
const inCurLiab = (l: Ln) => ancRe(l, /^CurrentLiabilit/) || /CL(IFRS)?$/.test(local(l.k));
const inOpCf = (l: Ln) => ancRe(l, /OperatingActivities/) || /OpeCF(IFRS)?$/.test(local(l.k));
const inInvCf = (l: Ln) => ancRe(l, /Invest(ing|ment)Activities/) || /InvCF(IFRS)?$/.test(local(l.k));

// 長期債務 은 줄 이름 전체(日立 "償還期長期債務"·"長期債務") — "買掛金及びその他の短期債務"(ユニクロ)·"営業債務以外の短期債務"(伊藤忠) 같은 영업 채무 제외
const DEBT_RE = /借入|社債|有利子負債|リース負債|リース債務|コマーシャル・?ペーパー|借用金|^(償還期)?長期債務$|資金調達に係る債務/;
const DEBT_NOT = /預金|貯金|貸付|債権|資産|デリバティブ|未払|引当|利息|保証|担保/;
const isDebt: Pred = (l) => inLiab(l) && DEBT_RE.test(l.label) && !DEBT_NOT.test(l.label) && !/^(負債|流動負債|非流動負債|固定負債)/.test(l.label);
const isLease: Pred = (l) => isDebt(l) && /リース負債|リース債務/.test(l.label);
const isCash: Pred = (l) =>
  inCurAssets(l) &&
  (byK("jpigp_cor:CashAndCashEquivalentsIFRS", "jppfs_cor:CashAndDeposits", "jppfs_cor:CashAndCashEquivalents")(l) ||
    /^(現金及び現金同等物|現金及び預金|定期預金|短期投資|有価証券|短期運用有価証券|短期運用資産)$/.test(l.label));
// 금융사업 연결 — 금융사업 자산 줄(도요타 金融事業に係る債権, 소니 2025년 3월기까지 金融分野における投資及び貸付, 혼다 金融サービスに係る債権)
// セブン&アイ 銀行業における預金(セブン銀行) — 은행업 예금이 연결 부채에 있으면 금융사업 연결
const CAPTIVE_RE = /金融事業に係る債権|金融分野における投資及び貸付|金融事業に係る|金融サービスに係る債権|銀行業における/;

const REV_PREDS: Pred[] = [
  byLabel(/^(営業収益合計|売上収益合計|収益合計|売上高合計|売上高及び.*合計|営業収益及び.*合計)$/),
  byK(
    "jpigp_cor:RevenueIFRS",
    "jpigp_cor:Revenue2IFRS",
    "jpigp_cor:NetSalesIFRS",
    "jpigp_cor:OperatingRevenueIFRS",
    "jppfs_cor:NetSales",
    "jppfs_cor:OperatingRevenue1",
    "jppfs_cor:OperatingRevenue2",
    "jppfs_cor:NetSalesOfCompletedConstructionContracts",
    "jppfs_cor:OrdinaryIncomeBNK",
  ),
  byLabel(/^(売上高|売上収益|営業収益|収益|経常収益)$/),
];
const OP_PREDS: Pred[] = [byK("jpigp_cor:OperatingProfitLossIFRS", "jppfs_cor:OperatingIncome"), byLabel(/^営業(利益|損益)/)];
const BIZ_PROFIT: Pred = byLabel(/^事業利益/);
const PRETAX: Pred[] = [byK("jpigp_cor:ProfitLossBeforeTaxIFRS", "jppfs_cor:IncomeBeforeIncomeTaxes", "jppfs_cor:IncomeBeforeIncomeTaxesAndMinorityInterests")];
const INT_EXP: Pred[] = [byK("jpigp_cor:InterestExpensesIFRS", "jppfs_cor:InterestExpensesNOE")];
const EQ_METHOD: Pred = byK(
  "jpigp_cor:ShareOfProfitLossOfInvestmentsAccountedForUsingEquityMethodIFRS",
  "jppfs_cor:EquityInEarningsOfAffiliatesNOI",
);
const EQ_METHOD_LOSS: Pred = byK("jppfs_cor:EquityInLossesOfAffiliatesNOE");

/** 값 + 칸 주석 */
export interface Ser {
  v: (number | null)[];
  n: (string | null)[];
}
const ser = (len: number): Ser => ({ v: Array(len).fill(null), n: Array(len).fill(null) });

export interface JpCol {
  label: string;
  /** 기준일(LTM = 반기말 또는 최근 사업연도 말) */
  end: string;
  fy: number;
  kind: "fy" | "ltm";
}

/** 재무제표에서 읽은 값(주가 무관) — 열 = 사업연도 5개 + 현재/LTM */
export interface JpFund {
  std: string | null;
  cons: boolean;
  financial: boolean;
  cols: JpCol[];
  /** LTM 열이 최근 사업연도와 같은가(그 뒤 반기 보고서 없음) */
  ltmIsFy: boolean;
  rev: Ser;
  op: Ser;
  ordinary: Ser;
  pretax: Ser;
  tax: Ser;
  ni: Ser;
  gross: Ser;
  cogs: Ser;
  assets: Ser;
  liab: Ser;
  eqAll: Ser;
  eqParent: Ser;
  curA: Ser;
  curL: Ser;
  retained: Ser;
  ar: Ser;
  inv: Ser;
  ap: Ser;
  cash: Ser;
  debt: Ser;
  nci: Ser;
  /** 현금·차입금·비지배지분이 모두 있고 EV 를 막는 사유가 없을 때 차입금 + 비지배지분 − 현금, 아니면 null + 사유 */
  netDebtEv: Ser;
  /** 유동 차입금(ROIC 투하자본) */
  curDebt: Ser;
  ocf: Ser;
  capex: Ser;
  da: Ser;
  ebitda: Ser;
  intPaid: Ser;
  divPaid: Ser;
  /** 열 부가 정보(statements.ts) */
  x: JpColX[];
  /** 평균 잔액용 1년 전 재무상태표(LTM 열 = 전년 같은 반기말, 연도 열 = 앞 열) — 값 꺼내기 */
  bsPrev: (field: "assets" | "eqAll" | "eqParent" | "curL" | "ar" | "inv" | "ap" | "curDebt", c: number) => number | null;
  /** 표 아래 주석 */
  notes: string[];
}

export function jpFundamentals(model: JpFinModel): JpFund {
  const view = model.annual;
  const n = view.cols.length;
  const is = [...linesOf(model, view, "is")];
  const bs = linesOf(model, view, "bs");
  const cf = linesOf(model, view, "cf");
  // 금융업 서식 = 손익계산서가 은행·보험·증권 요소(…BNK·INS·SEC) — 재무상태표 줄 하나로 판정하지 않는다(セブン&アイ 의 コールマネー
  // CallMoneyLiabilitiesBNK 한 줄 때문에 소매업 전체가 금융 서식으로 잡혔다)
  const financial = is.some((l) => /(BNK|INS|SEC)$/.test(local(l.k)));
  const lastFyIdx = view.cols.map((c, i) => (c.label === JP_LTM ? -1 : i)).filter((i) => i >= 0).pop() ?? -1;
  const ltmIdx = view.cols.findIndex((c) => c.label === JP_LTM);
  const ltmIsFy = ltmIdx >= 0 && lastFyIdx >= 0 && view.cols[ltmIdx].endDate === view.cols[lastFyIdx].endDate;
  const cols: JpCol[] = view.cols.map((c) => ({
    label: c.label,
    end: c.endDate ?? "",
    fy: c.fiscalYear,
    kind: c.label === JP_LTM ? "ltm" : "fy",
  }));
  const x = view.x ?? cols.map(() => ({}) as JpColX);
  const notes: string[] = [];
  const S = () => ser(n);
  const f: JpFund = {
    std: model.std,
    cons: model.cons,
    financial,
    cols,
    ltmIsFy,
    rev: S(), op: S(), ordinary: S(), pretax: S(), tax: S(), ni: S(), gross: S(), cogs: S(),
    assets: S(), liab: S(), eqAll: S(), eqParent: S(), curA: S(), curL: S(), retained: S(), ar: S(), inv: S(), ap: S(),
    cash: S(), debt: S(), nci: S(), netDebtEv: S(), curDebt: S(),
    ocf: S(), capex: S(), da: S(), ebitda: S(), intPaid: S(), divPaid: S(),
    x,
    bsPrev: () => null,
    notes,
  };
  const ifrs = model.std === "IFRS";
  const set = (s: Ser, c: number, r: { v: number } | null, why: string) => {
    s.v[c] = r ? r.v : null;
    if (!r) s.n[c] = why;
  };
  const NOLINE = "본표에 해당 줄 없음";

  // 리스부채 "차입금 줄에 포함" 판정(본표에 リース負債 줄 없는 IFRS) — ① 주석 문장이 차입금 줄 이름을 대며 리스부채를 거기에 포함한다고 밝힘
  // ② 리스부채 행이 든 주석 표의 合計 = 차입금 줄(들)의 합(백만엔, 정확히). 표시 방법은 서류 단위라 같은 서류의 다른 열에서 확인되면 그 열도 포함
  // (소니 2024 有報의 2022-03-31 열 — 그 날짜 合計가 서류에 없음). 차입금 줄 개념이 같을 때만.
  const leaseIncl: ({ names: Ln[]; how: string } | null)[] = Array(n).fill(null);
  if (ifrs) {
    for (let c = 0; c < n; c++) {
      const xl = x[c].lease;
      const parts = sumTop(bs, isDebt, c)?.parts ?? [];
      if (!xl || !parts.length || sumTop(bs, isLease, c)) continue;
      const src = `${xl.policyDoc ? `${xl.policyDoc}(최근 有報 표시 방법) · ` : ""}${xl.doc}`;
      const inclS = xl.incl.find((t) => parts.some((l) => t.includes(l.label)));
      if (inclS) {
        leaseIncl[c] = { names: parts.filter((l) => inclS.includes(l.label)), how: `주석 "…${inclS.slice(-60)}に含め…"(${src})` };
        continue;
      }
      const ps = parts.slice(0, 8);
      outer: for (const t of xl.rows) {
        for (let b = 1; b < 1 << ps.length; b++) {
          const ls = ps.filter((_, i) => b & (1 << i));
          const m = ls.reduce((a, l) => a + l.v[c]!, 0) / 1e6;
          if ((xl.sums[t] ?? []).includes(m)) {
            leaseIncl[c] = { names: ls, how: `리스부채 행이 든 주석 표(${t.replace(/^Notes|ConsolidatedFinancialStatements.*$/g, "")})의 合計 ${m.toLocaleString("en-US")}백만엔 = 이 줄 합(${src})` };
            break outer;
          }
        }
      }
    }
    for (let c = 0; c < n; c++) {
      const xl = x[c].lease;
      if (leaseIncl[c] || !xl || xl.amt != null) continue;
      const parts = sumTop(bs, isDebt, c)?.parts ?? [];
      const ks = parts.map((l) => l.k).sort().join(",");
      const o = leaseIncl.findIndex((r, j) => r && x[j].lease?.doc === xl.doc && (sumTop(bs, isDebt, j)?.parts ?? []).map((l) => l.k).sort().join(",") === ks);
      if (o >= 0) leaseIncl[c] = { names: leaseIncl[o]!.names.filter((l) => parts.some((p) => p.k === l.k)), how: `같은 서류 ${cols[o].label} 열에서 확인 — ${leaseIncl[o]!.how}` };
    }
  }

  for (let c = 0; c < n; c++) {
    // ── 손익 ──
    set(f.rev, c, first(is, REV_PREDS, c), NOLINE);
    const op = first(is, OP_PREDS, c);
    if (op) f.op.v[c] = op.v;
    else if (!financial) {
      const biz = first(is, [BIZ_PROFIT], c);
      const pt = first(is, PRETAX, c);
      const ie = first(is, INT_EXP, c);
      if (biz) {
        f.op.v[c] = biz.v;
        f.op.n[c] = `본표에 営業利益 줄 없음 — ${biz.l.label} 줄(영업이익 자리) 사용`;
      } else if (pt && ie) {
        const eq = sumTop(is, EQ_METHOD, c)?.v ?? 0;
        const eqLoss = sumTop(is, EQ_METHOD_LOSS, c)?.v ?? 0;
        f.op.v[c] = pt.v + Math.abs(ie.v) - eq + eqLoss;
        f.op.n[c] = `본표에 営業利益 줄 없음 — 세전이익 + 支払利息${eq || eqLoss ? " − 持分法損益" : ""} 근사(미국 기준과 같음)`;
      } else f.op.n[c] = `본표에 営業利益 줄 없음 — ${pt ? "支払利息 줄도 없어(財務費用 등 합산 줄만)" : "세전이익 줄도 없어"} 영업이익 근사 안 함`;
    } else f.op.n[c] = "금융업 서식 — 営業利益 없음(経常利益 참고)";
    set(f.ordinary, c, first(is, [byK("jppfs_cor:OrdinaryIncome")], c), NOLINE);
    set(f.pretax, c, first(is, PRETAX, c), NOLINE);
    const taxTot = first(is, [byK("jpigp_cor:IncomeTaxExpenseIFRS", "jppfs_cor:IncomeTaxes")], c);
    if (taxTot) f.tax.v[c] = taxTot.v;
    else {
      const t = sumTop(is, byK("jppfs_cor:IncomeTaxesCurrent", "jppfs_cor:IncomeTaxesDeferred"), c);
      f.tax.v[c] = t?.v ?? null;
      if (!t) f.tax.n[c] = NOLINE;
    }
    const niP = first(
      is,
      [
        byK("jpigp_cor:ProfitLossAttributableToOwnersOfParentIFRS", "jppfs_cor:ProfitLossAttributableToOwnersOfParent"),
        ...(model.cons ? [] : [byK("jppfs_cor:ProfitLoss", "jppfs_cor:NetIncome", "jpigp_cor:ProfitLossIFRS")]),
      ],
      c,
    );
    set(f.ni, c, niP, "본표에 親会社株主(所有者)に帰属する当期純利益 줄 없음");
    set(f.gross, c, first(is, [byK("jpigp_cor:GrossProfitIFRS", "jppfs_cor:GrossProfit")], c), NOLINE);
    set(f.cogs, c, first(is, [byK("jpigp_cor:CostOfSalesIFRS", "jppfs_cor:CostOfSales")], c), NOLINE);

    // ── 재무상태표 ──
    set(f.assets, c, first(bs, [byK("jpigp_cor:AssetsIFRS", "jppfs_cor:Assets")], c), NOLINE);
    set(f.liab, c, first(bs, [byK("jpigp_cor:LiabilitiesIFRS", "jppfs_cor:Liabilities")], c), NOLINE);
    const eqAll = first(bs, [byK("jpigp_cor:EquityIFRS", "jppfs_cor:NetAssets")], c);
    set(f.eqAll, c, eqAll, NOLINE);
    const nciL = first(bs, [byK("jpigp_cor:NonControllingInterestsIFRS", "jppfs_cor:NonControllingInterests")], c);
    f.nci.v[c] = nciL ? nciL.v : eqAll ? 0 : null;
    if (ifrs) set(f.eqParent, c, first(bs, [byK("jpigp_cor:EquityAttributableToOwnersOfParentIFRS")], c), NOLINE);
    else if (eqAll) {
      const sr = first(bs, [byK("jppfs_cor:SubscriptionRightsToShares")], c)?.v ?? 0;
      f.eqParent.v[c] = eqAll.v - (nciL?.v ?? 0) - sr;
    } else f.eqParent.n[c] = NOLINE;
    set(f.curA, c, first(bs, [byK("jpigp_cor:CurrentAssetsIFRS", "jppfs_cor:CurrentAssets")], c), NOLINE);
    set(f.curL, c, first(bs, [byK("jpigp_cor:TotalCurrentLiabilitiesIFRS", "jppfs_cor:CurrentLiabilities")], c), NOLINE);
    set(f.retained, c, first(bs, [byK("jpigp_cor:RetainedEarningsIFRS", "jppfs_cor:RetainedEarnings")], c), NOLINE);
    set(f.ar, c, first(bs, [(l) => inCurAssets(l) && /^(営業債権|受取手形|売掛金|売上債権|営業債権及び)/.test(l.label)], c), NOLINE);
    const inv = sumTop(bs, (l) => inCurAssets(l) && /^(棚卸資産|商品及び製品|仕掛品|原材料及び貯蔵品|商品|製品|原材料|貯蔵品|販売用不動産|未成工事支出金)/.test(l.label), c);
    set(f.inv, c, inv, NOLINE);
    set(f.ap, c, first(bs, [(l) => inCurLiab(l) && /^(営業債務|支払手形|買掛金|仕入債務|電子記録債務)/.test(l.label)], c), NOLINE);

    // 차입금·현금 — EV 브릿지
    const cash = sumTop(bs, isCash, c);
    set(f.cash, c, cash, "현금성자산 줄 없음");
    const debt = sumTop(bs, isDebt, c);
    const leaseFace = sumTop(bs, isLease, c);
    let debtV = debt?.v ?? (eqAll ? 0 : null);
    let leaseNote: string | null = null;
    let leaseUnknown: string | null = null;
    if (ifrs && !financial && !leaseFace && eqAll) {
      // 본표에 리스부채 줄 없음(한국 krLeaseFor 와 같은 원칙): ① 차입금 줄에 포함(leaseIncl — 위 판정)이면 그대로 ② 아니면 주석 리스부채
      // 장부금액(xbrl-fin leaseNotes — 표 둘 이상·변동표 사슬로 확인된 값)을 가산 ③ 못 정하면 EV 공란 + 사유
      const xl = x[c].lease;
      const inc = leaseIncl[c];
      if (inc) leaseNote = `리스부채는 차입금 줄(${[...new Set(inc.names.map((l) => l.label))].join("·")})에 포함 — ${inc.how}`;
      else if (xl?.amt != null) {
        debtV = (debtV ?? 0) + xl.amt;
        leaseNote = `리스부채 ${Math.round(xl.amt / 1e6).toLocaleString("en-US")}백만엔 주석 가산(${xl.how}, ${xl.doc})`;
      } else leaseUnknown = `리스부채 확인 불가(본표에 リース負債 줄 없음 · ${xl?.why ?? "주석 판독 없음"}${xl ? `, ${xl.doc}` : ""})`;
    }
    // 차입금과 기타 금융부채가 한 줄(三菱重工 "社債、借入金及びその他の金融負債") — 차입금만 나눌 숫자 요소가 주석에 없으면 공란 + 사유
    // (오너 결정 2026-10-09 D4 — 그림자 채우기 금지. 기타 금융부채(미지급금 등)를 넣으면 EV 과대)
    const mixed = debt?.parts.find((l) => /その他の金融負債/.test(l.label));
    const mixedWhy = mixed ? `차입금 줄 "${mixed.label}"이 기타 금융부채를 포함한 한 줄 — 차입금만 나눌 숫자 요소 없음(오너 결정 D4)` : null;
    f.debt.v[c] = mixed ? null : debtV;
    if (leaseUnknown) f.debt.n[c] = `${leaseUnknown} — 본표 차입금 줄만`;
    if (leaseNote) f.debt.n[c] = leaseNote;
    if (mixedWhy) f.debt.n[c] = mixedWhy;
    const cd = sumTop(bs, (l) => isDebt(l) && inCurLiab(l), c);
    f.curDebt.v[c] = mixed ? null : (cd?.v ?? (eqAll ? 0 : null));
    if (mixedWhy) f.curDebt.n[c] = mixedWhy;
    const captive = bs.find((l) => !l.ab && CAPTIVE_RE.test(l.label) && l.v[c] != null);
    if (financial) f.netDebtEv.n[c] = "금융업(은행·보험 서식) — EV 미산정";
    else if (captive) f.netDebtEv.n[c] = `금융사업 연결(${captive.label} — 금융사업 차입금이 연결 차입금에 섞여 분리 불가) — EV 미산정`;
    else if (mixedWhy) f.netDebtEv.n[c] = `${mixedWhy} — EV 공란`;
    else if (leaseUnknown) f.netDebtEv.n[c] = `${leaseUnknown} — EV 공란`;
    else if (f.cash.v[c] == null || debtV == null) f.netDebtEv.n[c] = f.cash.v[c] == null ? "현금성자산 없음" : "차입금 없음";
    else f.netDebtEv.v[c] = debtV + (f.nci.v[c] ?? 0) - f.cash.v[c]!;

    // ── 현금흐름표 ──
    set(f.ocf, c, first(cf, [byK("jpigp_cor:NetCashProvidedByUsedInOperatingActivitiesIFRS", "jppfs_cor:NetCashProvidedByUsedInOperatingActivities")], c), NOLINE);
    const capex = sumTop(cf, (l) => inInvCf(l) && /有形固定資産/.test(l.label) && /(取得|購入)/.test(l.label) && !/売却/.test(l.label), c);
    f.capex.v[c] = capex ? Math.abs(capex.v) : null;
    if (!capex) f.capex.n[c] = "현금흐름표에 有形固定資産の取得 줄 없음";
    const da = sumTop(
      cf,
      (l) => inOpCf(l) && /減価償却|償却費|のれん償却額/.test(l.label) && !/繰延保険契約費|社債|割引|株式報酬|保険/.test(l.label),
      c,
    );
    f.da.v[c] = da?.v ?? null;
    if (!da) f.da.n[c] = financial ? "금융업 — 미산정" : "현금흐름표에 減価償却費 줄 없음";
    if (f.op.v[c] != null && f.da.v[c] != null && !financial) f.ebitda.v[c] = f.op.v[c]! + f.da.v[c]!;
    else f.ebitda.n[c] = financial ? "금융업 — EBITDA 미산정" : (f.op.n[c] ?? f.da.n[c] ?? "영업이익·감가상각비 없음");
    if (f.op.n[c] && f.ebitda.v[c] != null) f.ebitda.n[c] = f.op.n[c];
    const ip = sumTop(cf, byLabel(/利息の支払/), c);
    f.intPaid.v[c] = ip ? Math.abs(ip.v) : null;
    if (!ip) f.intPaid.n[c] = "현금흐름표에 利息の支払額 줄 없음";
    const dv = sumTop(cf, (l) => /配当金の支払|への配当金の支払|に対する配当金の支払/.test(l.label) && !/非支配/.test(l.label), c);
    f.divPaid.v[c] = dv ? Math.abs(dv.v) : null;
    if (!dv) f.divPaid.n[c] = "현금흐름표에 配当金の支払額 줄 없음";
  }

  // 평균 잔액용 1년 전 재무상태표 — 연도 열은 앞 열(1년 차이일 때만), LTM 열은 반기말이면 반기 화면의 1년 전 같은 반기말
  const half = model.half;
  const hbs = linesOf(model, half, "bs");
  const prevHalfIdx = (() => {
    if (ltmIdx < 0 || ltmIsFy) return -1;
    const want = `${Number(cols[ltmIdx].end.slice(0, 4)) - 1}${cols[ltmIdx].end.slice(4)}`;
    return half.cols.findIndex((p) => p.endDate === want);
  })();
  const halfVal = (field: string, hc: number): number | null => {
    if (hc < 0) return null;
    const g = (preds: Pred[]) => first(hbs, preds, hc)?.v ?? null;
    switch (field) {
      case "assets":
        return g([byK("jpigp_cor:AssetsIFRS", "jppfs_cor:Assets")]);
      case "eqAll":
        return g([byK("jpigp_cor:EquityIFRS", "jppfs_cor:NetAssets")]);
      case "eqParent": {
        if (ifrs) return g([byK("jpigp_cor:EquityAttributableToOwnersOfParentIFRS")]);
        const e = g([byK("jppfs_cor:NetAssets")]);
        return e == null ? null : e - (g([byK("jppfs_cor:NonControllingInterests")]) ?? 0) - (g([byK("jppfs_cor:SubscriptionRightsToShares")]) ?? 0);
      }
      case "curL":
        return g([byK("jpigp_cor:TotalCurrentLiabilitiesIFRS", "jppfs_cor:CurrentLiabilities")]);
      case "ar":
        return g([(l) => inCurAssets(l) && /^(営業債権|受取手形|売掛金|売上債権|営業債権及び)/.test(l.label)]);
      case "inv":
        return sumTop(hbs, (l) => inCurAssets(l) && /^(棚卸資産|商品及び製品|仕掛品|原材料及び貯蔵品|商品|製品|原材料|貯蔵品|販売用不動産|未成工事支出金)/.test(l.label), hc)?.v ?? null;
      case "ap":
        return g([(l) => inCurLiab(l) && /^(営業債務|支払手形|買掛金|仕入債務|電子記録債務)/.test(l.label)]);
      case "curDebt":
        return sumTop(hbs, (l) => isDebt(l) && inCurLiab(l), hc)?.v ?? 0;
    }
    return null;
  };
  f.bsPrev = (field, c) => {
    const cur = cols[c];
    if (cur.kind === "ltm") {
      if (ltmIsFy) return lastFyIdx > 0 && oneYearApart(cols[lastFyIdx - 1].end, cols[lastFyIdx].end) ? (f[field] as Ser).v[lastFyIdx - 1] : null;
      return halfVal(field, prevHalfIdx);
    }
    return c > 0 && cols[c - 1].kind === "fy" && oneYearApart(cols[c - 1].end, cur.end) ? (f[field] as Ser).v[c - 1] : null;
  };

  // 주석
  if (cols.some((_, c) => f.op.n[c]?.startsWith("본표에 営業利益 줄 없음 — 세전이익"))) notes.push("영업이익(본표 줄 없음) = 세전이익 + 支払利息 − 持分法損益 근사(미국 기준과 같음) — EBITDA 도 이 값 기준");
  f.notes = [...new Set(notes)];
  return f;
}

const oneYearApart = (a: string, b: string) => {
  const d = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5;
  return d >= 350 && d <= 380;
};

// ── 주가(Yahoo — 현재 주식 기준 종가 + 분할 이력) ──
export interface JpPx {
  bars: QuoteBar[];
  splits: YahooSplit[];
  /** Yahoo 분할 이력을 받았나(아니면 연도 열 주식 기준 보정 불가 — 시가총액·PER 공란) */
  hasSplits: boolean;
  last: number | null;
  lastDate: string | null;
  warn: string[];
}
export async function loadJpPx(symbol: string): Promise<JpPx> {
  const q = await getEodQuote("jp", symbol, { from: "2019-01-01" });
  return {
    bars: q.bars,
    splits: q.splits ?? [],
    hasSplits: q.splits !== undefined,
    last: q.last,
    lastDate: q.lastDate,
    warn: [...(q.warnings ?? []), ...(q.splits === undefined ? [`시세 ${q.source} — 분할 이력 없음(연도 열 시가총액·PER 공란)`] : [])],
  };
}
/** 기준일 d 에 그 날 이전 마지막 거래일 봉(10일 안) */
function barOn(px: JpPx, d: string): QuoteBar | null {
  let best: QuoteBar | null = null;
  for (const b of px.bars) if (b.date <= d && b.close != null) best = b;
  return best && best.date >= addDays(d, -10) ? best : null;
}
/** d 뒤 분할 비율의 곱 — Yahoo 종가(현재 기준) × 이 값 = d 시점 기준 가격 */
const splitsAfter = (px: JpPx, d: string) => px.splits.filter((s) => s.date > d).reduce((a, s) => a * s.ratio, 1);
const splitsBetween = (px: JpPx, a: string, b: string) => px.splits.filter((s) => s.date > a && s.date <= b);

/** 주가·시가총액·주당 값(현재 주식 기준)·멀티플 — 하이라이트·재무분석·개요·컨센서스 공통 */
export interface JpVal {
  /** 열 주가(현재 주식 기준 종가; LTM = 현재가) */
  price: (number | null)[];
  mcap: Ser;
  /** 시가총액 주식수(그 날 실제 주식 기준) */
  shares: Ser;
  /** 현재 주식 기준 EPS·DPS */
  eps: Ser;
  bps: Ser;
  dps: Ser;
  divYield: Ser;
  ev: Ser;
  per: Ser;
  pbr: Ser;
  psr: Ser;
  evEbitda: Ser;
  roe: Ser;
  notes: string[];
}

export function jpValuation(f: JpFund, px: JpPx | null): JpVal {
  const n = f.cols.length;
  const S = () => ser(n);
  const v: JpVal = { price: Array(n).fill(null), mcap: S(), shares: S(), eps: S(), bps: S(), dps: S(), divYield: S(), ev: S(), per: S(), pbr: S(), psr: S(), evEbitda: S(), roe: S(), notes: [] };
  const firstBar = px?.bars.find((b) => b.close != null)?.date ?? null;
  const lastFyIdx = f.cols.map((c, i) => (c.kind === "fy" ? i : -1)).filter((i) => i >= 0).pop() ?? -1;

  // 열 주식수(그 날 실제 기준) — 기말 직전 권리락 분할은 × 비율
  const sharesAt = (c: number): { v: number | null; why: string | null; at: string | null } => {
    const x = f.x[c];
    if (x.sh == null) return { v: null, why: x.shWhy ?? "주식수 판독 없음", at: null };
    const at = x.shAt ?? f.cols[c].end;
    if (px) {
      const s = px.splits.find((s) => s.date <= at && s.date > addDays(at, -10));
      if (s && x.shIssued && x.shIssuedFiling && Math.abs(x.shIssuedFiling / x.shIssued - s.ratio) < 0.01 * s.ratio)
        return { v: x.sh * s.ratio, why: `기말 직전 분할 권리락(${s.date}, 1:${s.ratio}) — 주가가 분할 후 기준이라 기말 주식수 × ${s.ratio}`, at };
    }
    return { v: x.sh, why: null, at };
  };

  for (let c = 0; c < n; c++) {
    const col = f.cols[c];
    const x = f.x[c];
    const isLtm = col.kind === "ltm";
    // 주가
    let price: number | null = null;
    let actual: number | null = null;
    let priceWhy: string | null = null;
    if (!px) priceWhy = "시세 조회 실패";
    else if (isLtm) {
      price = actual = px.last;
      if (price == null) priceWhy = "현재가 없음";
    } else {
      const b = barOn(px, col.end);
      if (!b) priceWhy = firstBar && firstBar > col.end ? `상장 전(첫 거래일 ${firstBar})` : `${col.end} 주가 없음`;
      else if (!px.hasSplits) priceWhy = "분할 이력 없음 — 주식 기준 보정 불가";
      else {
        price = b.close!;
        actual = b.close! * splitsAfter(px, b.date);
      }
    }
    v.price[c] = price;
    // 주식수·시가총액
    const sh = isLtm
      ? (() => {
          const base = sharesAt(c);
          if (base.v == null || !px) return base;
          const after = splitsBetween(px, base.at!, "9999-12-31");
          const fac = after.reduce((a, s) => a * s.ratio, 1);
          return fac === 1 ? base : { v: base.v * fac, why: `${base.at} 주식수 × 그 뒤 분할(${after.map((s) => `${s.date} 1:${s.ratio}`).join(", ")})`, at: base.at };
        })()
      : sharesAt(c);
    v.shares.v[c] = sh.v;
    v.shares.n[c] = sh.why;
    if (actual != null && sh.v != null) {
      v.mcap.v[c] = actual * sh.v;
      if (sh.why) v.mcap.n[c] = sh.why;
    } else v.mcap.n[c] = priceWhy ?? sh.why ?? "주식수 없음";

    // EPS(현재 주식 기준)
    if (isLtm && !f.ltmIsFy) {
      // 반기 보고서 뒤 LTM — 지배 순이익 LTM ÷ 현재 주식수(주당 지표에 흐름식 금지, 미국 ltmEps 와 같은 규칙)
      if (f.ni.v[c] != null && sh.v) {
        v.eps.v[c] = f.ni.v[c]! / sh.v;
        v.eps.n[c] = "LTM 지배 순이익 ÷ 현재 유통주식수(공시 EPS 아님)";
      } else v.eps.n[c] = f.ni.n[c] ?? sh.why ?? "주식수 없음";
    } else {
      const xs = isLtm ? f.x[lastFyIdx] : x;
      const e = xs?.eps ?? null;
      if (e == null) v.eps.n[c] = "경영지표·본표에 EPS 없음";
      else if (!px || !px.hasSplits) {
        v.eps.v[c] = e;
        if (px && !px.hasSplits) v.eps.n[c] = "분할 이력 없음 — 공시 원값(분할 보정 안 함)";
      } else {
        const at = (xs!.epsAt ?? "").slice(0, 10);
        const fac = splitsAfter(px, at);
        v.eps.v[c] = e / fac;
        const kind = xs!.epsK === "basic" ? "기본 EPS(희석 EPS “－” — 희석 증권 없음)" : xs!.epsK === "face" ? "본표 EPS 줄(경영지표에 없음)" : null;
        const adj = fac !== 1 ? `공시 ${e} ÷ ${fac}(${at} 제출 뒤 분할 보정)` : null;
        if (kind || adj) v.eps.n[c] = [kind, adj].filter(Boolean).join(" · ");
      }
    }
    // DPS(현재 주식 기준) — LTM 은 최근 사업연도 그대로일 때만
    const xd = isLtm ? (f.ltmIsFy ? f.x[lastFyIdx] : null) : x;
    if (!xd) v.dps.n[c] = "반기 보고서 뒤 12개월 배당 — 미산정";
    else if (xd.dps == null && xd.dpsNil) {
      v.dps.v[c] = 0;
      v.dps.n[c] = "무배당(경영지표 1株当たり配当額 “－”)";
    } else if (xd.dps == null) v.dps.n[c] = "경영지표에 1株当たり配当額 없음";
    else {
      // 배당은 배당기준일(중간·기말)의 실제 주식 기준 — EPS 와 달리 결산일 뒤 분할로 재작성하지 않는다(신에쓰 2023년 3월기 DPS 500 =
      // 2023-04-01 1:5 분할 전 기준). 결산일 뒤 분할 + 기말 직전 권리락 분할(효력일은 결산일 뒤)로 나눈다
      const fi = isLtm ? lastFyIdx : c;
      const end = f.cols[fi].end;
      const win = px ? px.splits.find((s) => s.date <= end && s.date > addDays(end, -10)) : undefined;
      const xw = f.x[fi];
      const winOk = win && xw.shIssued && xw.shIssuedFiling && Math.abs(xw.shIssuedFiling / xw.shIssued - win.ratio) < 0.01 * win.ratio;
      const fac = px?.hasSplits ? splitsAfter(px, end) * (winOk ? win!.ratio : 1) : 1;
      v.dps.v[c] = xd.dps / fac;
      const notes: string[] = [];
      if (fac !== 1) notes.push(`공시 ${xd.dps} ÷ ${fac}(결산일 ${end} 기준 → 현재 주식 기준 분할 보정)`);
      // 기중 분할 — 중간 배당(분할 전)과 기말 배당(분할 후)의 주식 기준이 다르다(공시 합계 그대로, 도요타 2022년 3월기 148 = 120 + 28)
      const start = addDays(f.cols[fi - 1]?.end ?? addDays(end, -365), 1);
      const mid = px?.splits.filter((s) => s.date >= start && s.date <= addDays(end, -10)) ?? [];
      if (mid.length && xd.dpsInterim) notes.push(`기중 분할(${mid.map((s) => `${s.date} 1:${s.ratio}`).join(", ")}) — 중간·기말 배당의 주식 기준이 달라 공시 합계 그대로`);
      if (notes.length) v.dps.n[c] = notes.join(" · ");
    }
    if (v.dps.v[c] != null && price) v.divYield.v[c] = (v.dps.v[c]! / price) * 100;

    // 멀티플 — 분모 0 이하면 비운다(전 화면 공통 부호 규칙)
    const pos = (a: number | null, b: number | null) => (a != null && b != null && b > 0 ? a / b : null);
    v.per.v[c] = pos(price, v.eps.v[c]);
    if (v.per.v[c] == null) v.per.n[c] = price == null ? priceWhy : v.eps.v[c] == null ? v.eps.n[c] : "적자(EPS ≤ 0) — PER 미표시";
    else if (v.eps.n[c]) v.per.n[c] = v.eps.n[c];
    // BPS(현재 주식 기준) = 지배주주 자본 × 주가 ÷ 시가총액 — 주가 ÷ BPS = PBR 이 되게(시가총액과 같은 주식수)
    v.bps.v[c] = price && v.mcap.v[c] && f.eqParent.v[c] != null ? (f.eqParent.v[c]! * price) / v.mcap.v[c]! : null;
    if (v.bps.v[c] == null) v.bps.n[c] = f.eqParent.v[c] == null ? f.eqParent.n[c] : v.mcap.n[c];
    v.pbr.v[c] = pos(v.mcap.v[c], f.eqParent.v[c]);
    if (v.pbr.v[c] == null) v.pbr.n[c] = v.mcap.v[c] == null ? v.mcap.n[c] : f.eqParent.v[c] == null ? f.eqParent.n[c] : "자본잠식(자본 ≤ 0) — PBR 미표시";
    v.psr.v[c] = pos(v.mcap.v[c], f.rev.v[c]);
    if (v.psr.v[c] == null) v.psr.n[c] = v.mcap.v[c] == null ? v.mcap.n[c] : f.rev.n[c];
    // EV
    if (f.netDebtEv.v[c] != null && v.mcap.v[c] != null) v.ev.v[c] = v.mcap.v[c]! + f.netDebtEv.v[c]!;
    else v.ev.n[c] = f.netDebtEv.n[c] ?? v.mcap.n[c];
    v.evEbitda.v[c] = pos(v.ev.v[c], f.ebitda.v[c]);
    if (v.evEbitda.v[c] == null) v.evEbitda.n[c] = v.ev.v[c] == null ? v.ev.n[c] : f.ebitda.v[c] == null ? f.ebitda.n[c] : "EBITDA ≤ 0 — 미표시";
    else if (f.ebitda.n[c]) v.evEbitda.n[c] = f.ebitda.n[c];
    // ROE = 지배 순이익 ÷ 평균 지배주주 자본(기초 없으면 공란 — 평균이 아님)
    const eqPrev = f.bsPrev("eqParent", c);
    const eqAvg = f.eqParent.v[c] != null && eqPrev != null ? (f.eqParent.v[c]! + eqPrev) / 2 : null;
    v.roe.v[c] = f.ni.v[c] != null && eqAvg ? (f.ni.v[c]! / eqAvg) * 100 : null;
    if (v.roe.v[c] == null) v.roe.n[c] = eqAvg == null ? "기초 자본 없음(평균 불가)" : f.ni.n[c];
  }
  if (px?.warn.length) v.notes.push(...px.warn.map((w) => `⚠ ${w}`));
  return v;
}

/**
 * 개요 멀티플·유니버스용 TTM 스냅샷(adapter.getTtm) — 미국 getTtm 과 같은 꼴(computeTrailingMultiples 의 스냅샷 경로가 그대로 쓴다).
 * 값은 위 함수들 그대로 — 하이라이트 LTM 열과 같은 값.
 */
export function jpTtmFromModel(model: JpFinModel, px: JpPx | null): TtmFlows {
  const f = jpFundamentals(model);
  const val = jpValuation(f, px);
  const c = f.cols.findIndex((x) => x.kind === "ltm");
  if (c < 0) {
    const error = "EDINET 有価証券報告書 사업연도 열 없음";
    return { periodLabel: "", error, netIncome: null, revenue: null, opIncome: null, eps: null };
  }
  const fyIdx = f.cols.map((x, i) => (x.kind === "fy" ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const fyCol = fyIdx >= 0 ? f.cols[fyIdx] : null;
  const reasons: NonNullable<TtmFlows["reasons"]> = {};
  const r = (k: keyof NonNullable<TtmFlows["reasons"]>, s: string | null | undefined) => {
    if (s) reasons[k] = s;
  };
  r("revenue", f.rev.n[c]);
  r("opIncome", f.op.n[c]);
  r("netIncome", f.ni.n[c]);
  r("eps", val.eps.n[c]);
  r("daTtm", f.da.n[c]);
  r("equity", f.eqParent.n[c]);
  r("evNetDebt", f.netDebtEv.n[c]);
  r("evShares", val.shares.n[c]);
  r("fyEps", fyIdx >= 0 ? val.eps.n[fyIdx] : "사업연도 없음");
  r("dpsTtm", val.dps.n[c]);
  const blocker = f.financial ? "financial" : f.netDebtEv.n[c]?.startsWith("금융사업 연결") ? "captive-unsplit" : null;
  const dpsFy = fyIdx >= 0 ? val.dps.v[fyIdx] : null;
  return {
    periodLabel: f.ltmIsFy ? `${fyCol?.label ?? ""}(그 뒤 반기 보고서 아직 없음)` : `${fyCol?.label ?? ""} + 반기 − 전년 반기(${f.cols[c].end})`,
    netIncome: f.ni.v[c],
    revenue: f.rev.v[c],
    opIncome: f.op.v[c],
    eps: val.eps.v[c],
    fyEps: { eps: fyIdx >= 0 ? val.eps.v[fyIdx] : null, year: fyCol?.fy ?? null, note: fyIdx >= 0 ? val.eps.n[fyIdx] : null },
    daTtm: f.da.v[c],
    daAnnual: fyIdx >= 0 ? f.da.v[fyIdx] : null,
    dpsAnnual: dpsFy != null && fyCol ? { dps: dpsFy, label: fyCol.label } : null,
    dpsTtm:
      val.dps.v[c] != null && f.ltmIsFy && fyCol
        ? { dps: val.dps.v[c]!, from: addDays(addDays(fyCol.end, 1), -365), to: fyCol.end }
        : null,
    reasons,
    snapshot: {
      label: f.cols[c].end,
      equity: f.eqParent.v[c],
      liabilities: f.liab.v[c],
      cash: f.cash.v[c],
      shares: val.shares.v[c],
      evShares: val.shares.v[c],
      evNetDebt: blocker ? null : f.netDebtEv.v[c],
      evBlocker: blocker,
    },
  };
}
