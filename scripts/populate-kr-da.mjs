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
import { existsSync, readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { MongoClient } from "mongodb";
import { makeDartQuota } from "./lib/dart-quota.mjs";

// 설정 — 개발 폴더(로컬·2호기)는 .env.local, 운영 1호기 배치는 컨테이너 환경변수(ops/oracle/run-kr-da.sh 가 /opt/macro/jobs.env 로 넣는다).
// .env.local 이 있으면 그 값이 먼저(개발 폴더에서 셸 환경변수가 섞이지 않게)
const ENV_FILE = new URL("../.env.local", import.meta.url);
const env = {
  ...process.env,
  ...(existsSync(ENV_FILE)
    ? Object.fromEntries(
        readFileSync(ENV_FILE, "utf8")
          .split(/\r?\n/)
          .filter((l) => l && !l.startsWith("#") && l.includes("="))
          .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
          }),
      )
    : {}),
};
const DART = env.DART_API_KEY;
// 쓰는 곳 = MONGODB_URI + KR_DA_COLLECTION(기본 kr_da_staging) 하나뿐(오너 결정 2026-10-05 — "검증 쪽은 운영 DB 에 쓰지 않는다, 운영 반영은 master 병합
// 후 운영 1호기가 직접"). 예전 --prod·MONGODB_URI_PROD 경로는 없앴다
const URI = env.MONGODB_URI;
const DB = env.MONGODB_DB || "market_research";
if (!DART || !URI) throw new Error("DART_API_KEY / MONGODB_URI 필요(.env.local 또는 환경변수)");
if (process.argv.includes("--prod")) throw new Error("--prod 는 없앴다 — 운영 kr_da 는 1호기 배치(fin-kr-da)만 쓴다");

const B = "https://opendart.fss.or.kr/api";
const CHECK = process.argv.includes("--check");
// 적재 컬렉션 — 기본 kr_da_staging. 운영 kr_da 는 1호기 배치만: KR_DA_ALLOW_PROD=1 이고 개발 폴더(.env.local 있음)가 아닐 때
const COLL = env.KR_DA_COLLECTION || "kr_da_staging";
if (COLL === "kr_da" && (env.KR_DA_ALLOW_PROD !== "1" || existsSync(ENV_FILE)))
  throw new Error("운영 컬렉션 kr_da 적재는 운영 1호기 배치(fin-kr-da, ops/oracle/run-kr-da.sh)만 — 검증·로컬에서는 kr_da_staging");
// 적재 규칙 판본 — 감가상각·TTM·리스 판독 규칙을 바꾸면 올린다. 적재본의 판본이 다르면 증분 모드에서도 그 종목을 다시 처리하고, 1호기 배포 직후 1회 실행된다
// (post-deploy.sh 가 이 줄을 비교)
const KR_DA_RULES_VERSION = "2026-10-05.1";
const FULL = process.argv.includes("--full");
const corpMap = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
);
const corpOf = (code) => {
  const d = code.replace(/\D/g, "").padStart(6, "0");
  const row = corpMap.find((r) => (r.s ?? r.stock_code) === d);
  return row ? (row.c ?? row.corp_code) : null;
};
// DART 하루 요청 상한(2026-10-05 사고 — 운영과 같은 키의 한도를 다 써 운영 한국 재무가 멈췄다). DART_DAILY_CAP_POPULATE(기본 2,000), 020 이면 즉시 중단.
// 중단되면 그 뒤 종목은 처리하지 않고(적재도 안 함) 목록을 남긴다
// 카운터 폴더 — 개발 폴더는 reports/.dart-quota, 1호기는 DART_QUOTA_DIR(작업 폴더가 읽기 전용이라 바깥 폴더를 붙인다)
const QUOTA = makeDartQuota({ tool: "populate", cap: Number(env.DART_DAILY_CAP_POPULATE ?? 2000), dir: env.DART_QUOTA_DIR ? new URL(`file://${env.DART_QUOTA_DIR.replace(/\/?$/, "/")}`) : new URL("../reports/.dart-quota/", import.meta.url) });
async function dfetch(url) {
  QUOTA.take();
  const r = await fetch(url);
  const buf = await r.arrayBuffer();
  QUOTA.check(new TextDecoder("utf-8").decode(new Uint8Array(buf).slice(0, 400)));
  return new Response(buf, { status: r.status, headers: r.headers });
}
const jget = (url) => dfetch(url).then((r) => r.json());

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

/**
 * 증분 모드 — 그 회사 정기공시(최근 3년) 중 가장 늦게 접수된 사업보고서·반기/분기보고서 접수번호(정정본 포함). DART 요청 1건(list.json).
 * 적재본의 sourceRcepts·rulesVersion 과 같으면 그 종목은 다시 처리하지 않는다
 */
async function latestPeriodicRcepts(corp) {
  const now = new Date(Date.now() + 9 * 3600e3);
  const end = now.toISOString().slice(0, 10).replace(/-/g, "");
  const j = await jget(`${B}/list.json?crtfc_key=${DART}&corp_code=${corp}&bgn_de=${now.getUTCFullYear() - 3}0101&end_de=${end}&pblntf_ty=A&page_count=100`);
  if (j.status !== "000" && j.status !== "013") throw new Error(`list.json ${j.status} ${j.message ?? ""}`);
  const rows = (j.list ?? []).map((r) => ({ r, m: /(사업|반기|분기)보고서\s*\(\d{4}\.\d{2}\)/.exec(r.report_nm ?? "") })).filter((x) => x.m);
  const max = (f) => rows.filter(f).map((x) => x.r.rcept_no).sort().at(-1) ?? null;
  return { annual: max((x) => x.m[1] === "사업"), interim: max((x) => x.m[1] !== "사업") };
}

async function loadXbrl(rcpNo) {
  // DART 는 몰아서 요청하면 이 PC 연결을 약 1시간 막는다(실측 2026-10-01) — XBRL 요청마다 1초 간격
  await new Promise((r) => setTimeout(r, 1000));
  const res = await dfetch(`${B}/fnlttXbrl.xml?crtfc_key=${DART}&rcept_no=${rcpNo}&reprt_code=11011`);
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
    // 투자부동산·사용권 줄을 먼저(감사 3차 — "감가상각비(투자부동산)"이 괄호를 지운 이름 "감가상각비"로 base 판정에 걸려 버려졌다: 051600 2023~2025
    // 영업비용 안 투자부동산 감가상각 1,300만원대가 빠졌다)
    if (/^(투자부동산(감가)?상각비|감가상각비\(투자부동산\))$/.test(t)) return "inv";
    if (/^(사용권자산(감가)?상각비|감가상각비\(사용권자산\))$/.test(t)) return "rou";
    if (/^(유형자산(감가)?상각비|감가상각비\(유형자산\))$/.test(t) || lbl(r) === "감가상각비") return "base";
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
  const res = await dfetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
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
        if (y in part) xbrlAll[y] = Object.fromEntries(Object.entries(part).map(([k, v]) => [k, { depreciation: v.depreciation, amortisation: v.amortisation }]));
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
  const found = [];
  let ti = -1, lastCurAt = -9; // 표 순번 · 마지막으로 받은 당기 성격별 표의 순번
  for (const m of xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
    ti += 1;
    const head = clean(xml.slice(Math.max(0, m.index - 400), m.index)).slice(-160);
    // "비용의 성격별 분류"·"성격별 비용"(HD현대일렉트릭) — "성격별 비용의 기능별 배분" 표는 제외. 당기 표 바로 뒤(표 2개 안)의 "전반기" 표는 제목이 앞 표
    // 뒤에 가려 head 에 없다 — 그 자리면 같은 주석의 전기 표로 본다
    const afterCur = ti - lastCurAt <= 4 && /전(반기|분기|기)/.test(head.slice(-60));
    if ((!/비용의\s*성격별|성격별\s*비용/.test(head) && !afterCur) || /기능별/.test(head.slice(-60))) continue;
    // 당기 표 + 바로 뒤 전기 표(같은 보고서의 전년 동기 — 재작성 판본, XBRL 누적·검증기와 같은 기준). 전기 표는 당기 표 뒤에 이어 실린다
    const per = /당(반기|분기|기)/.test(head.slice(-60)) ? "cur" : /전(반기|분기|기)/.test(head.slice(-60)) ? "prior" : null;
    if (!per) continue;
    const rows = [...m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1])));
    // 값 열 — 머리 줄에 "누적"이 있으면 그 열, 없으면 첫 숫자 열(누적만 공시)
    // 값 열(감사 3차 2026-10-05 — 첫 숫자 열을 쓰면 기능별 배분 표(판관비 | 매출원가 | … | 합계)에서 판관비·재고변동 열을 읽었다: 010120·015760·
    // 103590 TTM 이 틀렸다) — 머리 줄의 **마지막** "누적" 열(합계 쪽), 없으면 마지막 숫자 열(합계). 머리 줄과 자료 줄의 칸 수가 다를 수 있어(빈 머리 칸 —
    // 052690) 오른쪽 끝에서 맞춘다
    // 당기·전기가 한 표에 나란히 있으면(머리 줄에 "전반기"·"전분기"·"전기") 첫 "누적"(당기 쪽) — 033100 2025 반기 "당반기 3개월·누적 | 전반기 3개월·누적"
    const hdr = rows.find((r) => r.some((c) => /누적/.test(c)));
    const twoPeriods = rows.some((r) => !r.slice(1).some((c) => numOf(c) != null) && r.some((c) => /^전(반기|분기|기)/.test(c.replace(/\s/g, ""))));
    const cumAt = hdr ? (twoPeriods ? hdr.findIndex((c) => /누적/.test(c)) : hdr.findLastIndex((c) => /누적/.test(c))) : -1;
    const cumFromEnd = hdr ? hdr.length - 1 - cumAt : -1;
    const valOf = (r) => {
      if (cumFromEnd >= 0) return numOf(r[r.length - 1 - cumFromEnd] ?? "");
      const v = r.slice(1).map((c) => (/^[-–]$/.test(c.trim()) ? 0 : numOf(c))).filter((x) => x != null);
      // "당반기 | 전반기" 두 기간 표(누적 머리 없음 — 229640 2025 반기)는 첫 값(당기). 마지막 값을 쓰면 전반기를 읽는다
      return (twoPeriods ? v[0] : v.at(-1)) ?? null;
    };
    const kind = (r) => {
      const t = lbl(r[0]);
      // "감가상각비와 상각비"(229640 2026 반기 연결 표 — 이 이름을 몰라 그 표를 건너뛰고 별도 표를 읽었다), XBRL 이름 꼴 "감가상각비, 사용권자산"
      if (/^감가상각비(및|와)(무형자산)?상각비$/.test(t)) return "comb";
      if (/^(감가상각비|유형자산(감가)?상각비|감가상각비,유형자산)$/.test(t)) return "base";
      if (/^(투자부동산(감가)?상각비|감가상각비,투자부동산)$/.test(t)) return "inv";
      if (/^(사용권자산(감가)?상각비|감가상각비,사용권자산)$/.test(t)) return "rou";
      if (t === "무형자산상각비") return "amo";
      return null;
    };
    const by = {};
    for (const r of rows) { const k = kind(r); if (k && !(k in by)) by[k] = valOf(r); }
    if (by.comb == null && by.base == null) continue;
    const u = clean(m[0]).match(UNIT_RE)?.[1] ?? head.match(UNIT_RE)?.[1];
    if (!u) continue;
    const total = by.comb ?? (by.base ?? 0) + (by.inv ?? 0) + (by.rou ?? 0) + (by.amo ?? 0);
    // 연결 표 판정 = 표 앞 마지막 주석 제목("35. 비용의 성격별 분류 (연결)")에 "연결" — 제목은 표 바로 앞 작은 표에 있어 head(160자)에 안 들어올 수 있다(012450)
    const titles = [...clean(xml.slice(Math.max(0, m.index - 1500), m.index)).matchAll(/(?:^|\s)\d{1,2}\.\s*[가-힣][^.]{0,40}/g)];
    const con = /연결/.test(titles.at(-1)?.[0] ?? head);
    found.push({ per, con, v: total * UNIT[u], unit: UNIT[u] });
    if (per === "cur") lastCurAt = ti;
  }
  // 연결 표(주석 제목에 "연결")가 있으면 그것, 없으면 첫 표(별도 재무제표 회사) — 예전엔 "연결 표가 먼저"라고 보고 첫 표를 썼는데, 연결 표를 못 읽으면
  // 별도 표를 집었다(229640)
  const curs = found.filter((f) => f.per === "cur");
  const pick = curs.find((f) => f.con) ?? curs[0];
  if (pick) {
    out.cur = pick.v;
    out.unit = pick.unit;
    // 그 당기 표 바로 다음 전기 표(다음 당기 표 전) — 같은 범위(연결·별도)의 전년 동기 누적
    const i = found.indexOf(pick), nx = found[i + 1];
    if (nx?.per === "prior") { out.prior = nx.v; out.priorFromNature = true; }
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
  const res = await dfetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
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
  const res = await dfetch(`${B}/fnlttXbrl.xml?crtfc_key=${DART}&rcept_no=${rcpNo}&reprt_code=${code}`);
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
    // 같은 보고서의 전년 동기 누적(성격별 표의 전기 표 또는 성격별 손익계산서 본표의 전기 누적 열)
    // 성격별 손익계산서 본표 — 같은 보고서에 전년 동기 누적이 있다
    part = { cur: curN.cur, prior: curN.prior };
    how = curN.priorFromNature ? "성격별" : "성격별(손익계산서 본표)";
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

// ── 리스부채 주석(오너 결정 2026-10-05) — 재무상태표 본표에 리스부채 줄이 없는 해는 사업보고서 주석의 리스부채 합계를 총차입금에 넣는다.
//    앱 dart-ev.ts krLeaseFor 가 쓰는 leaseNote(사업연도별)·leasePolicyLatest(분기말 — 회계정책만) 를 만든다.
//    ① 회계정책 문장이 리스부채를 본표 차입금류 줄에 포함한다고 밝히면 included(삼성전자 "'유동성장기부채' 또는 '장기차입금'으로 분류",
//       LG에너지솔루션 "차입금에 포함하여 표시") — 더하지 않음
//    ② 아니면 사업보고서 XBRL 주석의 리스부채 장부금액 — 태그 꼴 후보(LeaseLiabilities 무차원·보고금액 멤버, 유동+비유동, 부채종류 리스 멤버,
//       재무활동부채 조정표 리스 멤버) 중 둘 이상이 정확히 같은 값(동수면 보고금액 묶음) → added
//    ③ 둘 다 못 정하면 unknown(앱 EV 공란). 금액은 그해 보고서 당기말(CFY), 없으면 이듬해 보고서 전기말(PFY) — 2021 이전 보고서 XBRL 은
//       주석 태깅이 없다(실측). 분기말은 회계정책 판정(leasePolicyLatest), 포함이 아니면 분기 보고서 원문 주석 표 칸(leaseQuarter — leaseQuarterOf)
async function fnlttBs(corp, year) {
  for (const fs of ["CFS", "OFS"]) {
    await new Promise((r) => setTimeout(r, 400));
    const j = await jget(`${B}/fnlttSinglAcntAll.json?crtfc_key=${DART}&corp_code=${corp}&bsns_year=${year}&reprt_code=11011&fs_div=${fs}`);
    if (j.status === "013") continue;
    if (j.status !== "000") throw new Error(`fnltt ${year} ${fs} ${j.status} ${j.message ?? ""}`);
    return { rows: (j.list ?? []).filter((r) => r.sj_div === "BS"), fs };
  }
  return null;
}
const isLeaseRow = (r) => /LeaseLiabilities/.test(r.account_id ?? "") || /리스부채/.test((r.account_nm ?? "").replace(/\s/g, ""));
const amt = (v) => { const t = String(v ?? "").trim(); return t === "" || t === "-" ? null : Number(t.replace(/,/g, "")); };
/** 보고서 XBRL 원본에서 리스부채 장부금액(prefix = "CFY2025eFY"·"PFY2024eFY") */
function leaseAmountOf(xml, prefix, sep) {
  const facts = [];
  for (const m of xml.matchAll(/<([\w-]+:\w+)\b[^>]*?contextRef="([^"]+)"[^>]*>(-?\d+(?:\.\d+)?)</g)) {
    if (!(m[2] === prefix || m[2].startsWith(prefix + "_"))) continue;
    let rest = m[2].slice(prefix.length);
    const hasAxis = /ConsolidatedAndSeparateFinancialStatementsAxis/.test(rest);
    if (sep ? /ConsolidatedMember/.test(rest) : /SeparateMember/.test(rest) || (hasAxis && !/ConsolidatedMember/.test(rest))) continue;
    rest = rest.replace(/_?ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_(Consolidated|Separate)Member/, "").replace(/^_/, "");
    facts.push({ c: m[1], d: rest, v: Number(m[3]) });
  }
  const RA = "ifrs-full_CarryingAmountAccumulatedDepreciationAmortisationAndImpairmentAndGrossCarryingAmountAxis_dart_ReportedAmountMember";
  const one = (c, d) => { const vs = facts.filter((f) => f.c === c && f.d === d).map((f) => f.v); return vs.length && vs.every((v) => v === vs[0]) ? vs[0] : null; };
  const cand = {};
  const put = (k, v) => { if (v != null && v > 0) cand[k] = v; };
  put("LeaseLiabilities(무차원)", one("ifrs-full:LeaseLiabilities", ""));
  put("LeaseLiabilities(보고금액)", one("ifrs-full:LeaseLiabilities", RA));
  for (const [k, d] of [["유동+비유동(보고금액)", RA], ["유동+비유동(무차원)", ""]]) {
    const c = one("ifrs-full:CurrentLeaseLiabilities", d), n = one("ifrs-full:NoncurrentLeaseLiabilities", d);
    if (c != null && n != null && c >= 0 && n >= 0) put(k, c + n);
  }
  put("LeaseLiabilities(부채종류=리스)", one("ifrs-full:LeaseLiabilities", "ifrs-full_ClassesOfLiabilitiesAxis_ifrs-full_LeaseLiabilitiesMember"));
  put("재무활동부채(부채종류=리스)", one("ifrs-full:LiabilitiesArisingFromFinancingActivities", "ifrs-full_ClassesOfLiabilitiesAxis_ifrs-full_LeaseLiabilitiesMember"));
  put("기타금융부채(금융부채종류=리스)", one("ifrs-full:OtherFinancialLiabilities", "ifrs-full_ClassesOfFinancialLiabilitiesAxis_ifrs-full_LeaseLiabilitiesMember"));
  {
    const AX = "ifrs-full_LiabilitiesArisingFromFinancingActivitiesAxis_";
    const by = new Map();
    for (const f of facts) if (f.c === "ifrs-full:LiabilitiesArisingFromFinancingActivities" && f.d.startsWith(AX) && /Lease/i.test(f.d) && !/Axis_/.test(f.d.slice(AX.length))) by.set(f.d, [...(by.get(f.d) ?? []), f.v]);
    const ms = [...by].map(([k, vs]) => [k, vs.every((v) => v === vs[0]) ? vs[0] : null]);
    if (ms.length === 1) put("재무활동부채 조정표 리스 멤버", ms[0][1]);
    else if (ms.length === 2 && ms.every(([, v]) => v != null && v >= 0) && ms.filter(([k]) => /(?<!non)current/i.test(k.slice(AX.length))).length === 1)
      put("재무활동부채 조정표 리스 멤버(유동+비유동)", ms[0][1] + ms[1][1]);
  }
  const groups = new Map();
  for (const [k, v] of Object.entries(cand)) groups.set(v, [...(groups.get(v) ?? []), k]);
  const g = [...groups].filter(([, ks]) => ks.length >= 2).sort((a, b) => b[1].length - a[1].length);
  if (g.length && (g.length === 1 || g[0][1].length > g[1][1].length)) return { amount: g[0][0], how: g[0][1].join(" = ") };
  if (g.length > 1) {
    const top = g.filter(([, ks]) => ks.length === g[0][1].length);
    const ra = top.filter(([, ks]) => ks.some((k) => /보고금액/.test(k)));
    if (ra.length === 1) return { amount: ra[0][0], how: `${ra[0][1].join(" = ")} (동수 — 보고금액 묶음)` };
  }
  return { amount: null, how: Object.keys(cand).length ? `후보 불일치·근거 하나 ${JSON.stringify(cand)}` : "리스부채 주석 태그 없음" };
}
/** 원문에서 "리스부채" 가 든 회계정책 문장 → 리스부채를 포함해 표시하는 본표 차입금류 줄 이름들 */
async function leasePolicyOf(rcpNo) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await dfetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
  if (!res.ok) throw new Error(`document ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // 원문 파일이 없는 판본(DART 014 — [첨부정정], 001440 2024)은 문장 없음. 다른 상태는 실패
  const head = strFromU8(buf.slice(0, 300));
  if (/^<\?xml/.test(head) && /<status>014<\/status>/.test(head)) return [];
  const files = unzipSync(buf);
  const Q = "['‘’\"“”]?";
  const re = new RegExp(`리스부채[를는은]?[^.]{0,40}?${Q}([가-힣]*(?:차입금|차입부채|장기부채|사채))${Q}(?:\\s*(?:또는|및|과|와|,)\\s*${Q}([가-힣]*(?:차입금|차입부채|장기부채|사채))${Q})?\\s*(?:에|으로|로)\\s*(?:포함하여\\s*)?(?:분류|표시|포함)`);
  const names = new Set();
  for (const b of Object.values(files)) {
    let x = new TextDecoder("utf-8").decode(b);
    if ((x.match(/�/g) ?? []).length > 50) x = new TextDecoder("euc-kr").decode(b);
    for (const s of clean(x).split(/(?<=[.다])\s/)) {
      if (!s.includes("리스부채") || s.length >= 400) continue;
      const m = re.exec(s);
      if (m) { names.add(m[1]); if (m[2]) names.add(m[2]); }
    }
  }
  return [...names];
}
async function leaseNotes(corp, latest) {
  const years = [];
  for (let y = latest; y >= latest - 5; y -= 1) years.push(y);
  const faceLease = {}; // 해 → 본표 리스부채 줄 값이 있는가
  const sepOf = {};
  for (const ry of [latest, latest - 2, latest - 4]) {
    const r = await fnlttBs(corp, ry);
    if (!r) continue;
    for (const [col, y] of [["thstrm_amount", ry], ["frmtrm_amount", ry - 1], ["bfefrmtrm_amount", ry - 2]]) {
      if (y in faceLease || !r.rows.some((x) => amt(x[col]) != null)) continue;
      faceLease[y] = r.rows.some((x) => isLeaseRow(x) && amt(x[col]) != null);
      sepOf[y] = r.fs === "OFS";
    }
  }
  const rcpMemo = {}, xmlMemo = {}, polMemo = {};
  const rcpsOf = async (ry) => (rcpMemo[ry] ??= await annualRcps(corp, ry));
  const rcpOf = async (ry) => (await rcpsOf(ry))[0] ?? null;
  const xmlOf = async (rcp) => (xmlMemo[rcp] ??= await loadXbrl(rcp));
  // 회계정책 문장은 그 기간 보고서의 모든 판본에서(정정본은 바뀐 부분만 담기도 한다 — 103590 2022)
  const polOf = async (rcp) => {
    if (polMemo[rcp]) return polMemo[rcp];
    const ry = Object.keys(rcpMemo).find((k) => rcpMemo[k].includes(rcp));
    const out = new Set();
    for (const rc of ry ? rcpMemo[ry] : [rcp]) for (const n of await leasePolicyOf(rc)) out.add(n);
    return (polMemo[rcp] = [...out]);
  };
  const faceNames = (rows) => rows.filter((x) => /차입|사채|장기부채/.test((x.account_nm ?? "").replace(/\s/g, ""))).map((x) => x.account_nm.replace(/\s/g, ""));
  // 단위 오류 보고서(2026-10-05 — 079550 2024 사업보고서가 천원 단위 숫자를 decimals="0" KRW 로 태깅: 리스부채 44,977,895, 전기말 49,524,406. 앞뒤
  // 보고서는 같은 해를 44,977,895,000 · 49,524,406,000 으로 — 태그 꼴 넷이 서로 맞아 꼴 일치 검사로는 못 잡는다). 보고서 R(ry) 가 **양쪽 이웃 보고서와
  // 모두**(R(ry) 전기말 vs R(ry-1) 당기말, R(ry) 당기말 vs R(ry+1) 전기말) 정확히 1000^k 배로 갈리면 그 보고서의 리스부채는 쓰지 않는다. 한쪽만 갈리고
  // 다른 쪽이 없으면 어느 보고서가 틀렸는지 못 정하므로 둘 다 그대로(검증기 이웃 해 안전장치가 잡는다)
  const amtAt = async (ry, prefix, y) => { const rc = await rcpOf(ry); return rc ? leaseAmountOf(await xmlOf(rc), prefix, sepOf[y]).amount : null; };
  const k1000 = (a, b) => a != null && b != null && a > 0 && b > 0 && [1e3, 1e6, 1e9].includes(Math.max(a, b) / Math.min(a, b));
  const unitBad = async (ry) => {
    if (ry in unitBad.memo) return unitBad.memo[ry];
    const left = ry - 1 >= latest - 6 && k1000(await amtAt(ry, `PFY${ry - 1}eFY`, ry - 1), await amtAt(ry - 1, `CFY${ry - 1}eFY`, ry - 1));
    const right = ry + 1 <= latest && k1000(await amtAt(ry, `CFY${ry}eFY`, ry), await amtAt(ry + 1, `PFY${ry}eFY`, ry));
    if (left && right) unitBad.why[ry] = "앞뒤 보고서와 같은 해 리스부채가 1000^k 배";
    return (unitBad.memo[ry] = left && right);
  };
  unitBad.memo = {};
  unitBad.why = {};
  const faceDebtOfReport = {};
  const leaseNote = {};
  for (const y of years) {
    if (faceLease[y] !== false) continue; // 본표에 리스 줄이 있거나 그해 재무상태표 없음
    const tried = [];
    let note = null;
    for (const [ry, prefix] of [[y, `CFY${y}eFY`], [y + 1, `PFY${y}eFY`]]) {
      if (ry > latest) continue;
      const rcp = await rcpOf(ry);
      if (!rcp) continue;
      const names = await polOf(rcp);
      // 정책 문장의 줄 이름은 그 보고서 본표의 차입금 줄과 맞춘다(103590: 2022 보고서 "장기차입금", 2024 보고서는 줄 이름을 바꿨다)
      if (names.length && !(ry in faceDebtOfReport)) faceDebtOfReport[ry] = faceNames((await fnlttBs(corp, ry))?.rows ?? []);
      const hit = names.filter((n) => (faceDebtOfReport[ry] ?? []).some((f) => f.includes(n) || n.includes(f)));
      const L = leaseAmountOf(await xmlOf(rcp), prefix, sepOf[y]);
      if (hit.length) { note = { status: "included", amount: L.amount, how: `회계정책 주석: 리스부채를 본표 '${hit.join("'·'")}'에 포함(사업보고서 ${rcp})` }; break; }
      if (L.amount != null && (await unitBad(ry))) { tried.push(`${rcp}: 단위 오류 보고서(${unitBad.why[ry]}) — 건너뜀`); continue; }
      if (L.amount != null) { note = { status: "added", amount: L.amount, how: `사업보고서 ${rcp} XBRL 주석 ${prefix} — ${L.how}` }; break; }
      tried.push(`${rcp}: ${L.how}`);
    }
    leaseNote[y] = note ?? { status: "unknown", amount: null, how: tried.join(" / ") || "사업보고서 없음" };
  }
  // 분기말 회계정책 — 최근 사업보고서(포함이 아니면 아래 leaseQuarterOf 가 분기 보고서 원문 주석으로). 본표에 리스 줄이 있으면 필요 없음
  let leasePolicyLatest = null;
  const latestRcp = await rcpOf(latest);
  if (latestRcp && faceLease[latest] === false) {
    const names = await polOf(latestRcp);
    if (names.length && !(latest in faceDebtOfReport)) faceDebtOfReport[latest] = faceNames((await fnlttBs(corp, latest))?.rows ?? []);
    const hit = names.filter((n) => (faceDebtOfReport[latest] ?? []).some((f) => f.includes(n) || n.includes(f)));
    leasePolicyLatest = hit.length
      ? { status: "included", amount: null, how: `회계정책 주석: 리스부채를 본표 '${hit.join("'·'")}'에 포함(사업보고서 ${latestRcp})` }
      : { status: "unknown", amount: null, how: `최근 사업보고서 ${latestRcp} 회계정책에 차입금 포함 문장 없음` };
  }
  // 분기말 — 회계정책이 포함이 아니면 최신 분기·반기 보고서 원문 주석(leaseQuarterOf)
  const leaseQuarter = leasePolicyLatest?.status === "unknown" ? await leaseQuarterOf(corp, latest, leaseNote[latest], sepOf[latest]) : null;
  return { leaseNote, leasePolicyLatest, leaseQuarter };
}
// ── 분기말 리스부채(오너 결정 2026-10-05) — 최신 분기·반기 보고서 원문 주석. 분기 보고서 XBRL(fnlttXbrl)엔 주석 사실이 없지만 원문(document.xml)
//    주석 표 칸에 태그가 달려 있다(<TE ACODE="ifrs-full_LeaseLiabilities" ACONTEXT="CFY2026eHYA_…" ADECIMAL="-3">172,075,062</TE>, 표 단위 "천원").
//    컨텍스트 접두어: 분기말 CFY{Y}e{FQ|HY|TQ}A, 전기말(직전 사업연도말) PFY{Y-1}e{FQ|HY|TQ}. 같은 표 칸 꼴(개념 + 차원) 하나가 전기말 열과 분기말 열을 다
//    갖고 있으므로, **전기말 값이 최근 사업연도 주석 리스부채(leaseNote, 이미 쓰는 값)와 정확히 같은 꼴만 믿고 그 꼴의 분기말 값을 쓴다**(확인 사슬 ①).
//    그런 꼴이 없으면 같은 해 앞 분기 보고서에서 ①로 확인된 꼴과 같은 꼴(②). 꼴 순위: ① 리스부채 개념(LeaseLiabilities, 차원 무관) ② 금융부채 범주
//    표의 리스부채 멤버 ③ 재무활동 부채 조정표의 리스부채 멤버 ④ 유동 + 비유동 리스부채(같은 차원) — 확인된 꼴 중 가장 앞 순위를 쓰고, 같은 순위
//    안에서 분기말 값이 다르면 정하지 않는다(빈칸 + 기록). 합(④)보다 한 칸 값(①~③)을 앞에 두는 이유: 반올림된 두 칸의 합은 한 칸 합계와 1~2단위
//    다를 수 있다(006400 2026 반기 172,075,062 vs 54,217,278 + 117,857,786 = 172,075,064 천원).
const QP = { 1: "FQ", 2: "HY", 3: "TQ" };
/** 원문 주석 표의 태그 달린 칸 — [{ c, ctx, v }] (v = 표 단위를 곱한 원 단위 값). ADECIMAL 과 표 단위가 어긋나는 칸은 버린다 */
function taggedCells(xml) {
  const out = [];
  for (const m of xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
    const inTab = clean(m[0].slice(0, 2000)).match(UNIT_RE)?.[1];
    const before = [...clean(xml.slice(Math.max(0, m.index - 1500), m.index)).matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
    const u = UNIT[inTab ?? before];
    for (const c of m[0].matchAll(/<TE\b([^>]*)>([^<]*)<\/TE>/g)) {
      const code = /ACODE="([^"]+)"/.exec(c[1])?.[1], ctx = /ACONTEXT="([^"]+)"/.exec(c[1])?.[1], dec = /ADECIMAL="(-?\d+)"/.exec(c[1])?.[1];
      if (!code || !ctx || !/Lease|LiabilitiesArisingFromFinancingActivities|FinancialLiabilities/.test(code + ctx)) continue;
      const n = numOf(c[2].replace(/　/g, "").trim());
      if (n == null || !u) continue;
      if (dec != null && n !== 0 && 10 ** -Number(dec) !== u) continue;
      out.push({ c: code, ctx, v: n * u });
    }
  }
  return out;
}
/** 칸들 → 꼴별 { tier, cur, pfy } (접수본 하나). 같은 꼴에 값이 둘 이상이면 그 열은 null(모호) */
function leaseForms(cells, Y, P, sep) {
  const cur = `CFY${Y}e${P}A`, pfy = `PFY${Y - 1}e${P}`;
  const which = (ctx) => (ctx === cur || ctx.startsWith(cur + "_") ? "cur" : ctx === pfy || ctx.startsWith(pfy + "_") ? "pfy" : null);
  const forms = new Map();
  const put = (key, tier, col, v) => {
    const f = forms.get(key) ?? forms.set(key, { tier, cur: new Set(), pfy: new Set() }).get(key);
    f[col].add(v);
  };
  const parts = new Map(); // 유동·비유동 짝
  for (const { c, ctx, v } of cells) {
    const col = which(ctx);
    if (!col) continue;
    let rest = ctx.slice((col === "cur" ? cur : pfy).length);
    const hasAxis = /ConsolidatedAndSeparateFinancialStatementsAxis/.test(rest);
    if (sep ? /ConsolidatedMember/.test(rest) : /SeparateMember/.test(rest) || (hasAxis && !/ConsolidatedMember/.test(rest))) continue;
    rest = rest.replace(/_?ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_(Consolidated|Separate)Member/, "").replace(/^_/, "");
    // 만기분석·할인 전 총액·현재가치할인·상각누계 칸은 장부금액이 아니다(멤버 이름 그대로 — "…AccumulatedDepreciation…GrossCarryingAmountAxis_dart_
    // ReportedAmountMember"(보고금액, 장부금액 표)를 \w* 로 넘겨 잡아 001440 리스부채 칸을 통째로 버렸었다)
    if (/MaturityAxis|TypesOfRisksAxis|_(?:ifrs-full|dart)_(?:GrossCarryingAmount|PresentValueDiscount|AccumulatedDepreciationAmortisationAndImpairment|AccumulatedImpairment)Member(?:_|$)/.test(`_${rest}`)) continue;
    if (c === "ifrs-full_LeaseLiabilities") put(`리스부채[${rest}]`, 1, col, v);
    else if (/^ifrs-full_(FinancialLiabilities|OtherFinancialLiabilities)$/.test(c) && /_ifrs-full_LeaseLiabilitiesMember$/.test(rest)) put(`금융부채 범주[${rest}]`, 2, col, v);
    else if (c === "ifrs-full_LiabilitiesArisingFromFinancingActivities" && rest === "ifrs-full_LiabilitiesArisingFromFinancingActivitiesAxis_ifrs-full_LeaseLiabilitiesMember") put("재무활동부채 조정표 리스부채", 3, col, v);
    else if (/^ifrs-full_(Current|Noncurrent)LeaseLiabilities$/.test(c)) {
      const k = `${col}|${rest}`;
      const p = parts.get(k) ?? parts.set(k, { cur: new Set(), non: new Set() }).get(k);
      p[/Noncurrent/.test(c) ? "non" : "cur"].add(v);
    }
  }
  for (const [k, p] of parts) {
    const i = k.indexOf("|");
    if (p.cur.size === 1 && p.non.size === 1) put(`유동+비유동[${k.slice(i + 1)}]`, 4, k.slice(0, i), [...p.cur][0] + [...p.non][0]);
  }
  const one = (set) => (set.size === 1 ? [...set][0] : null);
  return new Map([...forms].map(([k, f]) => [k, { tier: f.tier, cur: one(f.cur), pfy: one(f.pfy) }]));
}
/** 원문 전체(파일 이어 붙임). 원문 파일 없는 판본(DART 014)은 "" */
async function interimDocXml(rcpNo) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await dfetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
  if (!res.ok) throw new Error(`document ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const head = strFromU8(buf.slice(0, 300));
  if (/^<\?xml/.test(head) && /<status>014<\/status>/.test(head)) return "";
  const files = unzipSync(buf);
  let all = "";
  for (const b of Object.values(files)) {
    let x = new TextDecoder("utf-8").decode(b);
    if ((x.match(/�/g) ?? []).length > 50) x = new TextDecoder("euc-kr").decode(b);
    all += x;
  }
  return all;
}
/** 분기 재무상태표 본표에 리스부채 줄이 있는가(null = 재무제표 없음) */
async function interimFaceLease(corp, year, code, sep) {
  await new Promise((r) => setTimeout(r, 400));
  const j = await jget(`${B}/fnlttSinglAcntAll.json?crtfc_key=${DART}&corp_code=${corp}&bsns_year=${year}&reprt_code=${code}&fs_div=${sep ? "OFS" : "CFS"}`);
  if (j.status === "013") return null;
  if (j.status !== "000") throw new Error(`fnltt ${year} ${code} ${j.status} ${j.message ?? ""}`);
  return (j.list ?? []).some((r) => r.sj_div === "BS" && isLeaseRow(r) && amt(r.thstrm_amount) != null);
}
async function leaseQuarterOf(corp, fy, annual, sep) {
  const it = await latestInterim(corp, fy);
  if (!it) return null; // 최신 정기보고서가 사업보고서 — LTM = 사업연도
  const label = `${it.year} Q${it.q}`;
  if (await interimFaceLease(corp, it.year, it.code, sep)) return null; // 분기 본표에 리스부채 줄 — 본표가 기준
  if (annual?.status !== "added" || annual.amount == null)
    return { label, status: "unknown", amount: null, how: `FY${fy} 주석 리스부채가 확정되지 않아(${annual?.status ?? "없음"}) 분기 보고서 전기말 열을 확인할 수 없음` };
  // 확인된 꼴 — 같은 해 앞 분기 보고서부터(②용). 접수본은 최신 판본 먼저
  const verified = new Map(); // 꼴 → 확인 근거
  const tried = [];
  const months = { 1: "03", 2: "06", 3: "09" };
  for (let q = 1; q <= it.q; q += 1) {
    const rep = q === it.q ? it : await latestInterim(corp, fy, months[q]);
    if (!rep) continue;
    for (const rc of [...rep.rcps].reverse()) {
      const forms = leaseForms(taggedCells(await interimDocXml(rc)), rep.year, QP[q], sep);
      for (const [k, f] of forms) if (f.pfy === annual.amount && !verified.has(k)) verified.set(k, `${rep.year} ${rep.label}보고서(${rc}) 전기말 열 = FY${fy} 주석 ${annual.amount}`);
      if (q !== it.q) continue;
      const ok = [...forms].filter(([k, f]) => verified.has(k) && f.cur != null && f.cur > 0);
      if (!ok.length) {
        tried.push(`${rc}: 확인된 꼴 없음(${[...forms].map(([k, f]) => `${k} 전기말 ${f.pfy ?? "-"}`).join(", ") || "리스부채 태그 칸 없음"})`);
        continue;
      }
      const best = Math.min(...ok.map(([, f]) => f.tier));
      const top = ok.filter(([, f]) => f.tier === best);
      const vals = [...new Set(top.map(([, f]) => f.cur))];
      if (vals.length !== 1) {
        tried.push(`${rc}: 같은 순위 꼴의 분기말 값 불일치 ${top.map(([k, f]) => `${k}=${f.cur}`).join(", ")}`);
        continue;
      }
      const [k] = top[0];
      return { label, status: "added", amount: vals[0], how: `${it.year} ${it.label}보고서(${rc}) 주석 ${k} 분기말 ${vals[0]} — 꼴 확인: ${verified.get(k)}` };
    }
  }
  return { label, status: "unknown", amount: null, how: tried.join(" / ") || `${it.year} ${it.label}보고서 없음` };
}
async function latestFy(corp) {
  const now = new Date();
  for (const y of [now.getFullYear() - 1, now.getFullYear() - 2]) if ((await annualRcps(corp, y)).length) return y;
  return null;
}
const LEASE_ONLY = process.argv.includes("--lease-only");

/**
 * 감가상각 출처 기준(연결·별도) = 그해 재무제표 기준(감사 1차 2026-10-05 — 060370 2022: 재무제표는 2024 보고서 전전기 열의 연결 재작성값인데
 * 감가상각은 2022 보고서 원문 별도값이었다). 앱 재무제표 기준: 연결 보고서(그해·이듬해·다다음 해) 어디든 그해 손익 값이 있으면 연결, 아니면 별도.
 * 기준이 다른 해는 지운다(빈칸 — 앱은 DART 공시 현금흐름 줄 또는 빈칸, 그림자 채우기 금지)
 */
async function alignBasis(corp, byYear) {
  const cfs = {};
  const cfsRows = async (ry) => {
    if (ry in cfs) return cfs[ry];
    await new Promise((r) => setTimeout(r, 400));
    const j = await jget(`${B}/fnlttSinglAcntAll.json?crtfc_key=${DART}&corp_code=${corp}&bsns_year=${ry}&reprt_code=11011&fs_div=CFS`);
    if (j.status !== "000" && j.status !== "013") throw new Error(`fnltt CFS ${ry} ${j.status} ${j.message ?? ""}`);
    return (cfs[ry] = j.status === "000" ? j.list ?? [] : null);
  };
  const cy = new Date().getFullYear();
  for (const y of Object.keys(byYear).map(Number)) {
    let con = false;
    for (const [ry, col] of [[y, "thstrm_amount"], [y + 1, "frmtrm_amount"], [y + 2, "bfefrmtrm_amount"]]) {
      if (ry >= cy) continue;
      const L = await cfsRows(ry);
      if (L && L.some((r) => (r.sj_div === "IS" || r.sj_div === "CIS") && amt(r[col]) != null)) { con = true; break; }
    }
    const sep = /별도/.test(byYear[y].src ?? "");
    if (sep === con) {
      console.log(`    (${y} 감가상각 출처 ${byYear[y].src} ≠ 재무제표 ${con ? "연결" : "별도"} — 기준이 달라 지움)`);
      delete byYear[y];
    }
  }
  return Object.keys(byYear).length ? byYear : null;
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
let stopAt = null; // 상한·020 으로 멈춘 종목(그 종목부터 미처리)
const failed = []; // 조회·판독 예외가 난 종목(종료코드 1 — 1호기 배치 실패 감시 job-fin-kr-da 로 잡힌다)
let skipped = 0;
for (const sym of symbols) {
  if (QUOTA.stopped) { stopAt = sym; break; }
  const corp = corpOf(sym);
  if (!corp) { console.log(`  ${sym}: corp_code 없음`); failed.push(sym); continue; }
  // 증분 — 마지막 적재 때와 정기공시 최신 접수번호·적재 규칙 판본이 같으면 건너뛴다(DART 요청 = list.json 1건). --full 이면 전부 다시
  let sourceRcepts = null;
  try { sourceRcepts = await latestPeriodicRcepts(corp); } catch (e) { console.log(`  ${sym}: 정기공시 목록 실패 — ${e.message}`); failed.push(sym); continue; }
  if (!FULL && !LEASE_ONLY) {
    const prev = await db.collection(COLL).findOne({ _id: sym }, { projection: { sourceRcepts: 1, rulesVersion: 1 } });
    if (prev?.rulesVersion === KR_DA_RULES_VERSION && prev?.sourceRcepts?.annual === sourceRcepts.annual && prev?.sourceRcepts?.interim === sourceRcepts.interim) {
      console.log(`  ${sym}: 변화 없음(사업 ${sourceRcepts.annual ?? "-"} · 반기/분기 ${sourceRcepts.interim ?? "-"} · 규칙 ${KR_DA_RULES_VERSION}) — 건너뜀`);
      skipped += 1;
      continue;
    }
  }
  // 리스부채 주석 — 실패하면 적재하지 않는다(앱은 미적재 = EV 공란 + 사유)
  let lease = null;
  try {
    const ly = await latestFy(corp);
    if (ly) lease = await leaseNotes(corp, ly);
    if (lease) for (const [y, n] of Object.entries(lease.leaseNote)) console.log(`    리스 ${y}: ${n.status}${n.amount != null ? ` ${t(n.amount)}` : ""} — ${n.how}`);
    if (lease?.leasePolicyLatest) console.log(`    리스 분기말: ${lease.leasePolicyLatest.status} — ${lease.leasePolicyLatest.how}`);
    if (lease?.leaseQuarter) console.log(`    리스 ${lease.leaseQuarter.label}: ${lease.leaseQuarter.status}${lease.leaseQuarter.amount != null ? ` ${t(lease.leaseQuarter.amount)}` : ""} — ${lease.leaseQuarter.how}`);
  } catch (e) { console.log(`    (리스부채 주석 실패: ${e.message})`); failed.push(sym); }
  if (LEASE_ONLY) {
    if (lease && !CHECK && !QUOTA.stopped) await db.collection(COLL).updateOne({ _id: sym }, { $set: { leaseNote: lease.leaseNote, leasePolicyLatest: lease.leasePolicyLatest, leaseQuarter: lease.leaseQuarter, leaseAt: new Date().toISOString() } });
    continue;
  }
  let byYear = null;
  try { byYear = await daByYear(corp); if (byYear) byYear = await alignBasis(corp, byYear); } catch (e) { console.log(`  ${sym}: ${e.message}`); failed.push(sym); }
  if (QUOTA.stopped) { console.log(`  ${sym}: ${QUOTA.stopped.message} — 적재 안 함`); stopAt = sym; break; }
  if (!byYear) { console.log(`  ${sym}: D&A 없음`); continue; }
  const ttm = await ttmDa(corp, byYear).catch((e) => (console.log(`    (TTM 실패: ${e.message})`), null));
  if (ttm) console.log(`    TTM ${ttm.ttmLabel} = ${t(ttm.ttmDepreciation)} (${ttm.ttmSrc})`);
  // 상한·020 으로 중간에 멈춘 종목은 일부 요청이 실패한 결과라 적재하지 않는다
  if (QUOTA.stopped) { console.log(`  ${sym}: ${QUOTA.stopped.message} — 적재 안 함`); stopAt = sym; break; }
  if (!CHECK) await db.collection(COLL).replaceOne(
    { _id: sym },
    { _id: sym, byYear, ...(ttm ?? {}), ...(lease ? { leaseNote: lease.leaseNote, leasePolicyLatest: lease.leasePolicyLatest, leaseQuarter: lease.leaseQuarter } : {}), sourceRcepts, rulesVersion: KR_DA_RULES_VERSION, updatedAt: new Date().toISOString() },
    { upsert: true },
  );
  const yrs = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  const y = yrs[0];
  console.log(`  ${sym}  ${yrs.length}개년 (${yrs.at(-1)}~${y})  ` + yrs.map((k) => `${k}:${byYear[k].src} 감가 ${t(byYear[k].depreciation)}/무형 ${t(byYear[k].amortisation)}`).join("  "));
}
if (QUOTA.stopped) {
  const left = stopAt ? symbols.slice(symbols.indexOf(stopAt)) : [];
  console.log(`
${QUOTA.stopped.message} — 상한 도달, 남은 ${left.length}종목 미처리: ${left.join(" ")}`);
  process.exitCode = 1;
}
const qs = QUOTA.state();
console.log(`DART 하루 요청(적재) ${qs.count}/${qs.cap} — ${qs.day} KST · 건너뜀(변화 없음) ${skipped}종목${FULL ? "(--full)" : ""}`);
if (failed.length) {
  console.log(`실패 ${failed.length}종목: ${[...new Set(failed)].join(" ")}`);
  process.exitCode = 1;
}
await cli.close();
console.log("완료");
