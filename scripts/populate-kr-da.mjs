/**
 * 한국 종목 감가상각비·무형자산상각비(연결)를 DART XBRL 에서 파싱해 MongoDB(kr_da)에 적재.
 * TTM 기준: 직전 사업보고서(연간) + 당기 누적(최신 분기·반기) − 전년 동기 누적.
 *
 * OpenDART XBRL 엔드포인트는 클라우드 IP(Vercel)를 차단하므로 로컬/개인 IP 에서 실행.
 * 분기·반기 보고서가 나올 때마다(연 4회) 재실행 권장.
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
const corpMap = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
);
const corpOf = (code) => {
  const d = code.replace(/\D/g, "").padStart(6, "0");
  const row = corpMap.find((r) => (r.s ?? r.stock_code) === d);
  return row ? (row.c ?? row.corp_code) : null;
};

const jget = (url) => fetch(url).then((r) => r.json());

/** 최근 보고서 접수번호. detailTy: A001 사업 / A002 반기 / A003 분기 */
async function latestRcp(corp, detailTy) {
  const now = new Date();
  const from = `${now.getFullYear() - 1}0101`;
  const to = `${now.getFullYear()}1231`;
  const j = await jget(
    `${B}/list.json?crtfc_key=${DART}&corp_code=${corp}&bgn_de=${from}&end_de=${to}` +
      `&pblntf_detail_ty=${detailTy}&page_count=100`,
  );
  const list = (j.list ?? []).filter((r) => /보고서/.test(r.report_nm));
  list.sort((a, b) => b.rcept_no.localeCompare(a.rcept_no));
  return list[0]?.rcept_no ?? null;
}

async function loadXbrl(rcpNo, reprtCode) {
  const res = await fetch(`${B}/fnlttXbrl.xml?crtfc_key=${DART}&rcept_no=${rcpNo}&reprt_code=${reprtCode}`);
  if (!res.ok) throw new Error(`xbrl ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const name = Object.keys(files).find((n) => n.endsWith(".xbrl"));
  if (!name) throw new Error("xbrl not in zip");
  return strFromU8(files[name]);
}

const CONCEPTS_DEP = ["AdjustmentsForDepreciationExpense", "AdjustmentsForDepreciationAndAmortisationExpense"];
const CONCEPTS_AMO = ["AdjustmentsForAmortisationExpense"];

/** prefix 예: "CFY2025dFY", "CFY2026dHYA", "PFY2025dHYA" */
function pick(xml, concepts, prefix) {
  for (const c of concepts) {
    const re = new RegExp(`<(?:ifrs-full|dart):${c}\\b[^>]*contextRef="([^"]+)"[^>]*>(-?\\d+)</`, "g");
    let m;
    while ((m = re.exec(xml))) {
      const ctx = m[1];
      if (!ctx.startsWith(prefix + "_")) continue;
      if (!ctx.includes("_ConsolidatedMember")) continue;
      if (/SegmentConsolidationItemsAxis|OperatingSegments|ClassesOfAssets/.test(ctx)) continue;
      if (/ConsolidatedMember$/.test(ctx) || /ReportedAmountMember$/.test(ctx)) return Number(m[2]);
    }
  }
  return null;
}

/** 최신 당기 누적 컨텍스트 (dFY 제외, 최근 연도). 예: {year:2026, prefix:"CFY2026dHYA"} */
function currentCum(xml) {
  const re = /contextRef="CFY(\d{4})d([A-Z0-9]+)_/g;
  let best = null;
  let m;
  while ((m = re.exec(xml))) {
    if (m[2] === "FY") continue;
    const year = Number(m[1]);
    if (!best || year > best.year) best = { year, prefix: `CFY${year}d${m[2]}` };
  }
  return best;
}

async function ttmDA(corp) {
  const y = new Date().getFullYear();
  // 1) 직전 사업보고서 (연간)
  let annualDep = null, annualAmo = null, annualYear = null;
  for (const yr of [y - 1, y - 2]) {
    const rcp = await latestRcpForYear(corp, "A001", yr);
    if (!rcp) continue;
    try {
      const x = await loadXbrl(rcp, "11011");
      const d = pick(x, CONCEPTS_DEP, `CFY${yr}dFY`);
      const a = pick(x, CONCEPTS_AMO, `CFY${yr}dFY`);
      if (d != null || a != null) { annualDep = d; annualAmo = a; annualYear = yr; break; }
    } catch {}
  }
  if (annualYear == null) return null;

  // 2) 최신 분기·반기 → 당기누적 & 전년동기누적
  let interimX = null;
  for (const [ty, rc] of [["A002", "11012"], ["A003", "11014"], ["A003", "11013"]]) {
    const rcp = await latestRcp(corp, ty);
    if (!rcp) continue;
    try {
      interimX = await loadXbrl(rcp, rc);
      break;
    } catch {}
  }

  let dep = annualDep, amo = annualAmo, basis = "annual", label = `FY${annualYear}`, year = annualYear;
  const cur = interimX ? currentCum(interimX) : null;
  if (cur && cur.year >= annualYear) {
    const priorP = cur.prefix.replace(`CFY${cur.year}`, `PFY${cur.year - 1}`);
    const curD = pick(interimX, CONCEPTS_DEP, cur.prefix);
    const priD = pick(interimX, CONCEPTS_DEP, priorP);
    const curA = pick(interimX, CONCEPTS_AMO, cur.prefix);
    const priA = pick(interimX, CONCEPTS_AMO, priorP);
    if (curD != null && priD != null && annualDep != null) {
      dep = annualDep + curD - priD;
      amo = annualAmo != null && curA != null && priA != null ? annualAmo + curA - priA : annualAmo;
      basis = "ttm";
      year = cur.year;
      label = `FY${annualYear} + ${cur.year}${cur.prefix.replace(/^CFY\d+d/, "")} − ${cur.year - 1}동기`;
    }
  }
  return { year, depreciation: dep, amortisation: amo, basis, label };
}

/** 특정 연도의 사업보고서 접수번호 */
async function latestRcpForYear(corp, detailTy, year) {
  const j = await jget(
    `${B}/list.json?crtfc_key=${DART}&corp_code=${corp}` +
      `&bgn_de=${year + 1}0101&end_de=${year + 1}0930&pblntf_detail_ty=${detailTy}&page_count=100`,
  );
  const list = (j.list ?? []).filter((r) => /사업보고서/.test(r.report_nm));
  list.sort((a, b) => b.rcept_no.localeCompare(a.rcept_no));
  return list[0]?.rcept_no ?? null;
}

const cli = new MongoClient(URI);
await cli.connect();
const db = cli.db(DB);
let symbols = process.argv.slice(2);
if (symbols.length === 0)
  symbols = (await db.collection("universe_items").find({ market: "kr" }).toArray()).map((d) => d.symbol);
console.log(`대상 ${symbols.length}종목`);

const t = (n) => (n == null ? "-" : (n / 1e12).toFixed(2) + "조");
for (const sym of symbols) {
  const corp = corpOf(sym);
  if (!corp) { console.log(`  ${sym}: corp_code 없음`); continue; }
  let da = null;
  try { da = await ttmDA(corp); } catch (e) { console.log(`  ${sym}: ${e.message}`); }
  if (!da || (da.depreciation == null && da.amortisation == null)) { console.log(`  ${sym}: D&A 없음`); continue; }
  await db.collection("kr_da").replaceOne(
    { _id: sym },
    { _id: sym, ...da, updatedAt: new Date().toISOString() },
    { upsert: true },
  );
  console.log(`  ${sym} [${da.basis}] 감가 ${t(da.depreciation)} / 무형 ${t(da.amortisation)}  (${da.label})`);
}
await cli.close();
console.log("완료");
