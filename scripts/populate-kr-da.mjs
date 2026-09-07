/**
 * 한국 종목 감가상각비·무형자산상각비를 DART XBRL 에서 파싱해 MongoDB(kr_da)에 적재.
 *
 * OpenDART XBRL 엔드포인트는 클라우드 IP(Vercel)를 차단하므로 로컬/개인 IP 에서 실행.
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

// 종목코드 → corp_code : 번들 JSON 사용
const corpMap = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
);
const corpOf = (code) => {
  const d = code.replace(/\D/g, "").padStart(6, "0");
  const row = Array.isArray(corpMap)
    ? corpMap.find((r) => (r.s ?? r.stock_code) === d)
    : null;
  return row ? (row.c ?? row.corp_code) : null;
};

async function jget(url) {
  const r = await fetch(url);
  return r.json();
}

async function rcpNo(corp, year) {
  const j = await jget(
    `${B}/list.json?crtfc_key=${DART}&corp_code=${corp}` +
      `&bgn_de=${year + 1}0101&end_de=${year + 1}0930&pblntf_detail_ty=A001&page_count=100`,
  );
  const list = (j.list ?? []).filter((r) => /사업보고서/.test(r.report_nm));
  list.sort((a, b) => b.rcept_no.localeCompare(a.rcept_no));
  return list[0]?.rcept_no ?? null;
}

function ctxOk(ctx, year) {
  if (!ctx.startsWith(`CFY${year}dFY_`)) return false;
  if (!ctx.includes("_ConsolidatedMember")) return false;
  if (/SegmentConsolidationItemsAxis|OperatingSegments|ClassesOfAssets/.test(ctx)) return false;
  return /ConsolidatedMember$/.test(ctx) || /ReportedAmountMember$/.test(ctx);
}
function pick(xml, concepts, year) {
  for (const c of concepts) {
    const re = new RegExp(`<(?:ifrs-full|dart):${c}\\b[^>]*contextRef="([^"]+)"[^>]*>(-?\\d+)</`, "g");
    let m;
    while ((m = re.exec(xml))) if (ctxOk(m[1], year)) return Number(m[2]);
  }
  return null;
}

async function daFor(corp, year) {
  const rcp = await rcpNo(corp, year);
  if (!rcp) return null;
  const res = await fetch(`${B}/fnlttXbrl.xml?crtfc_key=${DART}&rcept_no=${rcp}&reprt_code=11011`);
  if (!res.ok) return null;
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const name = Object.keys(files).find((n) => n.endsWith(".xbrl"));
  if (!name) return null;
  const xml = strFromU8(files[name]);
  const dep =
    pick(xml, ["AdjustmentsForDepreciationExpense"], year) ??
    pick(xml, ["AdjustmentsForDepreciationAndAmortisationExpense"], year);
  const amo = pick(xml, ["AdjustmentsForAmortisationExpense"], year);
  if (dep == null && amo == null) return null;
  return { year, depreciation: dep, amortisation: amo };
}

const cli = new MongoClient(URI);
await cli.connect();
const db = cli.db(DB);

let symbols = process.argv.slice(2);
if (symbols.length === 0) {
  symbols = (await db.collection("universe_items").find({ market: "kr" }).toArray()).map((d) => d.symbol);
}
console.log(`대상 ${symbols.length}종목`);

const thisYear = new Date().getFullYear();
for (const sym of symbols) {
  const corp = corpOf(sym);
  if (!corp) {
    console.log(`  ${sym}: corp_code 없음`);
    continue;
  }
  let da = null;
  for (const y of [thisYear - 1, thisYear - 2]) {
    try {
      da = await daFor(corp, y);
    } catch (e) {
      console.log(`  ${sym} ${y}: ${e.message}`);
    }
    if (da) break;
  }
  if (!da) {
    console.log(`  ${sym}: D&A 없음`);
    continue;
  }
  await db.collection("kr_da").replaceOne(
    { _id: sym },
    { _id: sym, ...da, updatedAt: new Date().toISOString() },
    { upsert: true },
  );
  const t = (n) => (n == null ? "-" : (n / 1e12).toFixed(2) + "조");
  console.log(`  ${sym} FY${da.year}: 감가 ${t(da.depreciation)} / 무형 ${t(da.amortisation)}`);
}

await cli.close();
console.log("완료");
