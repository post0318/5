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
import { makeDartDisk } from "./lib/dart-disk-cache.mjs";

// 설정 — 개발 폴더(로컬·2호기)는 .env.local, 운영 1호기 배치는 컨테이너 환경변수(ops/oracle/run-kr-da.sh 가 /opt/macro/jobs.env 로 넣는다).
// 실행할 때 준 환경변수가 .env.local 보다 먼저(KR_DA_COLLECTION·DART_DAILY_CAP_POPULATE 를 명령줄에서 바꿀 수 있게 — 예전 동작)
const ENV_FILE = new URL("../.env.local", import.meta.url);
const env = {
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
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null && v !== "")),
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
const KR_DA_RULES_VERSION = "2026-10-18.5";
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
// DART 요청은 전부 디스크 캐시 계층을 거친다(scripts/lib/dart-disk-cache.mjs — DART_CACHE_DIR 가 있으면 접수번호 판본 디스크 캐시, 정기공시 목록은
// 회사마다 실행당 1회). 네트워크로 나갈 때만 하루 상한을 센다. 1호기는 /opt/macro/dart-cache(앱과 공유), 2호기는 DART_CACHE_DIR 를 .env.local 에
const DISK = makeDartDisk({ key: DART, root: env.DART_CACHE_DIR || null, maxGb: Number(env.DART_CACHE_MAX_GB ?? 2), take: () => QUOTA.take(), check: (h) => QUOTA.check(h) });
const dfetch = (url) => DISK.get(url);
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
  // 정기공시 목록은 회사마다 실행당 1회(디스크 캐시 계층) — 이 판정과 뒤 처리의 목록 조회가 같은 응답을 쓴다
  const { rows: all } = await DISK.periodic(corp);
  const rows = all.map((r) => ({ r, m: /(사업|반기|분기)보고서\s*\(\d{4}\.\d{2}\)/.exec(r.report_nm ?? "") })).filter((x) => x.m);
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
/** ⑤b 머리 하나 근거용 — 예금성·투자성 이름(채권·사채 같은 넓은 낱말은 빼고) / 표 제목 제외 낱말 */
const DEP_INV = /예금|예치금|(단기|장기|장단기|단장기)금융상품|채무상품|국공채|국채|지방채|펀드|수익증권|신탁|저축성보험|양도성|기업어음|전자단기|(?<![A-Za-z])(MMF|CMA)(?![A-Za-z])/;
const TITLE_EXC = /채권|채무|부채|특수관계|연체|사채|대여|보증/;
/** 반올림된 내역 n 개의 합 칸 ↔ 본표 값(표 단위 target) 허용치 — n/2, 단 표 단위 1,000 미만 작은 금액은 0.5(우연 일치 차단). 현금 내역·리스 확인 공통 */
const sumTol = (target, n) => (Math.abs(target) >= 1000 ? n / 2 : 0.5);
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
/** 사업보고서 원문 파일들(디코딩한 글) — 접수번호마다 1회. 원문 파일이 없는 판본(DART 014 — [첨부정정], 001440 2024)은 빈 목록, 다른 상태는 실패 */
const docTextMemo = {};
async function docTexts(rcpNo) {
  if (docTextMemo[rcpNo]) return docTextMemo[rcpNo];
  await new Promise((r) => setTimeout(r, 1000));
  const res = await dfetch(`${B}/document.xml?crtfc_key=${DART}&rcept_no=${rcpNo}`);
  if (!res.ok) throw new Error(`document ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const head = strFromU8(buf.slice(0, 300));
  if (/^<\?xml/.test(head) && /<status>014<\/status>/.test(head)) return (docTextMemo[rcpNo] = []);
  const out = [];
  for (const b of Object.values(unzipSync(buf))) {
    let x = new TextDecoder("utf-8").decode(b);
    if ((x.match(/�/g) ?? []).length > 50) x = new TextDecoder("euc-kr").decode(b);
    out.push(x);
  }
  return (docTextMemo[rcpNo] = out);
}
/** 원문에서 "리스부채" 가 든 회계정책 문장 → 리스부채를 포함해 표시한다고 적은 차입금류 이름들(문장 근거 — 금액 확인은 leaseInFaceTable) */
async function leasePolicyOf(rcpNo) {
  const Q = "['‘’\"“”]?";
  const re = new RegExp(`리스부채[를는은]?[^.]{0,40}?${Q}([가-힣]*(?:차입금|차입부채|장기부채|사채))${Q}(?:\\s*(?:또는|및|과|와|,)\\s*${Q}([가-힣]*(?:차입금|차입부채|장기부채|사채))${Q})?\\s*(?:에|으로|로)\\s*(?:포함하여\\s*)?(?:분류|표시|포함)`);
  const names = new Set();
  for (const x of await docTexts(rcpNo)) {
    for (const s of clean(x).split(/(?<=[.다])\s/)) {
      if (!s.includes("리스부채") || s.length >= 400) continue;
      const m = re.exec(s);
      if (m) { names.add(m[1]); if (m[2]) names.add(m[2]); }
    }
  }
  return [...names];
}
/**
 * 리스부채가 본표 차입금 줄 **금액 안에** 들어 있는가 — 원문 주석 표로 금액 확인(2026-10-18). 회계정책 문장만으로 "포함"을 판정하던 때
 * 298040("연결그룹의 리스부채는 이자부 차입금에 포함됩니다" — 개념어, 본표 차입금 802,441 = 차입금 주석 합계로 리스 없음, 리스는 "기타금융부채(리스부채)")·
 * 103590 2022 보고서("'유동성장기부채' 또는 '장기차입금'으로 분류" 인데 차입금 주석 합계 196,807,960천원 = 본표 차입금 합, 리스 없음)가 리스부채를
 * 빠뜨렸다. 확인 = 표의 한 묶음(소계·합계 줄 바로 앞 줄들 — 앞 소계·제목 줄에서 끊는다)에 리스 줄이 있고, 묶음 합 = 그 소계(표 단위 그대로 정확히)이며,
 * 그 소계 = 그 보고서 당기 본표 차입금 줄 하나 또는 차입금 줄 합(본표 원 단위를 표 단위로 바꿔 묶음 줄 수 n 의 반올림 범위 n/2 단위 안 — 178320
 * 347,612,453천원 = 347,612,452,572원).
 * 실측: 005930(장기차입금 = 은행차입금 2,806,014 + 리스부채 3,673,503 백만원)·373220(유동성차입금 소계에 유동성리스부채 74,784)·178320(유동성대체 소계에
 * 장기리스부채 (10,776,841)) 확인, 298040·103590 은 이런 묶음이 없다.
 */
function leaseInFaceTable(texts, faceVals) {
  const targets = faceVals.filter((v) => v != null && v !== 0);
  if (!targets.length) return null;
  const all = [...targets, targets.reduce((a, v) => a + v, 0)];
  const isTotal = (t) => /(^|[^가-힣])(소\s*계|합\s*계|총\s*계|계)\s*$/.test(t) || /^(소계|합계|계|총계)/.test(t.replace(/\s/g, ""));
  for (const x of texts) {
    for (const m of x.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
      const inTab = clean(m[0].slice(0, 2000)).match(UNIT_RE)?.[1];
      const before = [...clean(x.slice(Math.max(0, m.index - 1500), m.index)).matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
      const u = UNIT[inTab ?? before];
      if (!u) continue;
      // 열마다 따로(오른쪽 끝 기준 — 당기·전기 열). 보고서 ry = y + 1 의 전기 열로 그 해 y 를 확인할 때 전기 열 묶음을 읽어야 한다(감사 2026-10-18 결함 6 —
      // 예전엔 줄의 첫 숫자 칸만 읽어 당기 열로만 확인했다). "-" 칸은 0
      const cellNum = (c) => (c === "-" ? 0 : numOf(c));
      let block = [];
      for (const r of m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)) {
        const cells = [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1]).replace(/　/g, "").trim());
        const i = cells.findIndex((c) => numOf(c) != null);
        const label = (i < 0 ? cells : cells.slice(0, i)).join(" ");
        if (i < 0) { block = []; continue; } // 제목 줄("장기차입금:")
        const vals = cells.slice(i).reverse().map(cellNum); // vals[off] = 오른쪽에서 off 번째 칸
        if (isTotal(label)) {
          for (let off = 0; off < vals.length; off += 1) {
            const v = vals[off];
            if (v == null) continue;
            const blk = block.filter((b) => b.vals[off] != null).map((b) => ({ label: b.label, v: b.vals[off] }));
            const sum = blk.reduce((a, b) => a + b.v, 0);
            const lease = blk.find((b) => /리스/.test(b.label) && b.v !== 0);
            // 본표(원) ↔ 표(표 단위): 표 소계는 반올림한 줄 n 개의 합이라 본표 값을 표 단위로 바꾼 것과 최대 n/2 단위 다를 수 있다(178320 2023 보고서
            // 유동성대체 소계 (249,840,128)천원 = 43,162,668 + 196,564,571 + 10,112,889, 본표 249,840,129,127원 — 1.127 단위). 그 범위만, 표 단위 1,000 미만 금액은
            // 0.5 만(sumTol — 현금 내역과 같은 규칙)
            const face = all.find((f) => Math.abs(Math.abs(f) / u - Math.abs(v)) <= sumTol(f / u, blk.length));
            if (blk.length >= 2 && lease && sum === v && face != null)
              return `주석 표 '${label}' ${v.toLocaleString("en-US")}(단위 ${u}원) = 리스 줄 '${lease.label}' ${lease.v.toLocaleString("en-US")} 포함 묶음 합 = 본표 차입금 ${face.toLocaleString("en-US")}원`;
          }
          block = [];
          continue;
        }
        block.push({ label, vals });
      }
    }
  }
  return null;
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
  const faceDebtRows = (rows) => rows.filter((x) => /차입|사채|장기부채/.test((x.account_nm ?? "").replace(/\s/g, "")) && !/대여|자산/.test(x.account_nm ?? ""));
  const faceNames = (rows) => faceDebtRows(rows).map((x) => x.account_nm.replace(/\s/g, ""));
  // 문장이 "포함"이라 해도 금액으로 확인(leaseInFaceTable) — 그 보고서(모든 판본) 원문 주석 표 vs 그 보고서 본표 차입금 줄의 **그 해(y) 열**(보고서 ry = y 면
  // 당기 열, ry = y + 1 이면 전기 열 frmtrm_amount — 감사 2026-10-18: 예전엔 늘 당기 열이라 전기 연도를 다음 해 금액으로 확인했다). 확인 못 하면 포함으로 보지 않는다
  const confMemo = {};
  const confirmOf = async (ry, rcp, y) => {
    const key = `${rcp}|${y}`;
    if (key in confMemo) return confMemo[key];
    const col = ry === y ? "thstrm_amount" : ry === y + 1 ? "frmtrm_amount" : ry === y + 2 ? "bfefrmtrm_amount" : null;
    if (!col) throw new Error(`confirmOf: 보고서 ${ry} 에 ${y} 열 없음`);
    const r = await fnlttBs(corp, ry);
    const vals = faceDebtRows(r?.rows ?? []).map((x) => amt(x[col]));
    for (const rc of rcpMemo[ry] ?? [rcp]) {
      const hit = leaseInFaceTable(await docTexts(rc), vals);
      if (hit) return (confMemo[key] = `${hit}(${rc}, ${y} 열)`);
    }
    return (confMemo[key] = null);
  };
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
      const conf = hit.length ? await confirmOf(ry, rcp, y) : null;
      if (hit.length && conf) { note = { status: "included", amount: L.amount, how: `회계정책 주석: 리스부채를 본표 '${hit.join("'·'")}'에 포함(사업보고서 ${rcp}) — 금액 확인: ${conf}` }; break; }
      if (hit.length) tried.push(`${rcp}: 회계정책 문장('${hit.join("'·'")}')은 있으나 주석 표로 본표 차입금 금액 안의 리스를 확인 못 함 — 주석 리스부채를 더함`);
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
    const conf = hit.length ? await confirmOf(latest, latestRcp, latest) : null;
    leasePolicyLatest = hit.length && conf
      ? { status: "included", amount: null, how: `회계정책 주석: 리스부채를 본표 '${hit.join("'·'")}'에 포함(사업보고서 ${latestRcp}) — 금액 확인: ${conf}` }
      : { status: "unknown", amount: null, how: hit.length ? `최근 사업보고서 ${latestRcp} 회계정책 문장('${hit.join("'·'")}')은 있으나 주석 표로 본표 차입금 금액 안의 리스를 확인 못 함` : `최근 사업보고서 ${latestRcp} 회계정책에 차입금 포함 문장 없음` };
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
// ── B16 ②b 현금성자산 — "기타(유동)금융자산" 계열 줄의 주석 내역(오너 결정 2026-10-18) ─────────────────────────────────────────────
//    기타금융자산·기타유동금융자산·유동금융자산·기타투자자산(예금·투자성 내역이 섞인 줄)은 그 해 보고서 주석 내역에서 예금성(정기예금·단기금융상품·
//    장단기금융상품·예치금·채무상품, 사용제한 예금·동반성장예탁금 포함) + 투자성(펀드·MMF·국공채·채권·특정금전신탁·저축성보험)만 현금성자산에 넣고
//    대여금·보증금·미수금·파생상품·확정계약자산은 뺀다. 내역을 못 읽거나(000660 — 유동분 내역 미공시) 성격을 못 정하는 내역이 있으면 그 해 그 줄은
//    제외 + 사유(근사 금지). 앱(dart-ev.ts)은 이 적재본(cashNote·cashQuarter)만 읽는다
const CASH_FAMILY = /^(기타금융자산|기타유동금융자산|유동금융자산|기타투자자산|유동기타금융자산|기타유동투자자산)$/;
// 기타포괄손익-공정가치 금융자산은 지분상품 지정이 대부분이라 제외(298040 2021 유동 12백만원 — 판단, 보고에 적음)
const CASH_EXC = /대여|보증금|미수|파생|확정계약|선급|대출|매출채권|리스채권|지분증권|주식|출자|임차|수취채권|기타채권|미청구|대손|선물환|통화스왑|기타포괄손익/;
// 영문 약어는 낱말 경계로(대소문자 무시로 "Corporation" 의 rp 가 걸렸다 — 298040 2021)
// "금융상품"은 단기·장기·장단기 접두어가 붙은 예금성 이름만(감사 2026-10-18 — "상각후원가 측정금융상품"·"금융상품" 같은 범주·총칭 이름이 걸려 칸 이름만으로
// 줄 전체가 포함됐다, 033100 2025·2026 Q2). 가운뎃점(ㆍ·)은 cashKindOf 가 지운 뒤 본다("단ㆍ장기금융상품" → "단장기금융상품")
const CASH_INC = /예금|예치금|(단기|장기|장단기|단장기)금융상품|채무상품|사용제한|동반성장|국공채|국채|공채|지방채|채권|사채|유가증권|펀드|수익증권|신탁|저축성보험|양도성|환매조건|기업어음|전자단기|(?<![A-Za-z])(MMF|CMA|RP|CD)(?![A-Za-z])/;
/** 내역이 아니라 측정·기간 구분 열·줄(총장부금액·손상·기초/기말·만기 구간 등) — 이런 이름이 하나라도 있는 묶음은 내역으로 보지 않는다 */
const NOT_CONTENT = /총장부금액|손상차손|대손충당금|현재가치할인|원본금액|^장부금액|공정가치서열|수준\d|^당기(말)?$|^전기(말)?$|^당(반)?기말?$|제\d+기|^유동$|^비유동$|기초|기말|취득|처분|평가|\d+년|이내|이상|초과|미만|합계|소계/;
/**
 * 세로 내역(줄)의 범주 이름 — 본표에 따로 있으면 B16 이 현금성자산으로 넣는 항목(유동 상각후원가·당기손익-공정가치 금융자산)과 같은 이름. 내역 표에서
 * 대여금·미수금 등과 **다른 줄로** 나뉘어 있을 때만 포함(042660 2022 단기상각후원가측정금융자산 16,150,000, 051600 유동상각후원가측정금융자산 — 국공채).
 * 열(범주별 표의 열 머리)로 나온 범주는 대여금이 섞인 합이라(052690 상각후원가측정금융자산 열) 이 규칙을 쓰지 않는다
 */
const ROW_CATEGORY_INC = /^(유동|단기)?(당기손익-?공정가치측정|상각후원가(로)?측정(하는)?)(유동)?금융자산$/;
/** 내역 이름 → "inc" | "exc" | null(못 정함). vertical = 세로 내역 줄 */
function cashKindOf(label, vertical = false) {
  const t = label.replace(/\s|&cr;|[ㆍ·・]/g, "");
  if (CASH_EXC.test(t)) return "exc";
  if (CASH_INC.test(t)) return "inc";
  if (vertical && ROW_CATEGORY_INC.test(t.replace(/^[―\-–·ㆍ]+/, "").replace(/^유동금융자산/, ""))) return "inc";
  return null;
}
/** 금융자산 내역 이름처럼 보이는가(④ 연속 줄 묶음의 줄 이름 조건 — 부채·비용 표의 우연한 합을 막는다) */
const FIN_ASSET_NAME = /금융|예금|예치|대여|채권|미수|보증금|파생|상품|증권|신탁|펀드|국공채|사채|MMF|확정계약/;
const isTotalLabel = (t) => /(합\s*계|소\s*계|총\s*계|^계$|\s계$)/.test(t.trim());
/** 원문 표 → [{ u, rows: [[칸 글자]] }] (표 단위를 못 읽으면 뺀다) */
/**
 * 원문 범위(연결·별도) — 첨부 문서 종류(DOCUMENT-NAME: 연결감사보고서 = 연결, 감사보고서 = 별도), 정기보고서 본문은 표 앞 마지막 재무제표 제목
 * ("2. 연결재무제표"·"3. 연결재무제표 주석"·"5. 재무제표 주석", 주석 소제목 "… (연결)"). 못 정하면 null
 */
function scopeIndex(x) {
  const dn = /<DOCUMENT-NAME[^>]*>([^<]*)</.exec(x)?.[1] ?? "";
  if (/연결\s*(감사|검토)보고서/.test(dn)) return () => "con";
  if (/(감사|검토)보고서/.test(dn)) return () => "sep";
  const marks = [];
  for (const m of x.matchAll(/<TITLE[^>]*>([^<]*)<\/TITLE>/g)) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (/\(연결\)\s*$/.test(t) || /^\d+(-\d+)?\.\s*연결\s*재무제표(\s*주석)?$/.test(t)) marks.push([m.index, "con"]);
    else if (/^\d+(-\d+)?\.\s*재무제표(\s*주석)?$/.test(t)) marks.push([m.index, "sep"]);
  }
  return (pos) => { let s = null; for (const [i, k] of marks) { if (i > pos) break; s = k; } return s; };
}
/** 표 앞 글자에서 표 제목 — 마지막 문장 끝 뒤 글자(없으면 마지막 문장). 앞 문단의 낱말(“…보증금에 포함…”)이 섞이지 않게 */
const titleOf = (b) => { const ps = b.split(/(?<=다\.|\)\.|다\))\s*/); const last = ps.at(-1).trim(); return last || (ps.at(-2) ?? "").trim(); };
/** 원문 표 → [{ u, rows: [[칸 글자]], rowsX(병합 칸을 펼친 줄), scope, title, face }] (표 단위를 못 읽으면 뺀다) */
function tablesOf(texts) {
  const out = [];
  for (const x of texts) {
    const scopeAt = scopeIndex(x);
    for (const m of x.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
      const inTab = clean(m[0].slice(0, 2000)).match(UNIT_RE)?.[1];
      const before = [...clean(x.slice(Math.max(0, m.index - 1500), m.index)).matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
      const u = UNIT[inTab ?? before];
      if (!u) continue;
      const trs = [...m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU]([^>]*)>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => ({ t: clean(c[2]).replace(/　/g, "").trim(), span: Number(/COLSPAN="(\d+)"/i.exec(c[1])?.[1] ?? 1) })));
      out.push({
        u,
        face: /자산\s*총\s*계/.test(clean(m[0])),
        scope: scopeAt(m.index),
        // title = 표 바로 앞 제목(주석 제목·"…의 내역 당기 (단위 : 원)") — ⑤b·⑦ 이 금융자산 내역 표인지 볼 때 쓴다
        title: titleOf(clean(x.slice(Math.max(0, m.index - 600), m.index)).slice(-200)),
        rows: trs.map((r) => r.map((c) => c.t)),
        rowsX: trs.map((r) => r.flatMap((c) => Array(Math.min(c.span, 40)).fill(c.t))),
      });
    }
  }
  return out;
}
const cellVal = (c) => (c === "-" ? 0 : c == null ? null : numOf(c));
const cellAt = (row, off) => (off < row.length ? row[row.length - 1 - off] : undefined);
const rowLabel = (row) => { const i = row.findIndex((c) => cellVal(c) != null); return (i < 0 ? row : row.slice(0, i)).filter(Boolean).join(" "); };
const rowLastText = (row) => { const i = row.findIndex((c) => cellVal(c) != null); return (i < 0 ? row : row.slice(0, i)).filter(Boolean).at(-1) ?? ""; };
/** 칸의 열 머리 — 가장 가까운 앞 줄의 같은 자리(오른쪽 기준) 글자 */
const colHead = (rows, r, off) => { for (let q = r - 1; q >= 0; q -= 1) { const h = cellAt(rows[q], off); if (h != null && h !== "" && cellVal(h) == null) return h; } return null; };
/** 조정 줄(대손충당금·현재가치할인차금·손상차손) — 소계 묶음의 성격은 이 줄을 뺀 줄들로 정한다 */
const ADJ_ROW = /대손충당금|현재가치할인|손상차손/;
/**
 * rows[q] 의 "소계" 칸 S(같은 열 off) = 바로 위 줄들의 합인 묶음 — { label, kind, why, top }(top = 묶음 맨 위 줄 번호). 위 줄을 소계·합계·빈 칸 전까지 읽어
 * 합이 S 와 정확히 같은 첫 묶음. 성격 = 조정 줄을 뺀 줄들이 모두 같은 성격일 때 그 성격(섞이면 대손충당금 등을 나눌 수 없어 못 정함 → null)
 */
function subtotalGroup(rows, q, off, S) {
  const mem = [];
  let sum = 0;
  for (let i = q - 1; i >= 0; i -= 1) {
    const v = cellVal(cellAt(rows[i], off));
    if (v == null || isTotalLabel(rowLastText(rows[i]))) break;
    mem.push({ label: rowLastText(rows[i]), v });
    sum += v;
    if (sum !== S) continue;
    const core = mem.filter((m) => !ADJ_ROW.test(m.label.replace(/\s/g, "")));
    const kinds = new Set(core.map((m) => cashKindOf(m.label, true)));
    if (!core.length || kinds.size !== 1 || kinds.has(null)) return null;
    const kind = [...kinds][0];
    const names = mem.map((m) => `${m.label} ${m.v.toLocaleString("en-US")}`).reverse().join(" · ");
    return { label: `소계(${names})`, kind, why: `소계 묶음 ${names} — ${kind === "inc" ? "포함" : "제외"}`, top: i };
  }
  return null;
}
/**
 * 오른쪽 기준 열 머리가 없을 때(합계 열 머리가 여러 줄을 묶어 머리 줄 칸 수가 모자람 — 052690 2026 반기 「당기손익-공정가치측정금융자산의 공시」 머리
 * '특정금전신탁 | … | 다빈치스카이(주)' 아래 '기말 | 45,648,065 | … | 47,412,768') 왼쪽 기준 같은 자리 글자. 줄 이름 칸 수가 머리와 같을 때만 맞으므로
 * 오른쪽 기준(colHead)이 아무것도 못 찾았을 때만 쓴다
 */
const colHeadLeft = (rows, r, idx) => {
  const lead = rows[r].findIndex((c) => cellVal(c) != null);
  for (let q = r - 1; q >= 0; q -= 1) {
    if (rows[q].some((c) => cellVal(c) != null)) continue;
    if (rows[q].findIndex((c, i) => i > 0 && c) !== lead) continue; // 머리 줄의 첫 글자 칸 = 숫자 줄의 첫 숫자 칸 자리일 때만
    // 칸 수 확인(재감사 2026-10-18 — 병합 칸 어긋남 방지): 머리 칸 수 = 숫자 칸 수, 또는 하나 적고 그 위 머리 줄의 마지막 칸이 "합계"(합계 열 머리가 위 줄에서
    // 여러 줄을 묶음 — 052690)일 때만. 그 밖은 쓰지 않는다
    const nh = rows[q].length - lead, nv = rows[r].length - lead;
    const upTotal = rows.slice(0, q).some((x) => !x.some((c) => cellVal(c) != null) && /합\s*계/.test(x.filter(Boolean).at(-1) ?? ""));
    if (!(nh === nv || (nh === nv - 1 && upTotal))) return null;
    if (idx >= rows[q].length) return null;
    const h = rows[q][idx];
    if (h != null && h !== "") return h;
  }
  return null;
};
/**
 * 원문 표에서 X(원)를 이루는 내역 묶음 — 표 칸을 오른쪽 끝 기준으로 맞춘다(첫 칸이 여러 줄을 묶은 표 — 001440). 꼴:
 *  ① X 칸 위쪽 줄들(같은 열) ② X 칸 아래쪽 줄들(같은 열 — 009150 "기타유동자산 합계" 뒤 내역) ③ X 칸 같은 줄 왼쪽 칸들(열 머리가 내역 이름 — 006400)
 *  ④ X 칸이 없는 표의 같은 열 연속 줄들(051600 범주별 표 — 상각후원가 115,650,000 + 단기대여금 + 단기금융상품 = 기타유동금융자산)
 * 내역 합이 표의 합계 칸과 정확히 같고(①~③), 합계 칸(④는 내역 합) = X 를 표 단위로 바꾼 값(내역 k 개 반올림 범위 k/2 안).
 * 측정·기간 구분 이름(총장부금액·손상·기초/기말·만기 구간)이 섞인 묶음은 내역이 아니다. 결과 [{ parts: [{label, v}], u, how }]
 */
function cashBreakdowns(tables, X) {
  const out = [];
  // 소계 묶음(gk — 아래 ①의 소계 줄)은 그 묶음 줄들로 이미 성격을 정했다
  // 내역 줄 중 하나 이상은 금융자산 내역 이름이어야 한다(감사 2026-10-18 후속 — 373220 2024 X 42 백만원에 특수관계자 채권 표 '기타 15 · 엘지디스플레이 8 · LG화학 19'
  // 가 우연히 맞았다)
  const content = (parts) => parts.length >= 1 && parts.every((p) => p.gk || (p.label && !NOT_CONTENT.test((p.last ?? p.label).replace(/\s/g, "")))) && parts.some((p) => p.gk || (p.v !== 0 && FIN_ASSET_NAME.test(p.label)));
  for (const { u, rows, title } of tables) {
    const target = X / u;
    const anchors = new Set();
    for (let r = 0; r < rows.length; r += 1) {
      for (let off = 0; off < rows[r].length; off += 1) {
        const T = cellVal(cellAt(rows[r], off));
        if (T == null || T <= 0 || Math.abs(T - target) > 6) continue;
        anchors.add(off);
        const tries = [];
        for (const dir of [-1, 1]) {
          const parts = [];
          for (let q = r + dir; q >= 0 && q < rows.length; q += dir) {
            const v = cellVal(cellAt(rows[q], off));
            if (v == null) break;
            if (isTotalLabel(rowLastText(rows[q]))) {
              // 위로 읽다 만난 "소계" 줄 = 그 위 줄들의 묶음(감사 2026-10-18 — 015760 「13. 기타금융자산」 합계 798,819 = 소계 132,061(대여금 132,890 ·
              // 대손충당금 (13) · 현재가치할인차금 (816)) + 장단기금융상품 666,758 백만원. 예전엔 소계 줄에서 읽기를 멈춰 내역을 못 읽었다)
              const g = dir < 0 && /소\s*계/.test(rowLastText(rows[q])) ? subtotalGroup(rows, q, off, v) : null;
              if (!g) break;
              parts.push({ label: g.label, last: g.label, v, vertical: true, gk: g.kind, gwhy: g.why });
              q = g.top;
              continue;
            }
            parts.push({ label: rowLabel(rows[q]), last: rowLastText(rows[q]), v, vertical: true });
          }
          tries.push([dir < 0 ? "위" : "아래", parts]);
        }
        {
          const parts = [];
          for (let o = off + 1; o < rows[r].length; o += 1) {
            const v = cellVal(cellAt(rows[r], o));
            if (v == null) break;
            parts.push({ label: colHead(rows, r, o) ?? "", v });
          }
          tries.push(["같은 줄", parts]);
        }
        // ⑤ X 칸 자체가 성격이 드러난 이름을 가진 경우(042660 2023 "기타금융유동자산(단기금융상품) 124,948", 2025 "정기예금 등 10,204" 백만원)
        for (const nm of [rowLastText(rows[r]), colHead(rows, r, off) ?? ""])
          if (nm && Math.abs(T - target) <= 0.5 && cashKindOf(nm) === "inc" && !NOT_CONTENT.test(nm.replace(/\s/g, ""))) out.push({ parts: [{ label: nm, v: T }], u, how: `주석 표 칸 이름 '${nm}' ${T.toLocaleString("en-US")}(단위 ${u}원)` });
        // ⑤b 표 머리의 한 칸짜리 줄(XBRL 축 멤버 — 033100 「상각후원가측정금융자산의 내역」 머리 '단기금융상품', 줄 '상각후원가측정금융자산(유동)')이 성격을
        // 밝히는 경우. 머리 하나만 근거로 삼으므로 좁게(재감사 2026-10-18 — 047810 연체 분석 표 'A.연체되지 않은 채권' 아래 대여금·보증금, 특수관계자 채권·채무
        // 표, 사채 부채 표가 걸렸다): ① 표 제목이 금융자산·금융상품 내역 표이고 채권·채무·부채·특수관계·연체·사채·대여·보증 낱말이 없음 ② 머리가 예금성·투자성
        // 이름(DEP_INV, 제외 낱말 없음) ③ X 칸 줄 이름이 금융자산 이름이고 제외 성격 아님 ④ X 칸 열 머리가 제외 성격 아님 ⑤ 그런 머리 줄이 정확히 하나
        const xr = rowLastText(rows[r]);
        if (Math.abs(T - target) <= 0.5 && FIN_ASSET_NAME.test(xr) && cashKindOf(xr) !== "exc" && cashKindOf(colHead(rows, r, off) ?? "") !== "exc"
          && /금융자산|금융상품/.test(title ?? "") && !TITLE_EXC.test(title ?? "")) {
          const heads = [];
          // 표 머리 = 첫 숫자 줄 앞 줄들만(본문 중간의 "채무상품:" 같은 구획 제목 줄은 머리가 아니다 — 001440 2021 보고서)
          for (let q = 0; q < r; q += 1) {
            if (rows[q].some((c) => cellVal(c) != null)) break;
            const ne = rows[q].filter((c) => c && c.trim());
            if (ne.length !== 1 || /[:：]\s*$/.test(ne[0]) || NOT_CONTENT.test(ne[0].replace(/\s/g, ""))) continue;
            const k = cashKindOf(ne[0]);
            if (k) heads.push([ne[0], k]);
          }
          if (heads.length === 1 && heads[0][1] === "inc" && DEP_INV.test(heads[0][0].replace(/\s|[ㆍ·・]/g, ""))) out.push({ parts: [{ label: heads[0][0], v: T }], u, how: `주석 표 머리 '${heads[0][0]}' 아래 '${rowLastText(rows[r])}' ${T.toLocaleString("en-US")}(단위 ${u}원)` });
        }
        for (const [kind, parts] of tries) {
          let sum = 0, hit = false;
          for (let k = 0; k < parts.length; k += 1) {
            sum += parts[k].v;
            // 합계 칸 T 는 반올림된 내역 k 개의 합이라 본표 값(표 단위)과 k/2 까지 다를 수 있다(047810 2023 0.556 단위·009150 2026 반기 1.664 단위 — 정상).
            // 다만 표 단위로 1,000 미만인 작은 금액은 우연 일치가 많아 0.5 만(재감사 2026-10-18 — 373220 2024 X 42 백만원에 관계기업 표 38, 000660 2021 X 30 에
            // 임원 보수 표 31). 리스 쪽 leaseInFaceTable 도 같은 규칙(sumTol)
            if (sum === T && Math.abs(Math.abs(T) - target) <= sumTol(target, k + 1) && content(parts.slice(0, k + 1))) {
              out.push({ parts: parts.slice(0, k + 1), u, how: `주석 표 ${kind} 내역 ${k + 1}개 합 ${T.toLocaleString("en-US")}(단위 ${u}원)` });
              hit = true;
              break;
            }
          }
          // 이어진 줄로는 안 맞으면 위쪽 줄 중 2~4개 조합(정확히 하나일 때만 — 015760 "기타유동금융자산 2,093,242" = 단기대여금 95,598 + 유동 장단기
          // 금융상품 1,997,644, 사이에 장기대여금 줄)
          if (!hit && kind === "위" && parts.length >= 2 && parts.length <= 12) {
            const subs = [];
            for (let mk = 1; mk < 1 << parts.length; mk += 1) {
              const pick = parts.filter((_, i) => mk & (1 << i));
              if (pick.length < 2 || pick.length > 4) continue;
              if (pick.reduce((a, x) => a + x.v, 0) === T && Math.abs(T - target) <= sumTol(target, pick.length) && content(pick)) subs.push(pick);
            }
            if (subs.length === 1) out.push({ parts: subs[0], u, how: `주석 표 위 내역 중 ${subs[0].length}개 조합 합 ${T.toLocaleString("en-US")}(단위 ${u}원)` });
          }
        }
      }
    }
    // ⑧ 묶음 머리 + 범주 열(079550 2023 사업보고서 「금융자산의 범주별 공시」: '기타금융자산 | 53,367,379 | 0 | 2,320,467' 아래 '단기금융상품 20,040,000 ·
    // 단기대여금 · 단기미수금 · … · 유동파생상품자산 0 | 0 | 2,320,467' 천원 — 줄 값이 범주 열(상각후원가·기타포괄·당기손익)에 나뉨). 묶음 머리 줄의 열 합 = X(내역 수/2,
    // 작은 금액 0.5)이고, 바로 아래 줄들의 **열마다 합이 머리 줄의 그 열 값과 정확히 같아지는** 첫 묶음(2줄 이상)일 때만. 내역 금액 = 그 줄의 열 합
    for (let r = 0; r < rows.length; r += 1) {
      const lead = rows[r].findIndex((c) => cellVal(c) != null);
      if (lead < 0) continue;
      const gv = rows[r].slice(lead).map(cellVal);
      const glab = rowLastText(rows[r]);
      if (gv.length < 2 || gv.some((v) => v == null) || isTotalLabel(glab) || !FIN_ASSET_NAME.test(glab)) continue;
      const T = gv.reduce((a, v) => a + v, 0);
      if (T <= 0 || Math.abs(T - target) > sumTol(target, Math.max(1, gv.filter((v) => v !== 0).length))) continue;
      const acc = gv.map(() => 0);
      const parts = [];
      for (let q = r + 1; q < rows.length && parts.length < 20; q += 1) {
        const l2 = rows[q].findIndex((c) => cellVal(c) != null);
        if (l2 < 0) break;
        const v2 = rows[q].slice(l2).map(cellVal);
        const lab = rowLastText(rows[q]);
        if (v2.length !== gv.length || v2.some((v) => v == null) || isTotalLabel(lab)) break;
        v2.forEach((v, i) => (acc[i] += v));
        parts.push({ label: lab, last: lab, v: v2.reduce((a, v) => a + v, 0), vertical: true });
        if (acc.every((a, i) => a === gv[i])) {
          if (parts.length >= 2 && content(parts)) out.push({ parts: [...parts], u, how: `주석 표 묶음 머리 '${glab}' 아래 내역 ${parts.length}개(범주 열 ${gv.length}개마다 합 일치) 합 ${T.toLocaleString("en-US")}(단위 ${u}원)` });
          break;
        }
      }
    }
    // ④ X 칸이 없는 열 — 연속 줄 2~8개
    const width = Math.max(0, ...rows.map((r) => r.length));
    for (let off = 0; off < width && target >= 1000; off += 1) {
      if (anchors.has(off)) continue;
      for (let r0 = 0; r0 < rows.length; r0 += 1) {
        let sum = 0;
        const parts = [];
        for (let q = r0; q < rows.length && parts.length < 8; q += 1) {
          const v = cellVal(cellAt(rows[q], off));
          if (v == null || isTotalLabel(rowLastText(rows[q])) || !FIN_ASSET_NAME.test(rowLastText(rows[q]))) break;
          parts.push({ label: rowLabel(rows[q]), last: rowLastText(rows[q]), v, vertical: true });
          sum += v;
          if (parts.length >= 2 && (u === 1 ? sum === target : Math.abs(sum - target) <= parts.length / 2) && content(parts)) {
            out.push({ parts: [...parts], u, how: `주석 표 같은 열 연속 내역 ${parts.length}개 합 ${sum.toLocaleString("en-US")}(단위 ${u}원)` });
            break;
          }
        }
      }
    }
  }
  return out;
}
/** 이름으로 성격을 못 정한 내역(예: "당기손익-공정가치측정금융자산") — 같은 금액 칸이 성격이 드러난 이름(줄 이름·열 머리)으로 다른 표에 있으면 그 성격 */
function kindByAmount(tables, v, u) {
  const kinds = new Set();
  if (Math.abs(v) < 1000) return null; // 작은 금액은 우연히 같은 칸이 많다
  const seen = [];
  for (const t of tables)
    for (let r = 0; r < t.rows.length; r += 1)
      for (let off = 0; off < t.rows[r].length; off += 1) {
        const c = cellVal(cellAt(t.rows[r], off));
        if (c == null || Math.abs(c) * t.u !== Math.abs(v) * u) continue; // 부호 무관(순차입금 표의 (단기금융상품) — 006400)
        const ch = colHead(t.rows, r, off);
        const left = ch == null ? colHeadLeft(t.rows, r, t.rows[r].length - 1 - off) : null;
        for (const [nm, tag] of [[rowLastText(t.rows[r]), ""], [ch ?? left ?? "", left ? "·왼쪽 기준 머리" : ""]]) {
          const k = nm && FIN_ASSET_NAME.test(nm) ? cashKindOf(nm) : null;
          if (k) { kinds.add(k); seen.push(`${nm}(${k === "inc" ? "포함" : "제외"}${tag})`); }
        }
      }
  return kinds.size === 1 ? { kind: [...kinds][0], why: `같은 금액 칸 ${[...new Set(seen)].slice(0, 3).join("·")}` } : null;
}
/**
 * 표들에서 X(원)의 현금성 부분 — { cash, how } (못 정하면 cash null). 내역이 전부 포함이면 X 그대로, 전부 제외면 0, 섞이면 포함 내역 합(표 단위).
 * 이름으로 성격을 못 정한 내역은 ① 같은 금액 칸의 다른 이름(kindByAmount) ② 그 금액의 내역 표(한 단계 더 — 298040 범주별 표의 상각후원가 금액)
 */
function cashPartOfTables(tables, X, line, depth = 0, ctx = null) {
  const found = [];
  for (const rc of [...new Set(tables.map((t) => t.rc))]) for (const b of cashBreakdowns(tables.filter((t) => t.rc === rc), X)) found.push({ ...b, rc });
  if (!found.length) return notFound(tables, X, line, depth, ctx);
  const res = [];
  for (const f of found) {
    // 내역 한 줄 = 합계와 같은 금액을 범주 이름으로 다시 적은 것뿐이면(001440 2020 "당기손익-공정가치측정금융자산 33,496") 내역이 아니다 — 이름 자체가 성격을
    // 밝힐 때만(033100 "상각후원가측정금융자산 장단기금융상품")
    if (f.parts.filter((p) => p.v !== 0).length === 1 && !cashKindOf(f.parts.find((p) => p.v !== 0).label)) continue;
    const nz = f.parts.filter((p) => p.v !== 0).map((p) => {
      if (p.gk) return { ...p, k: p.gk, amt: p.gk === "inc" ? p.v * f.u : 0, why: "" };
      const k = cashKindOf(p.label, p.vertical);
      if (k) return { ...p, k, amt: k === "inc" ? p.v * f.u : 0, why: "" };
      const b = kindByAmount(tables, p.v, f.u);
      if (b) return { ...p, k: b.kind, amt: b.kind === "inc" ? p.v * f.u : 0, why: ` — ${b.why}` };
      if (depth === 0 && Math.abs(p.v) >= 1000) {
        const sub = cashPartOfTables(tables, p.v * f.u, p.label, 1);
        if (sub.cash != null) return { ...p, k: sub.cash === 0 ? "exc" : "mix", amt: sub.cash, why: ` — 내역의 내역: ${sub.how}` };
      }
      return { ...p, k: null, amt: null, why: "" };
    });
    const unk = nz.filter((p) => p.k == null);
    const tag = (p) => (p.k === "inc" ? "(포함" : p.k === "exc" ? "(제외" : p.k === "mix" ? `(일부 ${p.amt.toLocaleString("en-US")}` : "(성격 미상") + p.why + ")";
    const desc = nz.map((p) => `${p.label} ${p.v.toLocaleString("en-US")}${tag(p)}`).join(", ");
    if (unk.length) { res.push({ cash: null, reason: "unknown-kind", u: f.u, n: f.parts.length, how: `${line} 주석 내역 중 성격을 못 정한 항목(${unk.map((p) => p.label).join("·")}) — ${f.how}: ${desc} (${f.rc}) → 제외` }); continue; }
    const cash = nz.every((p) => p.k === "inc") ? X : nz.every((p) => p.k === "exc") ? 0 : nz.reduce((a, p) => a + p.amt, 0);
    res.push({ cash, u: f.u, n: f.parts.length, how: `${line} 주석 내역(${f.rc}) ${f.how}: ${desc}${cash === X ? " → 줄 전체" : ""}` });
  }
  if (!res.length) return notFound(tables, X, line, depth, ctx);
  const ok = res.filter((r) => r.cash != null);
  if (!ok.length) return { cash: null, reason: res[0].reason ?? "unknown-kind", how: res[0].how };
  // 가장 작은 단위 표들이 한 값으로 모이고, 다른 표 값은 그 표 단위 반올림 범위(내역 수 × 단위) 안이면 그 값. 같은 단위끼리 내역 반올림만 다르면
  // (064350 2024 272,625,444 vs 272,625,445 천원) 그 해 보고서(첫 접수본) 첫 표 값
  const minU = Math.min(...ok.map((r) => r.u));
  const fine = ok.filter((r) => r.u === minU);
  const fv = [...new Set(fine.map((r) => r.cash))];
  const within = (r, v) => Math.abs(r.cash - v) <= r.u * r.n;
  const pick = fv.length === 1 ? fine[0] : fine.every((r) => within(r, fine[0].cash)) ? fine[0] : null;
  if (pick && ok.every((r) => within(r, pick.cash))) {
    const others = res.filter((r) => r !== pick);
    const spread = Math.max(...ok.map((r) => Math.abs(r.cash - pick.cash)));
    return { cash: pick.cash, how: `${pick.how}${spread ? ` (다른 표와 반올림 차 최대 ${spread.toLocaleString("en-US")}원 — 가장 작은 단위·첫 표 값)` : ""}${others.some((r) => r.cash == null) ? ` (판독 못 한 표 ${others.filter((r) => r.cash == null).length}개)` : ""}` };
  }
  return { cash: null, reason: "inconsistent", how: `${line} 주석 표마다 현금성 부분이 다름(${[...new Set(ok.map((r) => r.cash))].join("·")}) → 제외` };
}
/**
 * ⑥(진단 전용 — 포함 근거로 쓰지 않음) 한 보고서 안 서로 다른 주석 표의 "유동" 열 칸 두 개 = X(042660 2024 기타금융자산 46,003,529,174원 = 상각후원가측정금융자산 내역 '정기예금 등' 유동 15,055 +
 * 당기손익-공정가치측정금융자산 내역 '채무상품' 유동 30,949 백만원 — 두 주석에 나뉘어 있다). 두 칸 모두 이름이 포함 성격이고, 합이 X 와 두 칸의 표 단위 반올림
 * 범위((u1 + u2)/2) 안이며, 그런 짝이 정확히 하나면 판독 실패 사유에 그 짝을 적는다(값은 제외)
 */
function crossTablePair(tables, X) {
  const hits = [];
  for (const rc of [...new Set(tables.map((t) => t.rc))]) {
    const cand = new Map();
    for (const t of tables.filter((x) => x.rc === rc && !x.face))
      for (let r = 0; r < t.rows.length; r += 1)
        for (let off = 0; off < t.rows[r].length; off += 1) {
          const v = cellVal(cellAt(t.rows[r], off));
          if (v == null || v <= 0) continue;
          const head = colHead(t.rows, r, off) ?? "";
          if (!/유\s*동/.test(head) || /비\s*유\s*동/.test(head)) continue;
          const lab = rowLastText(t.rows[r]);
          const nl = lab.replace(/\s/g, "");
          if (!lab || isTotalLabel(lab) || NOT_CONTENT.test(nl) || cashKindOf(lab, true) !== "inc" || /부채|사채|상각|할인/.test(nl + head) || v < 1000) continue;
          cand.set(`${nl}|${v * t.u}`, { label: lab, v, u: t.u, won: v * t.u, nl });
        }
    const cs = [...cand.values()];
    const pairs = [];
    for (let i = 0; i < cs.length; i += 1)
      for (let j = i + 1; j < cs.length; j += 1)
        if (cs[i].nl !== cs[j].nl && Math.abs(cs[i].won + cs[j].won - X) <= (cs[i].u + cs[j].u) / 2) pairs.push([cs[i], cs[j]]);
    const uniq = new Map(pairs.map((p) => [p.map((c) => c.won).sort((a, b) => a - b).join("+"), p]));
    if (uniq.size === 1) hits.push({ rc, p: [...uniq.values()][0] });
    else if (uniq.size > 1) return { many: true };
  }
  const vals = new Set(hits.map((h) => h.p.map((c) => c.won).sort((a, b) => a - b).join("+")));
  if (hits.length && vals.size === 1) return { hit: hits[0] };
  return hits.length ? { many: true } : null;
}
/**
 * ⑦ 범주별 내역 표(공정가치·상각후원가 금융자산 주석 표 각각)의 **유동·같은 기간 열** 칸들 = X(042660 2024 기타금융자산 46,003,529,174원 = 「9. 금융자산 (1)
 * 당기손익-공정가치측정」 채무상품 당기말 유동 30,949 + 「(3) 상각후원가측정」 정기예금 등 당기말 유동 15,055 백만원 — 통화선도 1,003 은 본표 따로).
 * 좁힘: ① 줄과 같은 범위 표(연결 줄이면 연결 — 첨부 문서 종류·본문 재무제표 제목으로, 같은 접수번호 안 별도 감사보고서 표 제외) ② 표 제목이 금융자산·금융상품이고
 * 제외 낱말 없음 ③ 열 머리가 유동(비유동 아님) + 기간이 그 보고서에서 그 해 열(당기 또는 전기 — 머리, 없으면 표 제목) ④ 자산 줄(금융자산 이름, 합계·측정 구분
 * 아님) ⑤ X 가 표 단위 1,000 이상 ⑥ 한 보고서 안 후보 14개 이하에서 2~5개 합이 X(각 칸 단위 반올림 합 범위)인 값 묶음이 정확히 하나, 보고서끼리도 같은 묶음
 */
function categoryCurrentCols(tables, X, ctx) {
  if (!ctx) return null;
  const want = ctx.fs === "OFS" ? "sep" : "con";
  const perOf = periodWord;
  const byRc = new Map();
  for (const t of tables) {
    if (t.face || t.scope !== want || !t.rowsX) continue;
    const per = ctx.period(t.rc);
    if (!per || !/금융자산|금융상품/.test(t.title ?? "") || TITLE_EXC.test(t.title ?? "")) continue;
    if (X / t.u < 1000) continue;
    const R = t.rowsX;
    const first = R.findIndex((row) => row.some((c) => cellVal(c) != null));
    if (first < 1) continue;
    const titlePer = [...(t.title ?? "").matchAll(PERIOD_RE_G)].map((m) => (m[1] === "당" ? "cur" : "prev")).at(-1) ?? null;
    for (let r = first; r < R.length; r += 1) {
      const lab = rowLastText(t.rows[r]);
      const nl = lab.replace(/\s/g, "");
      if (!lab || isTotalLabel(lab) || NOT_CONTENT.test(nl) || !FIN_ASSET_NAME.test(lab) || /부채|사채|상각|할인/.test(nl)) continue;
      const lead = R[r].findIndex((c) => cellVal(c) != null);
      for (let off = 0; off < R[r].length - lead; off += 1) {
        const v = cellVal(cellAt(R[r], off));
        if (!v || v <= 0) continue;
        const path = [];
        for (let q = 0; q < first; q += 1) { const h = cellAt(R[q], off); if (h) path.push(h); }
        if (!path.some((h) => /유\s*동/.test(h) && !/비\s*유\s*동/.test(h)) || path.some((h) => /비\s*유\s*동/.test(h))) continue;
        const pp = path.map(perOf).filter(Boolean);
        const cp = pp.length ? (new Set(pp).size === 1 ? pp[0] : null) : titlePer;
        if (cp !== per) continue;
        const m = byRc.get(t.rc) ?? byRc.set(t.rc, new Map()).get(t.rc);
        m.set(`${nl}|${v * t.u}`, { label: lab, v, u: t.u, won: v * t.u });
      }
    }
  }
  const found = [];
  for (const [rc, m] of byRc) {
    const cs = [...m.values()];
    if (cs.length < 2 || cs.length > 14) continue;
    const sets = new Map();
    for (let mk = 1; mk < 1 << cs.length; mk += 1) {
      const pick = cs.filter((_, i) => mk & (1 << i));
      if (pick.length < 2 || pick.length > 5) continue;
      if (Math.abs(pick.reduce((a, c) => a + c.won, 0) - X) <= pick.reduce((a, c) => a + c.u, 0) / 2) sets.set(pick.map((c) => c.won).sort((a, b) => a - b).join("+"), pick);
    }
    if (sets.size > 1) return null;
    if (sets.size === 1) found.push({ rc, pick: [...sets.values()][0], key: [...sets.keys()][0] });
  }
  if (!found.length || new Set(found.map((f) => f.key)).size !== 1) return null;
  const { rc, pick } = found[0];
  return { result: (tbls, line) => partsResult(tbls, X, pick, `${line} 주석 내역(${rc}) 범주별 내역 표 유동·같은 기간 열 칸 ${pick.length}개 합`) };
}
const PERIOD_RE_G = /(당|전)\)?\s*(반|분)?\s*기/g;
/** 기간 낱말 → "cur"(당기·당반기·"제 19(당) 기") | "prev"(전기) | null */
const periodWord = (t) => { const m = /(당|전)\)?\s*(반|분)?\s*기/.exec(t ?? ""); return m ? (m[1] === "당" ? "cur" : "prev") : null; };
/** ⑦·⑧b 공통 — 고른 칸들 [{label, v, u, won}] 의 성격으로 현금성 부분 */
function partsResult(tbls, X, pick, head) {
  const nz = pick.filter((c) => c.won !== 0).map((c) => ({ ...c, k: cashKindOf(c.label, true) ?? kindByAmount(tbls, c.v, c.u)?.kind ?? null }));
  const desc = nz.map((c) => `${c.label} ${c.v.toLocaleString("en-US")}(단위 ${c.u}원, ${c.k === "inc" ? "포함" : c.k === "exc" ? "제외" : "성격 미상"})`).join(" + ");
  const how = `${head}: ${desc}`;
  if (nz.some((c) => c.k == null)) return { cash: null, reason: "unknown-kind", how: `${how} → 제외` };
  const cash = nz.every((c) => c.k === "inc") ? X : nz.reduce((a, c) => a + (c.k === "inc" ? c.won : 0), 0);
  return { cash, how: `${how}${cash === X ? " → 줄 전체" : ""}` };
}
/**
 * ⑧b 빈 묶음 머리 + 기간·범주 열(079550 2020 연결감사보고서 「범주별 금융상품」: '기타금융자산' 빈 줄 아래 '단기금융상품 55,548,524 | - | 72,353,706 | (전기 3칸)' ·
 * 단기대여금 · 미수금 · 미수수익 · 보증금 · 파생상품자산 천원 — 머리 '제 19(당) 기'(3칸 병합) 아래 상각후원가·기타포괄·당기손익). 줄과 같은 범위 표, 그 보고서의 그 해
 * 기간 열만 더해 내역 금액으로 삼고, 빈 묶음 머리(금융자산 이름) 아래 숫자 줄 묶음 전체의 합이 X(0 아닌 칸 수/2, 표 단위 1,000 이상)일 때만. 표·묶음끼리 결과가
 * 갈리면 정하지 않는다
 */
function groupPeriodCols(tables, X, ctx) {
  if (!ctx) return null;
  const want = ctx.fs === "OFS" ? "sep" : "con";
  const hits = [];
  for (const t of tables) {
    if (t.face || t.scope !== want || !t.rowsX || X / t.u < 1000) continue;
    const per = ctx.period(t.rc);
    // 표 제목은 보지 않는다 — 앞 문단(회계기준 개정 목록의 "부채의 유동/비유동 분류")이 제목으로 잡히는 표가 있고(079550 2020), 묶음 전체 합 = X 와 기간 열 머리가 근거
    if (!per) continue;
    const R = t.rowsX;
    const first = R.findIndex((row) => row.some((c) => cellVal(c) != null));
    if (first < 1) continue;
    const width = Math.max(...R.map((row) => row.length));
    const cols = [];
    for (let off = 0; off < width; off += 1) {
      const pp = [];
      for (let q = 0; q < first; q += 1) { const k = periodWord(cellAt(R[q], off)); if (k) pp.push(k); }
      if (pp.length && new Set(pp).size === 1 && pp[0] === per) cols.push(off);
    }
    // 그 기간 열이 둘 이상(범주 열)이고, 다른 기간 열도 있어야(기간 머리가 실제로 열을 나눈 표)
    if (cols.length < 2) continue;
    for (let r = first; r < R.length; r += 1) {
      if (R[r].some((c) => cellVal(c) != null)) continue;
      const glab = t.rows[r].filter(Boolean).join(" ");
      if (!glab || !FIN_ASSET_NAME.test(glab) || isTotalLabel(glab) || /부채/.test(glab)) continue;
      const pick = [];
      let cells = 0;
      for (let q = r + 1; q < R.length; q += 1) {
        if (!R[q].some((c) => cellVal(c) != null)) break;
        const lab = rowLastText(t.rows[q]);
        if (!lab || isTotalLabel(lab)) break;
        const vs = cols.map((off) => cellVal(cellAt(R[q], off)));
        if (vs.some((v) => v == null)) { pick.length = 0; break; }
        const v = vs.reduce((a, x) => a + x, 0);
        cells += vs.filter((x) => x !== 0).length;
        pick.push({ label: lab, v, u: t.u, won: v * t.u });
      }
      if (pick.length < 2 || !pick.every((c) => FIN_ASSET_NAME.test(c.label) && !NOT_CONTENT.test(c.label.replace(/\s/g, "")))) continue;
      const sum = pick.reduce((a, c) => a + c.v, 0);
      if (Math.abs(sum - X / t.u) <= sumTol(X / t.u, Math.max(1, cells))) hits.push({ t, glab, pick });
    }
  }
  if (!hits.length) return null;
  const keys = new Set(hits.map((h) => h.pick.map((c) => `${c.label.replace(/\s/g, "")}=${c.won}`).join(",")));
  if (keys.size !== 1) return null;
  const h = hits[0];
  return { result: (tbls, line) => partsResult(tbls, X, h.pick, `${line} 주석 내역(${h.t.rc}) 빈 묶음 머리 '${h.glab}' 아래 그 해 기간 열(범주 열 합) 내역 ${h.pick.length}개`) };
}
/**
 * 내역을 찾지 못한 경우 — ⑥ 두 주석 칸 짝을 먼저, 그다음 사유를 나눈다(감사 2026-10-18 — 판독 실패와 내역 미공시를 구분):
 *  undisclosed = 본표(자산총계가 있는 표) 밖 주석 표 어디에도 X(표 단위 반올림 0.5 이내) 칸이 없음 — 회사가 그 줄의 내역을 공시하지 않음(000660 — 오너 결정: 제외 + 칸 주석)
 *  unread      = 그 금액 칸이 있는 주석 표가 있는데 내역으로 읽지 못함(판독기가 고쳐야 할 대상)
 *  small       = 표 단위로 1,000 미만이라 우연히 같은 금액 칸이 많아 미공시인지 판정 못 함
 */
function notFound(tables, X, line, depth, ctx) {
  const base = `${line} ${X.toLocaleString("en-US")}원 — 주석 내역을 찾지 못함`;
  if (depth === 0) {
    const cc = categoryCurrentCols(tables, X, ctx) ?? groupPeriodCols(tables, X, ctx);
    if (cc) return cc.result(tables, line);
    const cp = crossTablePair(tables, X);
    // 진단만(재감사 2026-10-18 — 당기·전기 열, 별도 감사보고서 칸, 부채 줄이 후보에 섞여 안전하게 좁히지 못해 포함 규칙에서 뺐다. 042660 2024 = 빈칸 + 사유)
    if (cp?.hit) {
      const [a, b] = cp.hit.p;
      return { cash: null, reason: "unread", how: `${base} — 판독 실패(서로 다른 주석 표 칸 두 개의 합으로만 맞음: ${a.label} ${a.v.toLocaleString("en-US")}(단위 ${a.u}원) + ${b.label} ${b.v.toLocaleString("en-US")}(단위 ${b.u}원), ${cp.hit.rc} — 같은 기간·연결 범위를 확인하는 규칙이 없어 제외)` };
    }
  }
  // 그 줄 자체를 다시 적은 칸(범주별 표·신용위험 표의 '기타금융자산' 줄·열)은 내역이 아니라 빼고 본다. 0.5 넘게(3 이내) 다른 칸은 "합계 칸이 반올림 범위 밖"으로 따로
  const ln = line.replace(/\s/g, "");
  const same = (t) => (t ?? "").replace(/\(.*?\)|\s|^\d+\.?/g, "") === ln;
  const big = [], near = [], small = [];
  for (const t of tables) {
    if (t.face) continue;
    const target = X / t.u;
    for (let r = 0; r < t.rows.length; r += 1)
      for (let off = 0; off < t.rows[r].length; off += 1) {
        const c = cellVal(cellAt(t.rows[r], off));
        if (c == null || c === 0) continue;
        const d = Math.abs(Math.abs(c) - Math.abs(target));
        if (d > 3 || same(rowLastText(t.rows[r])) || same(colHead(t.rows, r, off))) continue;
        // 근접(0.5 초과) 칸은 합계·금융자산 내역 이름 줄만(000660 2026 반기 '매입 등' 23,066 같은 우연한 칸 제외)
        if (d > 0.5 && !(isTotalLabel(rowLastText(t.rows[r])) || FIN_ASSET_NAME.test(rowLastText(t.rows[r])))) continue;
        const tag = `${t.rc} '${rowLastText(t.rows[r]) || colHead(t.rows, r, off) || "?"}' ${c.toLocaleString("en-US")}(단위 ${t.u}원)`;
        if (Math.abs(target) < 1000) { if (d <= 0.5) small.push(tag); } else (d <= 0.5 ? big : near).push(tag);
      }
  }
  if (big.length) return { cash: null, reason: "unread", how: `${base} — 판독 실패(그 금액 칸이 있는 주석 표를 내역으로 읽지 못함: ${[...new Set(big)].slice(0, 3).join(", ")})` };
  if (near.length) return { cash: null, reason: "unread", how: `${base} — 판독 실패(본표 값과 표 단위 반올림 0.5 넘게(3 이내) 다른 합계·내역 칸만 있음: ${[...new Set(near)].slice(0, 3).join(", ")})` };
  if (small.length) return { cash: null, reason: "small", how: `${base} — 같은 금액 칸이 표 단위 1,000 미만 작은 수로만 있어(${[...new Set(small)].slice(0, 2).join(", ")}) 내역 미공시인지 판정 못 함` };
  return { cash: null, reason: "undisclosed", how: `${base} — 내역 미공시(본표 밖 주석 표에 그 금액 칸 없음)` };
}
/** 보고서 원문들에서 X 의 현금성 부분 */
async function cashPartOf(rcps, X, line, ctx = null) {
  const tables = [];
  for (const rc of rcps) for (const t of tablesOf(await docTexts(rc))) tables.push({ ...t, rc });
  const r = cashPartOfTables(tables, X, line, 0, ctx);
  return r.cash == null && /찾지 못함/.test(r.how) ? { ...r, how: `${r.how} (${rcps.join("·")}) → 현금성자산에서 제외` } : r;
}
/** 유동자산의 "기타(유동)금융자산" 계열 줄 — 비유동자산 머리 줄(NoncurrentAssets·"비유동자산") 뒤 줄은 뺀다(006400 비유동 "기타투자자산") */
const familyRows = (rows) => {
  const bs = (rows ?? []).filter((r) => r.sj_div === "BS");
  const nc = bs.findIndex((r) => r.account_id === "ifrs-full_NoncurrentAssets" || /^비유동자산(합계)?$/.test((r.account_nm ?? "").replace(/\s/g, "")));
  return bs.filter((r, i) => (nc < 0 || i < nc) && CASH_FAMILY.test((r.account_nm ?? "").replace(/\s/g, "")) && !/Noncurrent|NonCurrent/.test(r.account_id ?? ""));
};
/** 사업연도별 cashNote — { "2025": [{ line, value, cash, how }] } */
async function cashNotes(corp, latest) {
  const out = {};
  const rcpsOf = {};
  const rcps = async (ry) => (rcpsOf[ry] ??= await annualRcps(corp, ry));
  const bsOf = {};
  const bs = async (ry) => (ry in bsOf ? bsOf[ry] : (bsOf[ry] = await fnlttBs(corp, ry)));
  for (let y = latest; y >= latest - 5; y -= 1) {
    // 값 = 그 해를 담은 가장 최근 보고서(앱 연간 로더와 같은 주인 보고서 규칙)
    let own = null;
    for (const [ry, col] of [[y + 2, "bfefrmtrm_amount"], [y + 1, "frmtrm_amount"], [y, "thstrm_amount"]]) {
      if (ry > latest) continue;
      const r = await bs(ry);
      if (r?.rows.some((x) => amt(x[col]) != null)) { own = { ry, col, rows: r.rows, fs: r.fs }; break; }
    }
    if (!own) continue;
    const lines = familyRows(own.rows).map((x) => ({ line: x.account_nm.replace(/\s/g, ""), value: amt(x[own.col]) })).filter((x) => x.value != null && x.value !== 0);
    if (!lines.length) continue;
    const reps = [...new Set([y, y + 1, own.ry].filter((ry) => ry <= latest))];
    const docs = [];
    const yearOf = {};
    for (const ry of reps) for (const rc of await rcps(ry)) { docs.push(rc); yearOf[rc] = ry; }
    // ⑦ 용 — 줄의 재무제표 범위(연결·별도)와 보고서마다 그 해 열(그 해 보고서 = 당기, 다음 해 보고서 = 전기)
    const ctx = { fs: own.fs, period: (rc) => (yearOf[rc] === y ? "cur" : yearOf[rc] === y + 1 ? "prev" : null) };
    out[y] = [];
    for (const l of lines) out[y].push({ ...l, ...(await cashPartOf(docs, l.value, l.line, ctx)) });
  }
  return out;
}
/** 최신 분기·반기 보고서 cashQuarter — { label, items: [{ line, value, cash, how }] } (최신 정기보고서가 사업보고서면 null) */
async function cashQuarterOf(corp, fy) {
  const it = await latestInterim(corp, fy);
  if (!it) return null;
  const label = `${it.year} Q${it.q}`;
  await new Promise((r) => setTimeout(r, 400));
  let rows = null, rowsFs = null;
  for (const fs of ["CFS", "OFS"]) {
    const j = await jget(`${B}/fnlttSinglAcntAll.json?crtfc_key=${DART}&corp_code=${corp}&bsns_year=${it.year}&reprt_code=${it.code}&fs_div=${fs}`);
    if (j.status === "013") continue;
    if (j.status !== "000") throw new Error(`fnltt ${it.year} ${it.code} ${fs} ${j.status} ${j.message ?? ""}`);
    rows = (j.list ?? []).filter((r) => r.sj_div === "BS");
    rowsFs = fs;
    break;
  }
  const lines = familyRows(rows).map((x) => ({ line: x.account_nm.replace(/\s/g, ""), value: amt(x.thstrm_amount) })).filter((x) => x.value != null && x.value !== 0);
  const items = [];
  const ctx = { fs: rowsFs, period: () => "cur" };
  for (const l of lines) items.push({ ...l, ...(await cashPartOf(it.rcps, l.value, l.line, ctx)) });
  return { label, items };
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
  console.log(`  ${sym}: 리스부채·현금성자산 주석`);
  try {
    const ly = await latestFy(corp);
    if (ly) lease = await leaseNotes(corp, ly);
    if (lease) for (const [y, n] of Object.entries(lease.leaseNote)) console.log(`    리스 ${y}: ${n.status}${n.amount != null ? ` ${t(n.amount)}` : ""} — ${n.how}`);
    if (lease?.leasePolicyLatest) console.log(`    리스 분기말: ${lease.leasePolicyLatest.status} — ${lease.leasePolicyLatest.how}`);
    if (lease?.leaseQuarter) console.log(`    리스 ${lease.leaseQuarter.label}: ${lease.leaseQuarter.status}${lease.leaseQuarter.amount != null ? ` ${t(lease.leaseQuarter.amount)}` : ""} — ${lease.leaseQuarter.how}`);
    if (ly && lease) {
      lease.cashNote = await cashNotes(corp, ly);
      lease.cashQuarter = await cashQuarterOf(corp, ly);
      for (const [y, its] of Object.entries(lease.cashNote)) for (const i of its) console.log(`    현금 ${y} ${i.line} ${i.value} → ${i.cash ?? "제외"} — ${i.how}`);
      for (const i of lease.cashQuarter?.items ?? []) console.log(`    현금 ${lease.cashQuarter.label} ${i.line} ${i.value} → ${i.cash ?? "제외"} — ${i.how}`);
    }
  } catch (e) { console.log(`    (리스부채·현금 주석 실패: ${e.message})`); failed.push(sym); lease = null; }
  if (LEASE_ONLY) {
    if (lease && !CHECK && !QUOTA.stopped) await db.collection(COLL).updateOne({ _id: sym }, { $set: { leaseNote: lease.leaseNote, leasePolicyLatest: lease.leasePolicyLatest, leaseQuarter: lease.leaseQuarter, cashNote: lease.cashNote, cashQuarter: lease.cashQuarter, leaseAt: new Date().toISOString() } });
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
    { _id: sym, byYear, ...(ttm ?? {}), ...(lease ? { leaseNote: lease.leaseNote, leasePolicyLatest: lease.leasePolicyLatest, leaseQuarter: lease.leaseQuarter, cashNote: lease.cashNote, cashQuarter: lease.cashQuarter } : {}), sourceRcepts, rulesVersion: KR_DA_RULES_VERSION, updatedAt: new Date().toISOString() },
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
console.log(`DART 하루 요청(적재) ${qs.count}/${qs.cap} — ${qs.day} KST · 이번 실행 DART 요청 ${DISK.stats.requests}건(목록 ${DISK.stats.listPages}) · 디스크 캐시 ${env.DART_CACHE_DIR ? `적중 ${DISK.stats.hit} · 미스 ${DISK.stats.miss} · 새로 씀 ${DISK.stats.write}` : "꺼짐(DART_CACHE_DIR 없음)"} · 건너뜀(변화 없음) ${skipped}종목${FULL ? "(--full)" : ""}`);
if (failed.length) {
  console.log(`실패 ${failed.length}종목: ${[...new Set(failed)].join(" ")}`);
  process.exitCode = 1;
}
await cli.close();
console.log("완료");
