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
const corpMap = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
);
const corpOf = (code) => {
  const d = code.replace(/\D/g, "").padStart(6, "0");
  const row = corpMap.find((r) => (r.s ?? r.stock_code) === d);
  return row ? (row.c ?? row.corp_code) : null;
};
const jget = (url) => fetch(url).then((r) => r.json());

/** 특정 사업연도 사업보고서 접수번호 (정정본 우선). */
async function annualRcp(corp, year) {
  const j = await jget(
    `${B}/list.json?crtfc_key=${DART}&corp_code=${corp}` +
      `&bgn_de=${year + 1}0101&end_de=${year + 1}0930&pblntf_detail_ty=A001&page_count=100`,
  );
  const rows = (j.list ?? []).filter((r) => /사업보고서/.test(r.report_nm));
  rows.sort((a, b) => b.rcept_no.localeCompare(a.rcept_no));
  return rows[0]?.rcept_no ?? null;
}

async function loadXbrl(rcpNo) {
  const res = await fetch(`${B}/fnlttXbrl.xml?crtfc_key=${DART}&rcept_no=${rcpNo}&reprt_code=11011`);
  if (!res.ok) throw new Error(`xbrl ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const name = Object.keys(files).find((n) => n.endsWith(".xbrl"));
  if (!name) throw new Error("xbrl not in zip");
  return strFromU8(files[name]);
}

const DEP_C = ["AdjustmentsForDepreciationExpense", "AdjustmentsForDepreciationAndAmortisationExpense"];
const AMO_C = ["AdjustmentsForAmortisationExpense"];

function ctxOk(ctx, prefix) {
  if (!ctx.startsWith(prefix + "_") && ctx !== prefix) return false;
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

/** 한 보고서에서 당기·전기 2개년. */
function fromReport(xml, year) {
  const out = {};
  for (const [y, prefix] of [
    [year, `CFY${year}dFY`],
    [year - 1, `PFY${year - 1}dFY`],
  ]) {
    const d = pick(xml, DEP_C, prefix);
    const a = pick(xml, AMO_C, prefix);
    if (d != null || a != null) out[y] = { depreciation: d, amortisation: a };
  }
  return out;
}

async function daByYear(corp) {
  const now = new Date();
  // 최신 확정 사업연도 탐색
  let latest = 0;
  for (const y of [now.getFullYear() - 1, now.getFullYear() - 2]) {
    if (await annualRcp(corp, y)) { latest = y; break; }
  }
  if (!latest) return null;
  const byYear = {};
  for (let y = latest; y >= latest - 5; y -= 2) {
    const rcp = await annualRcp(corp, y);
    if (!rcp) continue;
    try {
      const part = fromReport(await loadXbrl(rcp), y);
      for (const [k, v] of Object.entries(part)) if (!(k in byYear)) byYear[k] = v;
    } catch (e) {
      console.log(`    (${y} 보고서 실패: ${e.message})`);
    }
  }
  return Object.keys(byYear).length ? byYear : null;
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
  let byYear = null;
  try { byYear = await daByYear(corp); } catch (e) { console.log(`  ${sym}: ${e.message}`); }
  if (!byYear) { console.log(`  ${sym}: D&A 없음`); continue; }
  await db.collection("kr_da").replaceOne(
    { _id: sym },
    { _id: sym, byYear, updatedAt: new Date().toISOString() },
    { upsert: true },
  );
  const yrs = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  const y = yrs[0];
  console.log(`  ${sym}  ${yrs.length}개년 (${yrs.at(-1)}~${y})  최근: 감가 ${t(byYear[y].depreciation)} / 무형 ${t(byYear[y].amortisation)}`);
}
await cli.close();
console.log("완료");
