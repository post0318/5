/**
 * 한국 종목 감가상각비·무형자산상각비(연결)를 DART 사업보고서 XBRL 에서 파싱해
 * MongoDB(kr_da)에 연도별로 적재. 하나의 사업보고서 XBRL 은 당기+전기 2개년을 담으므로
 * 2년 간격으로 3건 조회해 ~6개년을 모은다.
 *
 * OpenDART XBRL 엔드포인트는 클라우드 IP(Vercel)를 차단하므로 로컬/개인 IP 에서 실행.
 * 분기·반기·사업보고서가 나올 때마다 재실행 권장 (야간배치 nightly.mjs 에 포함됨).
 *   node scripts/populate-kr-da.mjs [005930 000660 ...]
 * 인자 없으면 universe_items 의 한국 종목 전체.
 */
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { MongoClient } from "mongodb";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);
const DART = env.DART_API_KEY;
const URI = env.MONGODB_URI;
const DB = env.MONGODB_DB || "market_research";
if (!DART || !URI) throw new Error("DART_API_KEY / MONGODB_URI 필요 (.env.local)");

const B = "https://opendart.fss.or.kr/api";
const CHECK = process.argv.includes("--check");
// 적재 컬렉션 — 로컬 .env.local 은 KR_DA_COLLECTION=kr_da_staging(로컬·운영이 같은 DB, 브랜치 작업이 운영에 섞이지 않게). 운영 반영은 --prod
// (master 배포 확인 뒤 — 오너 지시 2026-10-02 "마스터는 다 확인하고 배포다")
const COLL = process.argv.includes("--prod") ? "kr_da" : process.env.KR_DA_COLLECTION || env.KR_DA_COLLECTION || "kr_da";
const corpMap = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
);
const corpOf = (code) => {
  const d = code.replace(/\D/g, "").padStart(6, "0");
  const row = corpMap.find((r) => (r.s ?? r.stock_code) === d);
  return row ? (row.c ?? row.corp_code) : null;
};
const jget = (url) => fetch(url).then((r) => r.json());

/**
 * 특정 사업연도 사업보고서 접수번호들(최신 = 정정본 먼저). 보고서명의 대상 연도("(2023.12)")가 맞는 것만 — 이듬해 접수 목록에 지난 연도
 * 정정본도 섞인다(현대차 2024-03-14 "[기재정정]사업보고서 (2022.12)"를 2023 보고서로 잡았다, 2026-10-02). 정정본은 정정한 부분만 담아
 * 감사보고서가 없을 수 있어(SK 2021 기재정정) 순서대로 시도한다
 */
async function annualRcps(corp, year) {
  await new Promise((r) => setTimeout(r, 400));
  const j = await jget(
    `${B}/list.json?crtfc_key=${DART}&corp_code=${corp}` +
      `&bgn_de=${year + 1}0101&end_de=${year + 1}1231&pblntf_detail_ty=A001&page_count=100`,
  );
  const rows = (j.list ?? []).filter((r) => /사업보고서/.test(r.report_nm) && r.report_nm.includes(`(${year}.`));
  rows.sort((a, b) => b.rcept_no.localeCompare(a.rcept_no));
  return rows.map((r) => r.rcept_no);
}

async function loadXbrl(rcpNo) {
  // DART 는 몰아서 요청하면 이 PC 연결을 약 1시간 막는다(실측 2026-10-01) — XBRL 요청마다 1초 간격
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`${B}/fnlttXbrl.xml?crtfc_key=${DART}&rcept_no=${rcpNo}&reprt_code=11011`);
  if (!res.ok) throw new Error(`xbrl ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const name = Object.keys(files).find((n) => n.endsWith(".xbrl"));
  if (!name) throw new Error("xbrl not in zip");
  return strFromU8(files[name]);
}

const DEP_C = ["AdjustmentsForDepreciationExpense", "AdjustmentsForDepreciationAndAmortisationExpense"];
// 현금흐름 조정에서 따로 적은 사용권자산·투자부동산 감가상각 — 감가상각비에 더한다(2026-10-02). 한국 EV 는 리스부채를 차입금에 넣으므로
// (IFRS 16 — 리스료가 영업이익 아래로) EBITDA 감가상각에도 사용권자산 상각이 들어가야 정의가 맞다. HD현대일렉트릭 2023: 유형 33,109 +
// 사용권 11,271 + 투자부동산 31, 첫 줄만 읽어 1/4 이 빠졌다(한화에어로스페이스 사용권자산상각비 36,476 도)
// [dart 표준 태그, 없을 때 회사 고유 태그] — 현대로템은 사용권자산 상각을 회사 고유 태그로 단다
// (entity00302926:AdjustmentForAmortisationOfRightOfUseAssets… 8,170 — 원문 31,306 + 8,170 + 129 = 39,605 와 일치)
const DEP_EXTRA = [
  ["AdjustmentsForDepreciationRightofuseAssets", /^Adjustments?For(?:Depreciation|Amorti[sz]ation)\w*?Right[Oo]f[Uu]seAssets/],
  ["AdjustmentsForDepreciationInvestmentProperty", /^Adjustments?ForDepreciation\w*?InvestmentPropert/],
];
/** 회사 고유(entity…) 태그 중 이름이 맞는 첫 값 */
function pickEntity(xml, nameRe, prefix) {
  for (const m of xml.matchAll(/<entity\d+:(\w+)\b[^>]*contextRef="([^"]+)"[^>]*>(-?\d+(?:\.\d+)?)</g))
    if (nameRe.test(m[1]) && ctxOk(m[2], prefix)) return Number(m[3]);
  return null;
}
const AMO_C = ["AdjustmentsForAmortisationExpense"];

// 별도 재무제표 회사(그 해 연결 재무제표가 없음 — 제룡전기, LS마린솔루션 2022 이전 KT서브마린)는 별도 값. 앱도 연도별로 연결이 없으면 별도를
// 쓴다(opendart.ts CFS → OFS)
let SEP = false;
function ctxOk(ctx, prefix) {
  if (!ctx.startsWith(prefix + "_") && ctx !== prefix) return false;
  if (SEP) {
    if (/_ConsolidatedMember/.test(ctx)) return false;
    if (/SegmentConsolidationItemsAxis|OperatingSegments|ClassesOfAssets|ClassesOfPropertyPlantAndEquipment|ClassesOfIntangibleAssets/.test(ctx)) return false;
    return ctx === prefix || /SeparateMember$/.test(ctx) || /ReportedAmountMember$/.test(ctx);
  }
  if (!ctx.includes("_ConsolidatedMember")) return false;
  if (/SegmentConsolidationItemsAxis|OperatingSegments|ClassesOfAssets|ClassesOfPropertyPlantAndEquipment|ClassesOfIntangibleAssets/.test(ctx))
    return false;
  return /ConsolidatedMember$/.test(ctx) || /ReportedAmountMember$/.test(ctx);
}
function pick(xml, concepts, prefix) {
  for (const c of concepts) {
    const re = new RegExp(`<(?:ifrs-full|dart):${c}\\b[^>]*contextRef="([^"]+)"[^>]*>(-?\\d+(?:\\.\\d+)?)</`, "g");
    let m;
    while ((m = re.exec(xml))) if (ctxOk(m[1], prefix)) return Number(m[2]);
  }
  return null;
}

// ── 사업보고서 원문(연결감사보고서) 현금흐름 조정 주석 — XBRL 에 주석 태깅이 없는 해(2021 이전 보고서 등). "주석에 없을리가 없다"(오너, 2026-10-02):
//    연결현금흐름표의 "비현금항목 조정"·"영업으로부터 창출된 현금흐름" 주석 표의 감가상각비·무형자산상각비 줄. XBRL 이 있는 해(삼성전자 2022~2024,
//    LG화학 2023, SK 2023)와 값이 같음을 확인
const clean = (t) => t.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&cr;|&amp;/g, " ").replace(/\s+/g, " ").trim();
const UNIT = { 원: 1, 천원: 1e3, 백만원: 1e6, 억원: 1e8 };
const UNIT_RE = /단위\s*:\s*(원|천원|백만원|억원)/;
const numOf = (t) => {
  const u = t.replace(/\s/g, "");
  if (!/^\(?-?[\d,]+\)?$/.test(u)) return null;
  const neg = u.startsWith("(") || u.startsWith("-");
  const v = Number(u.replace(/[(),-]/g, ""));
  return Number.isFinite(v) ? (neg ? -v : v) : null;
};
/**
 * 문서에서 현금흐름 조정 표(감가상각비 줄)를 찾아 [당기, 전기]. mode "nature" 는 성격별 비용 주석 표(계속영업만 — 중단영업이 있는 해에
 * 쓴다: 한화에어로스페이스 2024 현금흐름 조정은 인적분할 사업 상각까지 포함, 회사 주석 "전기 중 인적분할한 … 감가상각비가 포함")
 */
function parseDocDa(xml, mode = "cf") {
  for (const m of xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
    const html = m[0];
    const rows = [...html.matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1])));
    // 줄 이름 앞 기호("- 감가상각비" — LG화학) 떼고 공백·괄호 제거
    const label = (r) => (r[0] ?? "").replace(/^[\s\-–·ㆍ•]+/, "").replace(/\s|\(.*?\)/g, "");
    // 감가상각비(또는 유형자산상각비) + 따로 적은 사용권자산·투자부동산 상각 줄의 합(SK하이닉스 2021 "유형자산상각비·투자부동산상각비",
    // HD현대일렉트릭 "유형자산감가상각비·투자부동산감가상각비·사용권자산감가상각비" — 무형자산상각비는 따로). 같은 이름 줄이 둘이면 첫 줄만
    // 괄호로 자산을 밝힌 줄도(효성중공업 "감가상각비(유형자산)·감가상각비(투자부동산)·감가상각비(사용권자산)" — 괄호를 지우면 셋 다 같은 이름)
    const raw = (r) => (r[0] ?? "").replace(/^[\s\-–·ㆍ•]+/, "").replace(/\s/g, "");
    const kindOf = (r) => {
      const t = raw(r);
      if (/^(유형자산(감가)?상각비|감가상각비\(유형자산\))$/.test(t)) return "base";
      if (/^(투자부동산(감가)?상각비|감가상각비\(투자부동산\))$/.test(t)) return "inv";
      if (/^(사용권자산(감가)?상각비|감가상각비\(사용권자산\))$/.test(t)) return "rou";
      return label(r) === "감가상각비" && !/\((투자부동산|사용권자산)\)/.test(t) ? "base" : null;
    };
    const byKind = new Map();
    for (const r of rows) { const k = kindOf(r); if (k && !byKind.has(k)) byKind.set(k, r); }
    // 성격별 비용 표의 감가·무형 합친 줄(삼성전기 "감가상각비(*) 및 무형자산상각비") — 나눌 수 없어 합계만
    const combined = mode === "nature" ? rows.find((r) => /^감가상각비(및|와)무형자산상각비$/.test(label(r))) : null;
    if (!byKind.has("base") && !combined) continue;
    const depRows = [...byKind.values()];
    const names = rows.map(label).join("|");
    const before = clean(xml.slice(Math.max(0, m.index - 1500), m.index));
    const head = before.slice(-300);
    // 현금흐름 조정 표 — 표 앞 제목이나 조정 항목 줄로 판별. 비용 분류·판관비 표는 제외
    const isCf = (/현금흐름/.test(head) && /창출|조정|영업활동/.test(head)) || /조정항목|배당금수익|이자수익|법인세비용|유형자산처분/.test(names);
    // 비용 항목 줄(복리후생비 등)이 있으면 성격별 비용 표로 보고 거르되, 현금흐름 조정 표라는 근거가 뚜렷하면 그대로(한화오션 조정 표에
    // "복리후생비" 줄이 있다 — 2026-10-02)
    const strongCf = (/현금흐름/.test(head) && /창출|조정/.test(head)) || (/조정항목|법인세비용/.test(names) && /처분/.test(names));
    if (mode === "nature") {
      if (!/성격별/.test(head) || isCf) continue;
    } else if (!isCf || (!strongCf && /복리후생비|광고선전비|외주용역비|운반보관비/.test(names))) continue;
    const amo = rows.find((r) => /^무형자산상각비$/.test(label(r)));
    // 단위 — 표 안 첫 줄("(단위: 백만원)")이 우선, 없으면 표 바로 앞 문장
    const u = clean(html).match(UNIT_RE)?.[1] ?? [...before.matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
    if (!u) continue;
    // 숫자 칸만(주석 번호 칸 등 제외) — "-" 는 0
    const nums = (r) => r.slice(1).map((c) => (/^[-–]$/.test(c.trim()) ? 0 : numOf(c))).filter((v) => v != null);
    if (!byKind.has("base")) return { unit: UNIT[u], dep: [], amo: [], combined: nums(combined).map((v) => v * UNIT[u]) };
    const cols = Math.min(...depRows.map((r) => nums(r).length));
    const dep = Array.from({ length: cols }, (_, i) => depRows.reduce((a, r) => a + nums(r)[i], 0));
    const part = (k) => (byKind.has(k) ? nums(byKind.get(k)).map((v) => v * UNIT[u]) : null);
    return {
      unit: UNIT[u],
      dep: dep.map((v) => v * UNIT[u]),
      amo: amo ? nums(amo).map((v) => v * UNIT[u]) : [],
      parts: { base: part("base"), inv: part("inv"), rou: part("rou") },
    };
  }
  return null;
}
/**
 * 성격별 비용 주석(계속영업) — [당기, 전기]. 두 형식: ① "구분 | 당기 | 전기" 한 표, ② "구분 | 재고변동 | 판관비 | 원가명세서 | 성격별 비용"
 * 처럼 열이 여럿이고 당기·전기 표가 따로(LS ELECTRIC) — 마지막 합계 열을 읽고 앞 표가 당기, 다음 표가 전기. 감가·무형을 한 줄로 합친
 * 표(삼성전기·LS·두산에너빌리티)는 combined 만
 */
function parseNatureDa(xml) {
  const lbl = (r) => (r[0] ?? "").replace(/^[\s\-–·ㆍ•]+/, "").replace(/\s|\(.*?\)/g, "");
  const kind = (r) => {
    const t = (r[0] ?? "").replace(/^[\s\-–·ㆍ•]+/, "").replace(/\s/g, "");
    if (/^(감가상각비(및|와)무형자산상각비|감가상각비\(\*\)(및|와)무형자산상각비)$/.test(t) || /^감가상각비(및|와)무형자산상각비$/.test(lbl(r))) return "comb";
    if (/^(유형자산(감가)?상각비|감가상각비\(유형자산\))$/.test(t) || lbl(r) === "감가상각비") return "base";
    if (/^(투자부동산(감가)?상각비|감가상각비\(투자부동산\))$/.test(t)) return "inv";
    if (/^(사용권자산(감가)?상각비|감가상각비\(사용권자산\))$/.test(t)) return "rou";
    if (lbl(r) === "무형자산상각비") return "amo";
    return null;
  };
  const wide = [];
  for (const m of xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
    const html = m[0];
    const rows = [...html.matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1])));
    const before = clean(xml.slice(Math.max(0, m.index - 1500), m.index));
    const head = before.slice(-300);
    const is = isByNature(rows, before);
    if (is) return is;
    if (!/성격별/.test(head + " " + (rows[0] ?? []).join(" "))) continue;
    const names = rows.map(lbl).join("|");
    if (/조정항목|법인세비용|이자수익/.test(names)) continue; // 현금흐름 조정 표
    const by = {};
    for (const r of rows) { const k = kind(r); if (k && !by[k]) by[k] = r; }
    if (!by.comb && !by.base) continue;
    const u = clean(html).match(UNIT_RE)?.[1] ?? [...before.matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
    if (!u) continue;
    const nums = (r) => r.slice(1).map((c) => (/^[-–]$/.test(c.trim()) ? 0 : numOf(c))).filter((v) => v != null);
    const key = by.comb ?? by.base;
    const isWide = nums(key).length > 2;
    const take = (r) => (r ? (isWide ? [nums(r).at(-1)] : nums(r).slice(0, 2)).map((v) => v * UNIT[u]) : null);
    const one = {
      wide: isWide,
      unit: UNIT[u],
      combined: take(by.comb),
      base: take(by.base),
      inv: take(by.inv),
      rou: take(by.rou),
      amo: take(by.amo),
    };
    if (!isWide) return one;
    wide.push(one);
    if (wide.length === 2) break;
  }
  if (!wide.length) return null;
  // 여러 열 형식: 당기 표 + 전기 표를 [당기, 전기] 로
  const [c, p] = wide;
  const cat = (k) => (c[k] || p?.[k] ? [c[k]?.[0] ?? null, p?.[k]?.[0] ?? null] : null);
  return { wide: true, unit: c.unit, combined: cat("combined"), base: cat("base"), inv: cat("inv"), rou: cat("rou"), amo: cat("amo") };
}
/**
 * 손익계산서 본표가 성격별인 회사(SK스퀘어 — "Ⅱ.영업비용" 아래 종업원급여·지급수수료·감가상각비…). 본표 영업비용 항목의 감가상각비·
 * 무형자산상각비. 항목 합 = 영업비용 합계(열마다, 단위 이하)일 때만 — 열을 바르게 읽었다는 확인. 주석 번호 열은 뺀다.
 */
function isByNature(rows, before) {
  const strip = (c) => (c ?? "").replace(/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩXIVL]+\.\s*/, "").replace(/\s/g, "");
  const iOp = rows.findIndex((r) => strip(r[0]) === "영업비용");
  // "영업이익(손실)" 처럼 괄호가 붙어도(SK스퀘어 2023·2024 보고서)
  if (iOp < 0 || !rows.some((r) => strip(r[0]).replace(/\(.*?\)/g, "") === "영업이익")) return null;
  const hdr = rows.find((r) => r.some((c) => /^주\s*석$/.test(c)));
  const noteCol = hdr ? hdr.findIndex((c) => /^주\s*석$/.test(c)) : -1;
  const vals = (r) => r.map((c, i) => (i === 0 || i === noteCol ? null : /^[-–]$/.test(c.trim()) ? 0 : numOf(c))).filter((v) => v != null);
  const items = [];
  for (let i = iOp + 1; i < rows.length; i += 1) {
    if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/.test((rows[i][0] ?? "").trim())) break;
    items.push(rows[i]);
  }
  const dep = items.find((r) => strip(r[0]) === "감가상각비" || strip(r[0]) === "감가상각비및무형자산상각비");
  if (!dep) return null;
  const total = vals(rows[iOp]);
  for (let c = 0; c < Math.min(2, total.length); c += 1) {
    const sum = items.reduce((a, r) => a + (vals(r)[c] ?? 0), 0);
    if (Math.abs(sum - total[c]) > 1) return null;
  }
  const u = [...before.matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
  if (!u) return null;
  const amo = items.find((r) => strip(r[0]) === "무형자산상각비");
  const scale = (r) => vals(r).slice(0, 2).map((v) => v * UNIT[u]);
  return { isIS: true, wide: false, unit: UNIT[u], combined: null, base: scale(dep), inv: null, rou: null, amo: amo ? scale(amo) : [0, 0] };
}
/** 성격별 결과 → 감가(기본+투자부동산+사용권)·무형 열 값 */
function natureCols(n) {
  if (!n?.base) return { dep: [], amo: n?.amo ?? [] };
  const dep = n.base.map((v, i) => (v == null ? null : v + (n.inv?.[i] ?? 0) + (n.rou?.[i] ?? 0)));
  return { dep, amo: n.amo ?? [] };
}
/**
 * 투자부동산 변동표의 감가상각비(현금흐름 조정 표에 줄이 없는 회사 — LS: 성격별 합계 518,954 = 현금흐름 감가 401,424 + 사용권 48,826 +
 * 무형 64,955 + 투자부동산 3,749). 표 앞 문장에 "투자부동산"이 있고 "감가상각비" 줄이 있는 표, 마지막 열(합계)의 절대값 — 앞 표 당기, 다음 표 전기
 */
function parseInvPropDep(xml) {
  const out = [];
  let ti = 0;
  let firstAt = -1;
  for (const m of xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
    ti += 1;
    const head = clean(xml.slice(Math.max(0, m.index - 600), m.index)).slice(-250);
    // 전기 표는 당기 표 바로 뒤(표 3개 안)에 "(전기)"로 붙어 제목에 "투자부동산"이 없을 수 있다
    const isPrior = firstAt > 0 && ti - firstAt <= 3;
    if (!isPrior && (!/투자부동산/.test(head) || /유형자산|사용권자산|무형자산/.test(head.slice(-80)))) continue;
    const rows = [...m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1])));
    const r = rows.find((x) => (x[0] ?? "").replace(/\s/g, "") === "감가상각비");
    if (!r) continue;
    const u = clean(m[0]).match(UNIT_RE)?.[1] ?? [...clean(xml.slice(Math.max(0, m.index - 1500), m.index)).matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
    const v = numOf(r.at(-1) ?? "");
    if (!u || v == null) continue;
    out.push(Math.abs(v) * UNIT[u]);
    if (firstAt < 0) firstAt = ti;
    if (out.length === 2) break;
  }
  return out;
}
/** 원문 [col] 열이 XBRL 값과 같은가 — 원문 표시 단위(백만원·천원) 반올림 이내. 무형자산상각비는 둘 다 있을 때만 비교 */
function docAgrees(d, col, x) {
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < d.unit;
  if (!near(d.dep[col], x.depreciation)) return false;
  return d.amo[col] == null || x.amortisation == null || near(d.amo[col], x.amortisation);
}
/** 사업보고서 원문 — 연결감사보고서 파일의 첫 현금흐름 조정 표 */
async function docDa(rcpNo) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
  if (!res.ok) throw new Error(`document ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const docs = Object.values(files).map((b) => {
    // 인코딩 — 선언은 늘 utf-8 이지만 2021 이전 문서는 실제 EUC-KR(실측). UTF-8 로 읽어 깨진 글자가 많으면 EUC-KR
    let x = new TextDecoder("utf-8").decode(b);
    if ((x.match(/�/g) ?? []).length > 50) x = new TextDecoder("euc-kr").decode(b);
    const h = clean(x.slice(0, 3000));
    return { x, kind: /연결감사보고서/.test(h) ? "con" : /감사보고서/.test(h) ? "sep" : null };
  });
  // 연결감사보고서가 있으면 그것만, 없으면(별도 재무제표 회사) 감사보고서
  const want = docs.some((d) => d.kind === "con") ? "con" : "sep";
  for (const d of docs.filter((d) => d.kind === want)) {
    const t = parseDocDa(d.x);
    if (t) return { ...t, sep: want === "sep", nature: parseNatureDa(d.x), invDep: parseInvPropDep(d.x) };
  }
  // 현금흐름 조정 표를 못 읽어도 성격별 표·성격별 손익계산서는 쓴다(SK스퀘어 2024 보고서)
  for (const d of docs.filter((d) => d.kind === want)) {
    const nature = parseNatureDa(d.x);
    if (nature) return { unit: nature.unit, dep: [], amo: [], parts: {}, sep: want === "sep", nature, invDep: parseInvPropDep(d.x) };
  }
  return null;
}

/** 한 보고서에서 당기·전기 2개년. */
function fromReport(xml, year) {
  const out = {};
  for (const [y, prefix] of [
    [year, `CFY${year}dFY`],
    [year - 1, `PFY${year - 1}dFY`],
  ]) {
    const d0 = pick(xml, DEP_C, prefix);
    const [rou, inv] = DEP_EXTRA.map(([c, ent]) => pick(xml, [c], prefix) ?? pickEntity(xml, ent, prefix));
    // 기본 감가상각 줄이 없으면 부분합(사용권자산만)이 되므로 비운다 — 원문 주석으로 채움(한화에어로스페이스 2024·2025)
    const d = d0 == null ? null : d0 + (rou ?? 0) + (inv ?? 0);
    const a = pick(xml, AMO_C, prefix);
    // 중단영업손익(연결) — 0 이 아니면 그 해 현금흐름 조정 상각에 중단영업분이 섞여 있다
    const disc = pick(xml, ["ProfitLossFromDiscontinuedOperations"], prefix);
    if (d != null || a != null) out[y] = { depreciation: d, amortisation: a, xp: { base: d0, rou, inv, disc } };
  }
  return out;
}

async function daByYear(corp) {
  const now = new Date();
  // 최신 확정 사업연도 탐색
  let latest = 0;
  const rcps = {};
  for (const y of [now.getFullYear() - 1, now.getFullYear() - 2]) {
    rcps[y] = await annualRcps(corp, y);
    if (rcps[y].length) { latest = y; break; }
  }
  if (!latest) return null;
  const byYear = {};
  // XBRL 값을 낸 보고서 [보고서 연도, 열(0 당기·1 전기)] — 원문 대조는 같은 보고서·열로(한화에어로스페이스 2022 XBRL 은 2023 보고서 전기
  // 열 = 재작성본 141,845 · 2022 원 보고서 원문은 139,257 — 기준이 다른 비교로 검증 실패가 났다)
  const srcOf = {};
  // XBRL 감가상각 구성(기본·사용권자산·투자부동산) — 원문에서 빠진 줄을 보완할 때
  const xbrlParts = {};
  const xbrlAll = {};
  // 보고서 연도별 원문(정정본에 감사보고서가 없으면 원본) — 한 번만 받는다
  const docCache = {};
  const docOf = async (ry) => {
    if (ry in docCache) return docCache[ry];
    docCache[ry] = null;
    for (const rcp of [...(rcps[ry] ?? [])].reverse()) {
      try {
        const t = await docDa(rcp);
        if (t) { docCache[ry] = t; break; }
      } catch (e) {
        console.log(`    (${ry} ${rcp} 원문 실패: ${e.message})`);
      }
    }
    return docCache[ry];
  };
  // 매년 보고서(최신부터 — 겹치는 해는 최신 보고서 값). 2년 간격이면 2022 보고서를 건너뛰어 2021 값(2022 보고서 전기)이 빠졌다 —
  // 2021 보고서 XBRL 은 주석 태깅 자체가 없다(삼성전자 실측 2026-10-02)
  for (let y = latest; y >= latest - 5; y -= 1) {
    rcps[y] ??= await annualRcps(corp, y);
    // 정정본 XBRL 에 그 해 값이 없으면 다음(원본) 접수본
    for (const rcp of rcps[y]) {
      try {
        const xml = await loadXbrl(rcp);
        let part = fromReport(xml, y);
        let src = "xbrl";
        // 연결 재무제표가 없는 보고서(연결 컨텍스트 자체가 없음)는 별도 값
        if (!(y in part) && !/contextRef="[^"]*_ConsolidatedMember/.test(xml)) {
          SEP = true;
          part = fromReport(xml, y);
          SEP = false;
          src = "xbrl(별도)";
        }
        for (const [k, { xp, ...v }] of Object.entries(part))
          if (!(k in byYear)) { byYear[k] = { ...v, src }; srcOf[k] = [y, Number(k) === y ? 0 : 1]; xbrlParts[k] = xp; }
        // 보고서별 XBRL 값(재작성 전 판본 포함) — 원문 표 확인은 같은 보고서·같은 열과 대조
        if (y in part) xbrlAll[y] = Object.fromEntries(Object.entries(part).map(([k, { xp, ...v }]) => [k, v]));
        if (y in part) break;
      } catch (e) {
        console.log(`    (${y} ${rcp} XBRL 실패: ${e.message})`);
      }
    }
  }
  // XBRL 에 조정 태그가 없는 사용권자산·투자부동산 감가상각 줄 — 원문 현금흐름 조정 표에서 보완(한화오션: "사용권자산상각비 23,822" 줄에
  // 조정 태그가 없고 주석 변동표에만 있다). 원문의 기본 감가상각 줄이 XBRL 기본 줄과 같을 때만(같은 표라는 근거) 그 해에 원문 줄을 더한다.
  // 원문을 매번 받지 않도록 최신 XBRL 해에서 원문에 XBRL 이 없는 줄이 보일 때만 전 해를 본다
  {
    const near = (d, a, b) => a != null && b != null && Math.abs(a - b) < d.unit;
    const missing = (y, d, col) => ["rou", "inv"].filter((k) => xbrlParts[y]?.[k] == null && d?.parts[k]?.[col] != null);
    const xys = Object.keys(xbrlParts).map(Number).filter((y) => xbrlParts[y]?.base != null).sort((a, b) => b - a);
    const probe = xys[0] != null ? await docOf(srcOf[xys[0]][0]) : null;
    if (probe && missing(xys[0], probe, srcOf[xys[0]][1]).length) {
      for (const y of xys) {
        const [ry, col] = srcOf[y];
        const d = await docOf(ry);
        const add = missing(y, d, col);
        if (!add.length) continue;
        if (!near(d, d.parts.base[col], xbrlParts[y].base)) {
          console.log(`    (${y} 원문 기본 감가상각 ${d.parts.base[col]} ≠ XBRL ${xbrlParts[y].base} — ${add.join("·")} 보완 안 함)`);
          continue;
        }
        byYear[y].depreciation += add.reduce((a, k) => a + d.parts[k][col], 0);
        byYear[y].src = "xbrl+doc";
      }
    }
  }
  // 점검(--check): XBRL 이 있는 해도 원문 주석을 읽어 같은지 대조(원문 파서 검증 — DB 는 쓰지 않음)
  if (CHECK) {
    for (const y of Object.keys(byYear).map(Number)) {
      const [ry, col] = srcOf[y];
      const d = await docOf(ry);
      const x = byYear[y];
      const ok = d && docAgrees(d, col, x);
      console.log(`    점검 ${y}(${ry} 보고서 ${col ? "전기" : "당기"}): XBRL 감가 ${x.depreciation}/무형 ${x.amortisation} · 원문 ${d ? `${d.dep[col]}/${d.amo[col] ?? null}` : "없음"} ${ok ? "일치" : "불일치"}`);
    }
  }
  // XBRL 에 무형자산상각비 조정 태그가 없는 해(삼성SDI 2022 — 성격별 합계와의 차이 55,233 이 정확히 원문 무형자산상각비) — 원문 기본
  // 감가상각 줄이 XBRL 기본 줄과 같을 때(같은 표) 원문 무형자산상각비로 채운다
  for (const y of Object.keys(byYear).map(Number)) {
    if (byYear[y].amortisation != null || xbrlParts[y]?.base == null || !srcOf[y]) continue;
    const [ry, col] = srcOf[y];
    const d = await docOf(ry);
    const a = d?.amo?.[col];
    if (a == null || d.parts?.base?.[col] == null || Math.abs(d.parts.base[col] - xbrlParts[y].base) > d.unit) continue;
    byYear[y] = { ...byYear[y], amortisation: a, src: `${byYear[y].src}+원문무형` };
    console.log(`    (${y} XBRL 무형자산상각비 없음 — 원문 ${a})`);
  }

  // ── 원문은 보고서 단위로 확인(2026-10-02): 회사의 XBRL 해 하나만 대조하면 형식이 다른 옛 보고서에서 엉뚱한 표를 잡아도 걸러지지 않았다
  //    (LS 2020·2021 현금흐름 838억 — 실제 규모의 1/4). 보고서는 ① 같은 보고서 XBRL 의 같은 열(감가 + 무형 합계 또는 무형상각)과 단위
  //    이하로 같거나(재작성과 무관), ② XBRL 이 없는 옛 보고서는 이미 확인된 다른 보고서의 같은 해 값과 같을 때 믿는다. 확인이 퍼지도록 바뀌는
  //    게 없을 때까지 반복. 확인 못 한 해는 빈칸 + 로그(틀린 값보다 빈칸).
  const years = [];
  for (let y = latest; y >= latest - 5; y -= 1) years.push(y);
  const near = (a, b, u) => a != null && b != null && Math.abs(a - b) <= u;
  const tot = (dep, amo) => (dep == null ? null : dep + (amo ?? 0));
  const docs = {};
  for (const ry of years) {
    rcps[ry] ??= await annualRcps(corp, ry);
    docs[ry] = await docOf(ry);
  }
  // 한 표(원문 현금흐름 또는 성격별)의 보고서별 열 합계 → 확인된 보고서 집합
  // dropOf(ry, col): 이 보고서에만 따로 있는 줄 금액(투자부동산 감가상각) — 그 줄을 빼면 다른 보고서 값과 같을 때도 같은 표로 본다
  // (SK하이닉스 2021 보고서 10,658,498 − 투자부동산상각비 1,773 = 2022 보고서의 2021 값 10,656,725). 이렇게 확인한 보고서는 그 줄을 뺀
  // 값을 쓴다(newer 판본과 같은 기준) — ok.drop 에 표시
  const confirm = (colTot, sameReport, unitOf = (ry) => docs[ry].unit, dropOf = () => null) => {
    const ok = new Set();
    ok.drop = new Set();
    const vals = {}; // 해 → 확인된 값들
    for (let pass = 0; pass < 8; pass += 1) {
      let changed = false;
      for (const ry of years) {
        if (ok.has(ry) || !docs[ry]) continue;
        const u = unitOf(ry);
        const t = [colTot(ry, 0), colTot(ry, 1)];
        const td = [0, 1].map((col) => (t[col] != null && dropOf(ry, col) ? t[col] - dropOf(ry, col) : null));
        const match = (col, x) => x != null && (sameReport(ry, col, x, u) || (vals[ry - col] ?? []).some((v) => near(x, v, u)));
        let use = null;
        if ([0, 1].some((col) => match(col, t[col]))) use = t;
        else if ([0, 1].some((col) => match(col, td[col]))) {
          use = [0, 1].map((col) => td[col] ?? t[col]);
          ok.drop.add(ry);
        }
        if (!use) continue;
        ok.add(ry);
        changed = true;
        for (const col of [0, 1]) if (use[col] != null) (vals[ry - col] ??= []).push(use[col]);
      }
      if (!changed) break;
    }
    return ok;
  };
  const xTot = (ry, y) => (xbrlAll[ry]?.[y] ? tot(xbrlAll[ry][y].depreciation, xbrlAll[ry][y].amortisation) : null);
  const cfTot = (ry, col) => tot(docs[ry]?.dep[col], docs[ry]?.amo[col]);
  const cfOk = confirm(cfTot, (ry, col, t, u) => {
    const x = xbrlAll[ry]?.[ry - col];
    // 같은 보고서 XBRL: 합계 일치, 또는 무형상각 일치(XBRL 감가 줄이 부분합·없을 때 — 한화에어로스페이스 2024)
    return near(t, xTot(ry, ry - col), u) || (x?.amortisation > 0 && near(docs[ry].amo[col], x.amortisation, u));
  }, undefined, (ry, col) => docs[ry]?.parts?.inv?.[col] || null);
  if (process.env.KRDA_DEBUG)
    for (const ry of years)
      console.log(`    [debug] ${ry} 보고서 원문 현금흐름 ${cfTot(ry, 0)}/${cfTot(ry, 1)} 무형 ${docs[ry]?.amo[0]}/${docs[ry]?.amo[1]} · XBRL ${JSON.stringify(xbrlAll[ry] ?? null)} · 확인 ${cfOk.has(ry)}`);
  // 확인된 원문으로 빈 해 채우기 — 최신 보고서 우선(이듬해 보고서 전기 열 → 그 해 보고서 당기 열)
  for (const y of years) {
    if (byYear[y]?.depreciation != null) continue;
    for (const [ry, col] of [[y + 1, 1], [y, 0]]) {
      const d = docs[ry];
      if (!cfOk.has(ry) || d?.dep[col] == null) continue;
      const drop = cfOk.drop.has(ry) ? d.parts?.inv?.[col] ?? 0 : 0;
      byYear[y] = {
        depreciation: d.dep[col] - drop,
        amortisation: byYear[y]?.amortisation ?? d.amo[col] ?? null,
        src: (y in byYear ? "xbrl+doc" : "doc") + (d.sep ? "(별도)" : "") + (drop ? "−투자부동산" : ""),
      };
      srcOf[y] ??= [ry, col];
      break;
    }
  }
  const T = {};
  for (const y of years) if (byYear[y]?.depreciation != null) T[y] = tot(byYear[y].depreciation, byYear[y].amortisation);

  // ── 감가상각 = 영업비용 기준(오너 결정 2026-10-02 — "기준은 동일하게": EBITDA 의 영업이익과 같은 범위). 성격별 비용 주석은 매출원가·
  //    판관비, 즉 영업비용의 감가·무형상각(계속영업)이다. 현금흐름 조정 값엔 영업외(기타비용) 상각·중단영업분이 섞일 수 있다(현대로템 2025
  //    기타비용 투자부동산 상각 129,319, 한화에어로스페이스 2024 인적분할 사업분, LS 는 반대로 영업비용 안의 투자부동산 상각이 현금흐름 조정
  //    표에 없다). 앱은 감가 + 무형 합계만 쓴다. 성격별 표 확인: 같은 보고서의 확인된 현금흐름 합계(원문 또는 XBRL)와 한 열이 같거나(같은 표라는
  //    근거), 다른 확인된 성격별 보고서의 같은 해 값과 같을 때.
  const natTot = (nat, col) => {
    if (nat?.combined?.[col] != null) return nat.combined[col];
    if (!nat?.base) return null;
    const c = natureCols(nat);
    return c.dep[col] != null && c.amo[col] != null ? c.dep[col] + c.amo[col] : null;
  };
  const nTot = (ry, col) => natTot(docs[ry]?.nature, col);
  // 허용치 = 성격별·현금흐름 원문 표시 단위 중 큰 쪽(LS ELECTRIC 현금흐름 원 단위 vs 성격별 백만원 — 반올림 28만 원 차이)
  const natOk = confirm(
    nTot,
    // 손익계산서 본표(성격별 — 항목 합 = 영업비용 확인됨)는 그 자체로 같은 표
    (ry, col, t, u) => !!docs[ry]?.nature?.isIS || near(t, xTot(ry, ry - col), u) || (cfOk.has(ry) && near(t, cfTot(ry, col), u)),
    (ry) => Math.max(docs[ry]?.nature?.unit ?? 1, docs[ry]?.unit ?? 1),
  );
  // 보조 확인 — 중단영업이 두 해 다 있거나 재작성으로 이어지지 않아 위 대조가 불가능한 보고서(삼성SDI 2024·2025 — 성격별 2,009,936 이
  // 부문 정보 표 계속영업 합계와 같음을 원문으로 확인): 같은 회사의 확인된 성격별 보고서와 표 형식(열 구조·합친 줄 여부·자산별 줄·단위)이
  // 같으면 같은 표로 본다. 성격별 표에만 — 현금흐름 원문엔 쓰지 않는다(LS 옛 보고서 오판독 사례)
  const sig = (n) => (n ? `${n.wide ? "W" : "N"}${n.combined ? "C" : "S"}${n.rou ? "R" : ""}${n.inv ? "I" : ""}${n.unit}` : null);
  const okSigs = new Set([...natOk].map((ry) => sig(docs[ry]?.nature)));
  for (const ry of years) {
    if (natOk.has(ry) || !okSigs.has(sig(docs[ry]?.nature))) continue;
    natOk.add(ry);
    console.log(`    (${ry} 보고서 성격별 표 — 값 대조 불가(중단영업·재작성), 확인된 보고서와 표 형식 일치로 인정)`);
  }
  const N = {};
  const natFrom = {};
  for (const y of years)
    for (const [ry, col] of [[y + 1, 1], [y, 0]]) {
      if (!natOk.has(ry) || nTot(ry, col) == null) continue;
      N[y] = nTot(ry, col);
      natFrom[y] = { nat: docs[ry].nature, col };
      break;
    }
  for (const y of years) {
    const disc = xbrlParts[y]?.disc || 0;
    const tag = disc ? `중단영업 ${disc} — ` : "";
    if (y in N) {
      if (byYear[y]?.depreciation != null && near(N[y], T[y], natFrom[y].nat.unit)) {
        byYear[y].src += "+영업비용확인";
        continue;
      }
      const { nat, col } = natFrom[y];
      const amo = nat.amo?.[col] ?? byYear[y]?.amortisation ?? 0;
      console.log(`    (${y} ${tag}영업비용 기준 — 감가+무형 ${T[y] ?? "없음"} → ${N[y]})`);
      byYear[y] = { depreciation: N[y] - amo, amortisation: amo, src: `${byYear[y]?.src ?? "doc"}+영업비용` };
      continue;
    }
    if (byYear[y]?.depreciation == null) {
      console.log(`    (${y} 감가상각비 — XBRL·확인된 원문 모두 없음(보고서 사슬 끊김 포함): 빈칸)`);
      delete byYear[y];
    } else if (disc) console.log(`    (${y} ${tag}성격별 비용 확인 안 됨 — 현금흐름 조정 값 유지, 중단영업분 포함 가능: 미해결)`);
    // 그 밖은 현금흐름 값 유지(성격별 표가 없거나 사슬이 닿지 않은 해)
  }
  return Object.keys(byYear).length ? byYear : null;
}

// ── TTM 감가상각(2026-10-02 — LTM EBITDA 를 손익 TTM 과 같은 12개월로): 최근 사업연도 확정값(byYear) + 당기 누적 − 전년 동기 누적.
//    누적값은 반기·분기보고서 원문 성격별 비용 표(영업비용 기준 — 연간과 같은 기준)의 누적 열. 연간이 현금흐름 조정 값과 같다고 확인된
//    회사(src 에 "+영업비용" 없음)만 표가 없을 때 XBRL 현금흐름 조정 누적값으로 대신한다. 둘 다 없으면 TTM 없음(앱은 LTM EBITDA 빈칸).
const Q_OF_MONTH = { "03": [1, "11013", "1분기"], "06": [2, "11012", "반기"], "09": [3, "11014", "3분기"] };
async function latestInterim(corp, fy, month = null) {
  await new Promise((r) => setTimeout(r, 400));
  const j = await jget(`${B}/list.json?crtfc_key=${DART}&corp_code=${corp}&bgn_de=${fy + 1}0401&end_de=${fy + 2}0331&pblntf_detail_ty=A002&page_count=100`);
  const rows = (j.list ?? [])
    .map((r) => ({ r, m: r.report_nm.match(/\((\d{4})\.(\d{2})\)/) }))
    .filter((x) => x.m && Number(x.m[1]) === fy + 1 && Q_OF_MONTH[x.m[2]] && (!month || x.m[2] === month))
    .sort((a, b) => b.m[2].localeCompare(a.m[2]) || a.r.rcept_no.localeCompare(b.r.rcept_no));
  if (!rows.length) return null;
  const mon = rows[0].m[2];
  // 같은 기간 접수본 — 원본 먼저(정정본엔 표가 없을 수 있다)
  const rcps = rows.filter((x) => x.m[2] === mon).map((x) => x.r.rcept_no).sort();
  const [q, code, label] = Q_OF_MONTH[mon];
  return { year: fy + 1, q, code, label, rcps, month: mon };
}
/**
 * 반기·분기보고서 원문 성격별 표 — 당기 누적 열 합계(감가 + 무형). 이 표엔 전년 동기 열이 없다(현대로템·LS 2026 반기 실측) — 전년 동기는
 * 작년 같은 보고서의 당기 표로. 연결 표가 먼저, 별도 표가 뒤 — 첫 표. "매출의 성격별 분류" 표 제외
 */
function parseInterimNature(xml) {
  const lbl = (c) => (c ?? "").replace(/^[\s\-–·ㆍ•]+/, "").replace(/\s|\(.*?\)/g, "");
  const out = {};
  for (const m of xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
    const head = clean(xml.slice(Math.max(0, m.index - 400), m.index)).slice(-160);
    // "비용의 성격별 분류"·"성격별 비용"(HD현대일렉트릭) — "성격별 비용의 기능별 배분" 표는 제외
    if (!/비용의\s*성격별|성격별\s*비용/.test(head) || /기능별/.test(head.slice(-60))) continue;
    const per = /당(반기|분기|기)/.test(head.slice(-60)) ? "cur" : null;
    if (!per || out[per]) continue;
    const rows = [...m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1])));
    // 값 열 — 머리 줄에 "누적"이 있으면 그 열, 없으면 첫 숫자 열(누적만 공시)
    const hdr = rows.find((r) => r.some((c) => /누적/.test(c)));
    const cumIdx = hdr ? hdr.findIndex((c) => /누적/.test(c)) : -1;
    const valOf = (r) => {
      if (cumIdx >= 0) return numOf(r[cumIdx] ?? "");
      const v = r.slice(1).map((c) => (/^[-–]$/.test(c.trim()) ? 0 : numOf(c))).filter((x) => x != null);
      return v[0] ?? null;
    };
    const kind = (r) => {
      const t = lbl(r[0]);
      if (/^감가상각비(및|와)무형자산상각비$/.test(t)) return "comb";
      if (/^(감가상각비|유형자산(감가)?상각비)$/.test(t)) return "base";
      if (/^투자부동산(감가)?상각비$/.test(t)) return "inv";
      if (/^사용권자산(감가)?상각비$/.test(t)) return "rou";
      if (t === "무형자산상각비") return "amo";
      return null;
    };
    const by = {};
    for (const r of rows) { const k = kind(r); if (k && !(k in by)) by[k] = valOf(r); }
    if (by.comb == null && by.base == null) continue;
    const u = clean(m[0]).match(UNIT_RE)?.[1] ?? head.match(UNIT_RE)?.[1];
    if (!u) continue;
    const total = by.comb ?? (by.base ?? 0) + (by.inv ?? 0) + (by.rou ?? 0) + (by.amo ?? 0);
    out[per] = total * UNIT[u];
    out.unit = UNIT[u];
    break;
  }
  return out.cur != null ? out : null;
}
/**
 * 반기·분기 손익계산서 본표가 성격별인 회사(SK스퀘어 — "3개월 | 누적 | 3개월 | 누적") — 누적 열(당기·전년 동기)의 감가상각비·무형상각.
 * 영업비용 항목 합 = 영업비용 합계(누적 두 열)일 때만
 */
function interimIsByNature(rows, before) {
  const strip = (c) => (c ?? "").replace(/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩXIVL]+\.\s*/, "").replace(/\s/g, "");
  const iOp = rows.findIndex((r) => strip(r[0]) === "영업비용");
  if (iOp < 0 || !rows.some((r) => strip(r[0]).replace(/\(.*?\)/g, "") === "영업이익")) return null;
  const hdr = rows.find((r) => r.filter((c) => /누적/.test(c)).length === 2);
  if (!hdr) return null;
  // 숫자 열 중 누적 위치(머리 줄의 누적 순번 → 숫자 열 순번)
  const cumPos = hdr.map((c, i) => (/누적/.test(c) ? i : -1)).filter((i) => i >= 0).map((i) => hdr.slice(0, i).filter((c) => /3개월|누적/.test(c)).length);
  const nums = (r) => r.slice(1).map((c) => (/^[-–]$/.test(c.trim()) ? 0 : numOf(c))).filter((v) => v != null);
  const items = [];
  for (let i = iOp + 1; i < rows.length; i += 1) {
    if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/.test((rows[i][0] ?? "").trim()) || strip(rows[i][0]).replace(/\(.*?\)/g, "") === "영업이익") break;
    if (/^(지분법|영업외)/.test(strip(rows[i][0]))) break;
    items.push(rows[i]);
  }
  const dep = items.find((r) => strip(r[0]) === "감가상각비");
  if (!dep) return null;
  for (const p of cumPos) {
    const sum = items.reduce((a, r) => a + (nums(r)[p] ?? 0), 0);
    if (Math.abs(sum - (nums(rows[iOp])[p] ?? NaN)) > 1) return null;
  }
  const u = [...before.matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
  if (!u) return null;
  const amo = items.find((r) => strip(r[0]) === "무형자산상각비");
  const at = (p) => ((nums(dep)[p] ?? 0) + (amo ? nums(amo)[p] ?? 0 : 0)) * UNIT[u];
  return { cur: at(cumPos[0]), prior: at(cumPos[1]), unit: UNIT[u] };
}
async function interimDoc(rcpNo) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
  if (!res.ok) throw new Error(`document ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  let nat = null;
  let cf = null;
  for (const b of Object.values(files)) {
    let x = new TextDecoder("utf-8").decode(b);
    if ((x.match(/�/g) ?? []).length > 50) x = new TextDecoder("euc-kr").decode(b);
    nat ??= parseInterimNature(x);
    if (!nat)
      for (const m of x.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
        const rows = [...m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1])));
        const is = interimIsByNature(rows, clean(x.slice(Math.max(0, m.index - 1500), m.index)));
        if (is) { nat = is; break; }
      }
    // 현금흐름 조정 주석(당기 누적·전기 누적 열) — XBRL 에 조정 태그가 없는 회사(한전KPS 2026 반기)용
    if (!cf) {
      const c = parseDocDa(x);
      if (c && c.dep[0] != null && c.dep[1] != null) cf = { cur: c.dep[0] + (c.amo[0] ?? 0), prior: c.dep[1] + (c.amo[1] ?? 0), unit: c.unit };
    }
  }
  return nat || cf ? { ...(nat ?? {}), cf } : null;
}
/** 반기·분기보고서 XBRL 현금흐름 조정 누적(감가 + 사용권 + 투자부동산 + 무형) — 당기·전년 동기 */
async function interimCf(rcpNo, code, year) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`${B}/fnlttXbrl.xml?crtfc_key=${DART}&rcept_no=${rcpNo}&reprt_code=${code}`);
  if (!res.ok) return null;
  let xml;
  try {
    const f = unzipSync(new Uint8Array(await res.arrayBuffer()));
    xml = strFromU8(f[Object.keys(f).find((n) => n.endsWith(".xbrl"))]);
  } catch {
    return null;
  }
  // 누적 컨텍스트 접두어(반기 CFY2026dHYA, 1분기·3분기는 회사 XBRL 마다 다를 수 있어 실제 값이 있는 접두어를 찾는다)
  const prefixes = (y, cp) => [...new Set([...xml.matchAll(new RegExp(`contextRef="(${cp}${y}d[A-Z0-9]*?A)_`, "g"))].map((m) => m[1]))];
  const tot = (prefix) => {
    const d0 = pick(xml, DEP_C, prefix);
    if (d0 == null) return null;
    const [rou, inv] = DEP_EXTRA.map(([c, ent]) => pick(xml, [c], prefix) ?? pickEntity(xml, ent, prefix));
    return d0 + (rou ?? 0) + (inv ?? 0) + (pick(xml, AMO_C, prefix) ?? 0);
  };
  const cp = prefixes(year, "CFY").map(tot).find((v) => v != null);
  const pp = prefixes(year - 1, "PFY").map(tot).find((v) => v != null);
  return cp != null && pp != null ? { cur: cp, prior: pp, unit: 1 } : null;
}
async function ttmDa(corp, byYear) {
  const fy = Math.max(...Object.keys(byYear).map(Number));
  const fyRow = byYear[fy];
  if (!fyRow || fyRow.depreciation == null) return null;
  const it = await latestInterim(corp, fy);
  if (!it) return null;
  const fyTot = fyRow.depreciation + (fyRow.amortisation ?? 0);
  let part = null;
  let how = "";
  const firstDoc = async (rcps) => {
    for (const rc of rcps) {
      const d = await interimDoc(rc).catch(() => null);
      if (d?.cur != null) return d;
    }
    return null;
  };
  const docs = [];
  for (const rc of it.rcps) docs.push(await interimDoc(rc).catch(() => null));
  const curN = docs.find((d) => d?.cur != null) ?? null;
  if (curN?.prior != null) {
    // 성격별 손익계산서 본표 — 같은 보고서에 전년 동기 누적이 있다
    part = { cur: curN.cur, prior: curN.prior };
    how = "성격별(손익계산서 본표)";
  } else if (curN) {
    // 전년 동기 = 작년 같은 기간 보고서의 당기 표
    const prevIt = await latestInterim(corp, fy - 1, it.month);
    const prevN = prevIt ? await firstDoc(prevIt.rcps) : null;
    if (prevN) {
      part = { cur: curN.cur, prior: prevN.cur };
      how = "성격별";
    }
  }
  // 연간이 현금흐름 조정 값과 다른(성격별로 바꾼) 회사는 XBRL 대체 불가 — 기준이 달라진다
  if (!part && !/\+영업비용(?!확인)/.test(fyRow.src ?? "")) {
    for (const rc of it.rcps) {
      part = await interimCf(rc, it.code, it.year);
      if (part) { how = "현금흐름 조정"; break; }
    }
    // XBRL 에 없으면 원문 현금흐름 조정 주석(당기·전기 누적 열)
    if (!part) {
      const c = docs.find((d) => d?.cf)?.cf;
      if (c) { part = c; how = "현금흐름 조정(원문)"; }
    }
  }
  if (!part) {
    console.log(`    (TTM — ${it.year} ${it.label} 누적 감가상각 못 찾음: 없음)`);
    return null;
  }
  const v = fyTot + part.cur - part.prior;
  return { ttmDepreciation: v, ttmAmortisation: 0, ttmLabel: `FY${fy} + ${it.year} ${it.label} − ${it.year - 1} ${it.label}`, ttmSrc: how };
}

const cli = new MongoClient(URI);
await cli.connect();
const db = cli.db(DB);
let symbols = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// 유니버스는 계정별 문서라 같은 종목이 여러 번 — 중복 제거
if (symbols.length === 0)
  symbols = [...new Set((await db.collection("universe_items").find({ market: "kr" }).toArray()).map((d) => d.symbol))];
console.log(`대상 ${symbols.length}종목 → ${CHECK ? "(점검 — 쓰기 없음)" : COLL}`);

const t = (n) => (n == null ? "-" : (n / 1e12).toFixed(2) + "조");
for (const sym of symbols) {
  const corp = corpOf(sym);
  if (!corp) { console.log(`  ${sym}: corp_code 없음`); continue; }
  let byYear = null;
  try { byYear = await daByYear(corp); } catch (e) { console.log(`  ${sym}: ${e.message}`); }
  if (!byYear) { console.log(`  ${sym}: D&A 없음`); continue; }
  const ttm = await ttmDa(corp, byYear).catch((e) => (console.log(`    (TTM 실패: ${e.message})`), null));
  if (ttm) console.log(`    TTM ${ttm.ttmLabel} = ${t(ttm.ttmDepreciation)} (${ttm.ttmSrc})`);
  if (!CHECK) await db.collection(COLL).replaceOne(
    { _id: sym },
    { _id: sym, byYear, ...(ttm ?? {}), updatedAt: new Date().toISOString() },
    { upsert: true },
  );
  const yrs = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  const y = yrs[0];
  console.log(`  ${sym}  ${yrs.length}개년 (${yrs.at(-1)}~${y})  ` + yrs.map((k) => `${k}:${byYear[k].src} 감가 ${t(byYear[k].depreciation)}/무형 ${t(byYear[k].amortisation)}`).join("  "));
}
await cli.close();
console.log("완료");
