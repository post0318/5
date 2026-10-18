/**
 * 검증기 — B16 ②b "기타(유동)금융자산" 계열 줄의 현금성 부분(2026-10-18 다시 짬). 앱 적재 스크립트(populate-kr-da.mjs)를 읽지 않고 규칙 문장만 보고 따로 짠 판독.
 *
 * 규칙 근거(이 두 문장만 본다):
 *  ① 오너 결정 2026-10-18: "기타(유동)금융자산 계열 줄은 주석 내역 중 예금성(정기예금·단기금융상품·장단기금융상품·예치금·채무상품, 사용제한 예금·동반성장예탁금
 *     포함) + 투자성(FVPL 펀드·MMF·국공채·채권·특정금전신탁·저축성보험)만 현금성자산, 대여금·보증금·미수금·파생상품·확정계약자산 제외. 유동분 내역 미공시는 제외 + 주석."
 *  ② CLAUDE.md 「한국 EV·차입금 단일 기준」: 현금성자산 = 현금및현금성자산 + 단기금융상품 + 단기투자자산 + 유동 상각후원가·FVPL 금융자산(네이버 WiseReport 정의).
 *
 * 방식 — **원문 표를 행·열 격자로 펼쳐** 읽는다(예전 검증기의 "숫자 흐름" — 표를 글자 흐름으로 보고 간격 s 로 숫자를 더하던 방식 — 은 버림):
 *  1. 표 HTML 을 COLSPAN·ROWSPAN 을 반영한 격자로 펼친다. 칸마다 글자·숫자·(있으면) XBRL 태그(ACODE·ACONTEXT, 2025 사업보고서·2026 분기부터 원문 칸에 달림).
 *  2. 계열 줄 값 X(원)와 같은 칸(표 단위 반올림 안 — |칸 × 단위 − X| ≤ 단위/2)을 찾고, 그 칸을 합계로 하는 내역 묶음을 **표 구조로** 정한다:
 *     · 세로(위) — 그 칸의 줄 이름이 합계(합계·계·소계)거나 금융자산 계열 이름이면, 같은 열의 바로 위 줄들(합계 줄·글자만 있는 줄·머리 줄에서 멈춤)
 *     · 세로(아래) — 그 칸의 줄 이름이 금융자산 계열 이름이면, 같은 열의 바로 아래 줄들
 *     · 가로(왼쪽) — 그 칸의 열 머리가 합계(합계·계)이고 줄 이름이 금융자산 계열이면, 같은 줄의 왼쪽 칸들(이름 = 열 머리, 범주별 금융상품 표)
 *     · 칸 이름 자체 — 그 칸의 줄 이름이 성격 낱말(단기금융상품·정기예금 등)이고 표나 표 앞 제목이 계열 줄 이름을 말하면 줄 전체가 그 성격
 *     가까운 줄부터 더해 **표 단위로 정확히** 합계와 같아지는 첫 묶음만 쓴다.
 *  3. 묶음의 각 내역을 이름(아래 낱말 — ① 문장에서 새로 적음)으로 포함·제외·범주로 나눈다. 칸에 XBRL 태그가 있으면 태그(개념·멤버의 영문 이름)로도 따로 나누어
 *     둘이 어긋나면 그 묶음은 버린다(검증불가 쪽으로).
 *  4. "범주" 내역(상각후원가측정·공정가치측정 금융자산 — 무엇이 들었는지 이름이 말하지 않음)은 같은 보고서의 다른 표 중 **제목·머리에 그 범주 이름이 있는 표**에서
 *     같은 금액(칸 하나 또는 2.와 같은 구조의 묶음)의 성격을 찾는다. 못 찾으면 그 묶음은 버린다.
 *  5. 모든 내역이 포함이면 X, 모두 제외면 0, 섞이면 포함 내역 합(원). 성격을 못 정한 내역이 하나라도 있으면 그 묶음은 버린다.
 *  6. 여러 표·보고서의 묶음이 다른 값을 내면: 가장 작은 단위 묶음끼리 같으면 그 값(반올림 차), 아니면 모순 → 정하지 못함(검증불가).
 *  못 찾으면 null — 내역이 정말 공시되지 않았는지(① "미공시 → 제외") 검증기는 확인할 수 없으므로 검증불가로 남긴다(통과로 세지 않음).
 */
import { dartDocFinTables } from "./dart.mjs";

const UNIT = { 원: 1, 천원: 1e3, 백만원: 1e6, 억원: 1e8 };
const strip = (t) => String(t).replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&cr;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const unitsIn = (t) => [...strip(t).matchAll(/단위\s*[:：]\s*(천원|백만원|억원|원)/g)].map((m) => m[1]);
// 이름 정리 — 공백·각주 표시((*1)·(주2)·*)·앞 기호(―·-·ㆍ) 제거
const clean = (s) => String(s ?? "").replace(/\((?:\*|주)\s*\d*(?:,\s*\d+)*\)|\*\d*|\(\s*\d\s*\)/g, "").replace(/\s/g, "").replace(/^[―\-·ㆍ•▶]+/, "");

/** 칸 글자 → 숫자(표 단위 정수) | 0("-") | null(빈칸) | NaN(글자) */
function cellNum(t) {
  const x = t.replace(/\s/g, "");
  if (x === "") return null;
  if (/^[-－—–]$/.test(x)) return 0;
  if (/^\(?-?\d{1,3}(?:,\d{3})+\)?$|^\(?-?\d+\)?$/.test(x)) return Number(x.replace(/[(),-]/g, "")) * (/^[(-]/.test(x) ? -1 : 1);
  return NaN;
}

/** 표 HTML → { u, pre, rows: [[{ t, n, code, ctx }]] } (COLSPAN·ROWSPAN 펼침 — ROWSPAN 은 글자 칸만 아래로 잇는다, 숫자는 한 번만) */
export function parseFinTable({ pre, html }) {
  const u = UNIT[unitsIn(html.slice(0, 2000))[0] ?? unitsIn(pre).at(-1)];
  const grid = [];
  const carry = []; // 열 → { left, cell }
  const trs = html.match(/<TR[\s\S]*?<\/TR>/gi) ?? [];
  for (const tr of trs) {
    const row = [];
    let col = 0;
    const take = () => { while (carry[col]?.left > 0) { row[col] = { ...carry[col].cell, carried: true }; carry[col].left--; col++; } };
    for (const c of tr.matchAll(/<(T[DHEU])\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      take();
      const attr = c[2];
      const cs = Number(/COLSPAN="?(\d+)/i.exec(attr)?.[1] ?? 1), rs = Number(/ROWSPAN="?(\d+)/i.exec(attr)?.[1] ?? 1);
      const t = strip(c[3]);
      const n = cellNum(t);
      const cell = { t, n, code: /ACODE="([^"]*)"/.exec(attr)?.[1] ?? null, ctx: /ACONTEXT="([^"]*)"/.exec(attr)?.[1] ?? null };
      for (let k = 0; k < cs; k++) {
        // 가로로 펼친 칸 중 첫 칸만 숫자를 갖는다(합계가 두 번 세지지 않게), 글자는 머리 맞춤용으로 반복
        row[col] = k === 0 ? cell : { ...cell, n: Number.isNaN(n) ? NaN : null, span: true };
        if (rs > 1) carry[col] = { left: rs - 1, cell: Number.isNaN(n) ? cell : { t: "", n: null } };
        col++;
      }
    }
    take();
    grid.push(row.map((x) => x ?? { t: "", n: null }));
  }
  return { u, pre: strip(pre).slice(-400), rows: grid };
}

// ── 성격 낱말(① 문장에서 새로 적음) ──
// 흐름표(변동·증감) 글자 — 잔액 내역이 아니다
const FLOW = /증가|감소|취득|처분|회수|상환|발행|기초|대체|평가손익|상각액/;
// 제외(① "대여금·보증금·미수금·파생상품·확정계약자산 제외") + ① 의 포함 목록에 없는 것으로 이름이 분명한 것(받을 돈·지분·리스채권)
const OUT = /대여금|대여채권|보증금|미수|파생|확정계약|매출채권|공사미수|리스채권|금융리스|선급|지분|주식|출자금|회원권|기타포괄손익|대출채권|기타채권|수취채권|미청구/;
// 포함 — 예금성: 정기예금·단기금융상품·장단기금융상품·예치금·채무상품·사용제한·동반성장 / 투자성: 펀드·MMF·국공채·채권·특정금전신탁·저축성보험
const IN = /정기예금|정기적금|예금|예치금|예탁금|(?:단기|장기|장단기)금융상품|^금융상품(?:등)?$|측정금융상품$|채무상품|채무증권|사용제한|동반성장|펀드|수익증권|국공채|국채|공채|회사채|채권|특정금전신탁|금전신탁|신탁|저축성보험|(?<![A-Za-z])MMF(?![A-Za-z])/;
// 범주(이름이 성격을 말하지 않음) — 상각후원가측정·(당기손익-)공정가치측정 금융자산. ② 가 범주 이름으로 적은 항목이라 성격은 따로 찾는다(4.)
const CAT = /^(?:유동|단기|기타|비유동)*(?:상각후원가(?:로)?(?:측정)?(?:하는)?|(?:당기손익-?)?공정가치(?:로)?(?:측정)?(?:하는)?)(?:유동)?금융자산$/;
const TOTAL = /^(?:합계|계|소계|총계|합|총합계)$/;
const FAM = /금융자산|투자자산|금융상품/;

// 차감 항목(대손충당금·손상차손누계액·현재가치할인차금) — 바로 앞 내역의 성격을 따른다
const ADJ = /대손충당금|손상차손누계|현재가치할인차금|손실충당금/;
/** 이름 → "in" | "out" | "cat" | "adj" | null(못 정함) | "flow" */
export function kindOfLabel(label) {
  if (ADJ.test(clean(label))) return "adj";
  // 열 머리에 붙은 기간 말(당기말·전기말·당반기말·기말 — 여러 머리 줄을 이은 것)은 뗀다
  const x = clean(label).replace(/^(?:(?:당|전|전전)?(?:반기|분기|기)?말)+/, "");
  if (!x) return null;
  if (FLOW.test(x)) return "flow";
  if (OUT.test(x)) return "out";
  // "상각후원가측정금융상품"처럼 범주 말 뒤에 성격 낱말이 붙은 이름은 범주 말을 떼고 본다
  const rest = x.replace(/(?:상각후원가|당기손익-?공정가치|공정가치)(?:로)?(?:측정)?(?:하는)?/g, "");
  if (IN.test(rest)) return "in";
  if (CAT.test(x)) return "cat";
  return null;
}

// XBRL 태그(개념·멤버 영문 이름)로 따로 나눔 — 이름 판정과 다른 근거
const TAG_OUT = /Loan|Receivable|Guarantee|DepositsProvided|LeaseholdDeposit|Derivative|FirmCommitment|KeyMoney|LeaseDeposit|Accrued|Prepaid|Equity(Instrument|Investment)|FairValueThroughOtherComprehensiveIncome/i;
const TAG_IN = /Deposit|DebtInstrument|DebtSecurit|Bond|Fund|MoneyMarket|Trust|SavingsInsurance|ShortTermFinancialInstrument|FinancialInstrumentsShortTerm/i;
export function kindOfTag(code, ctx) {
  if (!code) return null;
  const s = `${code} ${String(ctx ?? "").replace(/ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_(Consolidated|Separate)Member|CarryingAmountAccumulated\w*?Axis_\w*?Member/g, "")}`;
  if (/^(ifrs-full|dart)_(Other)?(Current|Noncurrent)?FinancialAssets$/.test(code) && !/Member/.test(s.split(" ")[1])) return null; // 합계 개념
  if (TAG_OUT.test(s)) return "out";
  if (TAG_IN.test(s)) return "in";
  return null;
}

/** 한 칸의 성격 — 이름과 태그 둘 다 정해지면 같아야 한다(다르면 "conflict"). 이름은 가장 안쪽 이름(줄의 마지막 글자 칸·열의 마지막 머리)을 먼저,
 *  못 정하면 이은 이름 전체("유동 금융자산 | 단기대여금" — 묶음 머리가 앞에 붙음) */
function kindOf(label, cell, leaf) {
  const a = (leaf ? kindOfLabel(leaf) : null) ?? kindOfLabel(label), b = kindOfTag(cell?.code, cell?.ctx);
  if (a === "flow" || a === "adj") return a;
  if (a && b && a !== "cat" && a !== b) return "conflict";
  if (a === "cat" || a == null) return b ?? a;
  return a;
}

const rowLeaf = (row) => row.filter((c) => Number.isNaN(c.n) && c.t).map((c) => c.t).at(-1) ?? "";
function colLeaf(T, c) {
  const first = T.rows.findIndex((r) => r.some((x) => typeof x.n === "number" && !Number.isNaN(x.n) && x.n !== 0));
  for (let r = (first < 0 ? T.rows.length : first) - 1; r >= 0; r--) { const t = T.rows[r][c]?.t; if (t) return t; }
  return "";
}
const rowLabel = (row) => row.filter((c) => Number.isNaN(c.n) && c.t).map((c) => c.t).filter((t, i, a) => a.indexOf(t) === i).join(" ");
const isTextRow = (row) => row.every((c) => c.n == null || Number.isNaN(c.n));
function colHeader(T, c) {
  const first = T.rows.findIndex((r) => r.some((x) => typeof x.n === "number" && !Number.isNaN(x.n) && x.n !== 0));
  const hs = [];
  for (let r = 0; r < (first < 0 ? T.rows.length : first); r++) { const t = T.rows[r][c]?.t; if (t && !hs.includes(t)) hs.push(t); }
  return hs.join(" ");
}
const near = (n, u, X) => Math.abs(n * u - X) <= u / 2 + 1e-6;

/**
 * 표 하나에서 값 X(원)를 합계로 하는 내역 묶음들 — [{ how, parts: [{ label, n, cell }], u }]. needCtx = 칸 이름 자체 경우에 표·제목이 말해야 할 이름(정규식)
 */
function blocksFor(T, X, needCtx) {
  const out = [];
  if (!T.u) return out;
  const ctxText = `${T.pre} ${T.rows.slice(0, 3).map(rowLabel).join(" ")}`;
  for (let r = 0; r < T.rows.length; r++) {
    for (let c = 0; c < T.rows[r].length; c++) {
      const cell = T.rows[r][c];
      if (typeof cell.n !== "number" || Number.isNaN(cell.n) || cell.n <= 0 || !near(cell.n, T.u, X)) continue;
      const head = colHeader(T, c);
      if (FLOW.test(clean(head))) continue;
      const lab = rowLabel(T.rows[r]);
      const L = clean(lab);
      const valAt = (rr, cc) => { const x = T.rows[rr]?.[cc]; return x && typeof x.n === "number" && !Number.isNaN(x.n) ? x.n : x && x.n == null && !x.span ? 0 : null; };
      const vertical = (dir) => {
        let sum = 0;
        const parts = [];
        for (let rr = r + dir; rr >= 0 && rr < T.rows.length; rr += dir) {
          const row = T.rows[rr];
          const lb = rowLabel(row);
          // 위로 읽다 소계 줄을 만나면 — 그 소계 위 줄들(다음 합계·글자 줄까지)이 소계와 정확히 같고 성격이 하나면 소계를 한 내역으로(015760 "대여금·대손충당금·
          // 현재가치할인차금 → 소계" + "장단기금융상품" = 합계)
          if (dir < 0 && /^소계$/.test(clean(lb)) && valAt(rr, c) != null) {
            const sub = [];
            let r2 = rr - 1;
            for (; r2 >= 0; r2--) { const rw = T.rows[r2], l2 = rowLabel(rw); if (TOTAL.test(clean(l2)) || isTextRow(rw) || valAt(r2, c) == null) break; sub.unshift({ label: l2, leaf: rowLeaf(rw), n: valAt(r2, c), cell: rw[c] }); }
            const sv = valAt(rr, c);
            const ks = withAdj(sub.map((p) => (p.n === 0 ? "zero" : p.fixed ?? kindOf(p.label, p.cell, p.leaf))));
            const u = [...new Set(ks.filter((k) => k !== "zero"))];
            if (!sub.length || sub.reduce((a, p) => a + p.n, 0) !== sv || u.length !== 1 || (u[0] !== "in" && u[0] !== "out")) break;
            parts.push({ label: `소계(${sub.map((p) => clean(p.leaf || p.label)).join("+")})`, leaf: "", n: sv, cell: row[c], fixed: u[0] });
            sum += sv;
            if (sum === cell.n && parts.some((p) => p.n !== 0)) return parts;
            rr = r2 + 1; // 다음 반복에서 r2 로
            continue;
          }
          if (TOTAL.test(clean(lb)) || isTextRow(row)) break;
          const v = valAt(rr, c);
          if (v == null) break;
          parts.push({ label: lb, leaf: rowLeaf(row), n: v, cell: row[c] });
          sum += v;
          if (sum === cell.n && parts.some((p) => p.n !== 0)) return parts;
        }
        return null;
      };
      if (TOTAL.test(L) || (FAM.test(L) && !kindOfLabel(L))) {
        const p = vertical(-1);
        if (p) out.push({ how: `세로(위) '${lab}'`, parts: p, u: T.u, total: cell.n });
      }
      if (FAM.test(L) && !TOTAL.test(L) && !kindOfLabel(L)) {
        const p = vertical(1);
        if (p) out.push({ how: `세로(아래) '${lab}'`, parts: p, u: T.u, total: cell.n });
      }
      if (/(?:합계|^계)$/.test(clean(head))) {
        if (FAM.test(L)) {
          let sum = 0;
          const parts = [];
          for (let cc = c - 1; cc >= 0; cc--) {
            const x = T.rows[r][cc];
            if (Number.isNaN(x.n)) break; // 줄 이름 칸에 닿음
            if (x.span) continue;
            const v = x.n ?? 0;
            parts.push({ label: colHeader(T, cc), leaf: colLeaf(T, cc), n: v, cell: x });
            sum += v;
            if (sum === cell.n && parts.some((p) => p.n !== 0)) { out.push({ how: `가로(왼쪽) '${lab}'`, parts: [...parts], u: T.u, total: cell.n }); break; }
          }
        }
      }
      // 칸 이름 자체가 성격(단기금융상품·정기예금 등)이고 표·제목이 계열 줄을 말할 때
      const k = kindOfLabel(rowLeaf(T.rows[r])) ?? kindOfLabel(L);
      // 재무상태표 금융자산 줄들을 종류별로 늘어놓은 표(현금및현금성자산 줄이 있음)에서 계열 줄 자리에 성격 이름이 적힌 경우(103590 2026 반기 "단기금융상품(*)"
      // 1,032,439천원 — 본표 "기타 유동 금융자산") — 원 단위까지 같을 때만
      const listTable = cell.n * T.u === X && T.rows.some((rw) => /^현금및현금성자산/.test(clean(rowLeaf(rw))));
      if ((k === "in" || k === "out") && (needCtx.test(clean(ctxText)) || listTable || /기타.*금융.*자산|금융.*자산.*\(/.test(clean(rowLeaf(T.rows[r]))))) out.push({ how: `칸 이름 '${lab}'`, parts: [{ label: lab, leaf: rowLeaf(T.rows[r]), n: cell.n, cell }], u: T.u, total: cell.n });
      // 그 해 자기 보고서의 재무상태표 본표가 같은 금액 줄을 성격 이름으로 적은 경우(뒤 보고서가 그 줄을 "기타금융자산"으로 이름만 바꿈 — 042660 2021
      // "단기금융상품" 310,692,716,217원) — 원 단위까지 같을 때만
      // 계열 줄이 범주(상각후원가측정) 금융자산의 유동분 그 자체인 경우 — 범주 표(제목·머리에 범주 이름)에서 줄 또는 열이 "유동"(비유동 아님)이고 다른 쪽이
      // 성격을 말할 때(042660 2025 "정기예금 등" × "상각후원가로 측정하는 유동 금융자산", 2026 반기 "상각후원가측정 유동금융자산" × "정기예치금")
      else if (/상각후원가|당기손익-?공정가치/.test(clean(ctxText)) && (() => {
        const rl = clean(rowLeaf(T.rows[r])), cl = clean(colHeader(T, c));
        const cur = (t) => /유동/.test(t.replace(/비유동/g, "")) && !/비유동/.test(t);
        const kr = kindOfLabel(rowLeaf(T.rows[r])), kc = kindOfLabel(colLeaf(T, c));
        return (cur(cl) && (kr === "in" || kr === "out")) || (cur(rl) && (kc === "in" || kc === "out"));
      })()) {
        const kr = kindOfLabel(rowLeaf(T.rows[r]));
        const lb = kr === "in" || kr === "out" ? rowLeaf(T.rows[r]) : colLeaf(T, c);
        out.push({ how: `범주 표 유동분 '${rowLeaf(T.rows[r])}' × '${colLeaf(T, c)}'`, parts: [{ label: lb, leaf: lb, n: cell.n, cell }], u: T.u, total: cell.n });
      }
      else if ((k === "in" || k === "out") && cell.n * T.u === X && /재무상태표/.test(T.pre.slice(-200))) out.push({ how: `본표 줄 이름 '${lab}'`, parts: [{ label: lab, leaf: rowLeaf(T.rows[r]), n: cell.n, cell }], u: T.u, total: cell.n });
    }
  }
  // 합계 칸 없이 같은 열에 이어진 줄들의 합이 X 인 경우(공정가치·범주 표에 계열 줄이 내역 줄로만 풀려 있음 — 051600 2024) — 우연 일치를 막으려고
  // 표 단위가 천원 이하, 2줄 이상, 원 단위로 바꾼 합이 X 와 반올림 안
  if (T.u <= 1000 && /금융|재무상태표/.test(ctxText)) {
    const ncol = Math.max(...T.rows.map((r) => r.length));
    for (let c = 0; c < ncol; c++) {
      if (FLOW.test(clean(colHeader(T, c)))) continue;
      for (let r0 = 0; r0 < T.rows.length; r0++) {
        let sum = 0;
        const parts = [];
        for (let r = r0; r < T.rows.length; r++) {
          const row = T.rows[r], x = row[c];
          const lb = rowLabel(row);
          if (!x || TOTAL.test(clean(lb)) || !lb || Number.isNaN(x.n) || (x.n == null && x.span)) break;
          const xv = x.n ?? 0; // 빈칸 = 0(본표의 값 없는 줄)
          if (isTextRow(row) && x.n !== null) break;
          parts.push({ label: lb, leaf: rowLeaf(row), n: xv, cell: x });
          sum += xv;
          if (parts.filter((p) => p.n !== 0).length >= 2 && Math.abs(sum * T.u - X) <= T.u / 2 && parts[0].n !== 0 && xv !== 0) { out.push({ how: `같은 열 이어진 줄(합계 칸 없음${/재무상태표/.test(T.pre.slice(-200)) ? ", 본표" : ""})`, parts: [...parts], u: T.u, total: sum, face: /재무상태표/.test(T.pre.slice(-200)) }); break; }
          if (sum * T.u > X + T.u) break;
        }
      }
    }
  }
  return out;
}

/** 차감 항목은 표에서 바로 앞(위에서 아래로 읽은 순서) 내역의 성격 — 앞 내역이 정해지지 않았으면 못 정함 */
function withAdj(ks) {
  // parts 는 합계 칸에서 가까운 순(위로 거슬러 읽으면 역순)일 수 있다 — 표 안 줄 순서는 알 수 없으므로 양쪽 이웃이 같은 성격일 때만 정한다
  return ks.map((k, i) => {
    if (k !== "adj") return k;
    const nb = [ks[i - 1], ks[i + 1]].filter((x) => x && x !== "adj" && x !== "zero");
    const u = [...new Set(nb)];
    return u.length === 1 && (u[0] === "in" || u[0] === "out") ? u[0] : null;
  });
}

/** 범주 내역(원 금액 amt, 표 단위 u0)의 성격 — 같은 보고서에서 제목·머리에 그 범주 이름이 든 표의 같은 금액 묶음. { v(포함 원), how } | null */
function resolveCat(tables, label0, amt, u0, leaf) {
  // 범주 이름이면 그 범주 말, 계열 이름(유동기타금융자산 등)이면 그 이름이 제목·머리에 든 표에서 찾는다(가장 안쪽 이름 기준)
  const label = leaf || label0;
  const L0 = kindOfLabel(label) === "cat" ? null : clean(label).replace(/^(?:(?:당|전)?(?:반기|분기|기)?말)+/, "").replace(/^(유동|단기)+/, "");
  const key = L0 ? new RegExp(L0.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : /상각후원가/.test(clean(label)) ? /상각후원가/ : /공정가치/;
  const found = [];
  for (const T of tables) {
    if (!T.u || !key.test(clean(`${T.pre} ${T.rows.slice(0, 2).map(rowLabel).join(" ")}`))) continue;
    // 금액 맞춤 — 더 거친 단위 쪽 반올림 안
    const tol = Math.max(u0, T.u) / 2;
    for (let r = 0; r < T.rows.length; r++) for (let c = 0; c < T.rows[r].length; c++) {
      const x = T.rows[r][c];
      if (typeof x.n !== "number" || Number.isNaN(x.n) || x.n <= 0 || Math.abs(x.n * T.u - amt) > tol) continue;
      const lab = rowLabel(T.rows[r]);
      let k = kindOf(lab, x, rowLeaf(T.rows[r]));
      let via = "";
      // 열 머리가 성격을 말하는 표(머리 여러 줄: 범주 > 유가증권 > 채무증권 > 국공채 — 051600 2026 반기)
      if (k !== "in" && k !== "out") { const hk = kindOfLabel(colHeader(T, c)); if (hk === "in" || hk === "out") { k = hk; via = ` · 열 머리 '${colHeader(T, c).slice(-40)}'`; } }
      // 성격 내역 + 유동·비유동 나눔 표(국공채 884,420,000 = 유동 37,845,000 + 비유동 846,575,000 — 051600 2023 보고서): 이 칸 줄이 범주·계열 이름이면, 같은 열의
      // 성격 줄(모두 같은 성격)의 합 = 범주·계열 이름 줄들의 합일 때 그 성격
      if (k !== "in" && k !== "out") {
        const vals = T.rows.map((row) => ({ k: kindOf(rowLabel(row), row[c], rowLeaf(row)), n: typeof row[c]?.n === "number" && !Number.isNaN(row[c].n) ? row[c].n : 0, lb: rowLeaf(row) }));
        const nat = vals.filter((z) => (z.k === "in" || z.k === "out") && z.n !== 0), cats = vals.filter((z) => (z.k === "cat" || (z.k == null && FAM.test(clean(z.lb)))) && z.n !== 0);
        const ks = [...new Set(nat.map((z) => z.k))];
        if (ks.length === 1 && cats.length >= 2 && nat.reduce((a, z) => a + z.n, 0) === cats.reduce((a, z) => a + z.n, 0)) { k = ks[0]; via = ` · 같은 열 성격 줄 ${nat.map((z) => clean(z.lb)).join("+")} = 나눔 줄 합`; }
      }
      if (k === "in" || k === "out") found.push({ v: k === "in" ? x.n * T.u : 0, how: `'${lab}' ${x.n}(단위 ${T.u}, ${k === "in" ? "포함" : "제외"}${via})`, u: T.u });
    }
    for (const b of blocksFor(T, amt, /$^/)) {
      const ks = withAdj(b.parts.map((p) => (p.n === 0 ? "zero" : p.fixed ?? kindOf(p.label, p.cell, p.leaf))));
      if (ks.some((k) => k !== "zero" && k !== "in" && k !== "out")) continue;
      const inSum = b.parts.filter((p, i) => ks[i] === "in").reduce((a, p) => a + p.n, 0);
      found.push({ v: inSum * b.u, how: `${b.how} ${b.parts.map((p, i) => `${clean(p.label).slice(-14)} ${p.n}(${ks[i] === "in" ? "포함" : ks[i] === "zero" ? "0" : "제외"})`).join(", ")}`, u: b.u });
    }
  }
  const vs = [...new Set(found.map((f) => f.v))];
  if (vs.length === 1) return found[0];
  if (vs.length > 1) {
    const minU = Math.min(...found.map((f) => f.u));
    const fine = [...new Set(found.filter((f) => f.u === minU).map((f) => f.v))];
    if (fine.length === 1 && found.every((f) => Math.abs(f.v - fine[0]) <= Math.max(f.u, minU))) return found.find((f) => f.u === minU && f.v === fine[0]);
  }
  return null;
}

/**
 * 계열 줄(이름 line, 값 X 원)의 현금성 부분 — rcepts(보고서 접수번호, 앞쪽 우선) 원문 표에서. { v, how } | { v: null, how }
 * 시험용으로 표 목록을 바로 줄 수도 있다(tablesOf: rcept → [{pre, html}])
 */
export async function familyCashFromNotes(rcepts, X, line, tablesOf = dartDocFinTables) {
  const lineCore = clean(line).replace(/^(유동|기타)+/, "");
  const needCtx = new RegExp(clean(line).replace(/[()]/g, "") + "|기타(유동)?" + lineCore);
  const got = [];
  const rejected = [];
  for (const rc of rcepts) {
    const tables = (await tablesOf(rc)).map(parseFinTable);
    for (const T of tables) {
      for (const b of blocksFor(T, X, needCtx)) {
        const ks = withAdj(b.parts.map((p) => (p.n === 0 ? "zero" : p.fixed ?? kindOf(p.label, p.cell, p.leaf))));
        const desc = [];
        let inWon = 0, ok = true;
        b.parts.forEach((p, i) => {
          const k = ks[i];
          if (k === "zero") return;
          if (k === "in") { inWon += p.n * b.u; desc.push(`${clean(p.label).slice(-18)} ${p.n}(포함)`); return; }
          if (k === "out") { desc.push(`${clean(p.label).slice(-18)} ${p.n}(제외)`); return; }
          // 그 해 자기 보고서 재무상태표 본표의 범주 줄(유동 상각후원가·FVPL 금융자산)은 ② 가 이름으로 적은 현금성 항목
          if (k === "cat" && b.face) { inWon += p.n * b.u; desc.push(`${clean(p.label).slice(-18)} ${p.n}(본표 범주 줄 — ② 포함)`); return; }
          if (k === "cat" || (k == null && FAM.test(clean(p.label)))) {
            const r = resolveCat(tables, p.label, p.n * b.u, b.u, p.leaf);
            if (r) { inWon += r.v; desc.push(`${clean(p.label).slice(-18)} ${p.n}(범주 → ${r.how})`); return; }
          }
          ok = false;
          desc.push(`${clean(p.label).slice(-18)} ${p.n}(${k === "conflict" ? "이름·태그 성격 어긋남" : k === "cat" ? "범주 — 성격 표 못 찾음" : "성격 못 정함"})`);
        });
        const s = `원문 ${rc} ${b.how}: ${desc.join(", ")} = ${b.total}(단위 ${b.u})`;
        if (!ok) { rejected.push(s); continue; }
        const nz = ks.filter((k) => k !== "zero");
        const allIn = nz.every((k) => k === "in"), allOut = nz.every((k) => k === "out");
        got.push({ v: allIn ? X : allOut ? 0 : inWon, u: b.u, how: s, rc });
      }
    }
  }
  if (!got.length) return { v: null, how: `${X} — 검증기가 원문 표에서 내역 묶음을 찾지 못함${rejected.length ? ` (버린 묶음 ${rejected.length}: ${rejected.slice(0, 2).join(" / ")})` : ""}` };
  const vs = [...new Set(got.map((g) => g.v))];
  if (vs.length === 1) return { v: vs[0], how: got[0].how + (got.length > 1 ? ` (같은 값 묶음 ${got.length}개)` : "") };
  const minU = Math.min(...got.map((g) => g.u));
  const fine = got.filter((g) => g.u === minU);
  const fv = [...new Set(fine.map((g) => g.v))];
  if (fv.length === 1 && got.every((g) => Math.abs(g.v - fv[0]) <= g.u * 12)) return { v: fv[0], how: `${fine[0].how} (다른 묶음과 표 단위 반올림 차만 — 가장 작은 단위 값)` };
  return { v: null, how: `검증기 묶음끼리 값이 다름 — ${got.map((g) => `${g.v}[${g.how.slice(0, 80)}]`).join(" / ")}` };
}
