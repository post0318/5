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
/** 문서에서 현금흐름 조정 표(감가상각비 줄)를 찾아 [당기, 전기] */
function parseDocDa(xml) {
  for (const m of xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
    const html = m[0];
    const rows = [...html.matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1])));
    // 줄 이름 앞 기호("- 감가상각비" — LG화학) 떼고 공백·괄호 제거
    const label = (r) => (r[0] ?? "").replace(/^[\s\-–·ㆍ•]+/, "").replace(/\s|\(.*?\)/g, "");
    const dep = rows.find((r) => /^감가상각비$/.test(label(r)));
    if (!dep) continue;
    const names = rows.map(label).join("|");
    const before = clean(xml.slice(Math.max(0, m.index - 1500), m.index));
    const head = before.slice(-300);
    // 현금흐름 조정 표 — 표 앞 제목이나 조정 항목 줄로 판별. 비용 분류·판관비 표는 제외
    const isCf = (/현금흐름/.test(head) && /창출|조정|영업활동/.test(head)) || /조정항목|배당금수익|이자수익|법인세비용|유형자산처분/.test(names);
    if (!isCf || /복리후생비|광고선전비|외주용역비|운반보관비/.test(names)) continue;
    const amo = rows.find((r) => /^무형자산상각비$/.test(label(r)));
    // 단위 — 표 안 첫 줄("(단위: 백만원)")이 우선, 없으면 표 바로 앞 문장
    const u = clean(html).match(UNIT_RE)?.[1] ?? [...before.matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
    if (!u) continue;
    const nums = (r) => r.slice(1).map(numOf).filter((v) => v != null);
    return { dep: nums(dep).map((v) => v * UNIT[u]), amo: amo ? nums(amo).map((v) => v * UNIT[u]) : [] };
  }
  return null;
}
/** 사업보고서 원문 — 연결감사보고서 파일의 첫 현금흐름 조정 표 */
async function docDa(rcpNo) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
  if (!res.ok) throw new Error(`document ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  for (const b of Object.values(files)) {
    // 인코딩 — 선언은 늘 utf-8 이지만 2021 이전 문서는 실제 EUC-KR(실측). UTF-8 로 읽어 깨진 글자가 많으면 EUC-KR
    let x = new TextDecoder("utf-8").decode(b);
    if ((x.match(/�/g) ?? []).length > 50) x = new TextDecoder("euc-kr").decode(b);
    if (!/연결감사보고서/.test(clean(x.slice(0, 3000)))) continue;
    const t = parseDocDa(x);
    if (t) return t;
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
  const rcps = {};
  for (const y of [now.getFullYear() - 1, now.getFullYear() - 2]) {
    rcps[y] = await annualRcps(corp, y);
    if (rcps[y].length) { latest = y; break; }
  }
  if (!latest) return null;
  const byYear = {};
  // 매년 보고서(최신부터 — 겹치는 해는 최신 보고서 값). 2년 간격이면 2022 보고서를 건너뛰어 2021 값(2022 보고서 전기)이 빠졌다 —
  // 2021 보고서 XBRL 은 주석 태깅 자체가 없다(삼성전자 실측 2026-10-02)
  for (let y = latest; y >= latest - 5; y -= 1) {
    rcps[y] ??= await annualRcps(corp, y);
    // 정정본 XBRL 에 그 해 값이 없으면 다음(원본) 접수본
    for (const rcp of rcps[y]) {
      try {
        const part = fromReport(await loadXbrl(rcp), y);
        for (const [k, v] of Object.entries(part)) if (!(k in byYear)) byYear[k] = { ...v, src: "xbrl" };
        if (y in part) break;
      } catch (e) {
        console.log(`    (${y} ${rcp} XBRL 실패: ${e.message})`);
      }
    }
  }
  // XBRL 로 못 채운 해 — 그 해(없으면 이듬해 보고서의 전기 열) 사업보고서 원문 주석
  for (let y = latest; y >= latest - 5; y -= 1) {
    if (y in byYear) continue;
    for (const [ry, col] of [[y, 0], [y + 1, 1]]) {
      if (y in byYear || ry > latest) continue;
      for (const rcp of rcps[ry] ?? []) {
        try {
          const t = await docDa(rcp);
          if (t && t.dep[col] != null) {
            byYear[y] = { depreciation: t.dep[col], amortisation: t.amo[col] ?? null, src: "doc" };
            break;
          }
        } catch (e) {
          console.log(`    (${ry} ${rcp} 원문 실패: ${e.message})`);
        }
      }
    }
    if (!(y in byYear)) console.log(`    (${y} 감가상각비 — XBRL·원문 주석 모두 못 찾음)`);
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
  console.log(`  ${sym}  ${yrs.length}개년 (${yrs.at(-1)}~${y})  ` + yrs.map((k) => `${k}:${byYear[k].src} 감가 ${t(byYear[k].depreciation)}/무형 ${t(byYear[k].amortisation)}`).join("  "));
}
await cli.close();
console.log("완료");
