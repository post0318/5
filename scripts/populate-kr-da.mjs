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
const KR_DA_RULES_VERSION = "2026-10-26.1";
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
// 재감사 2026-10-19: 국공채·회사채·사모사채·금융채·상각후원가측정채권(20260814003544 사모사채·국채)도 투자성. 넓은 낱말 "채권"·"사채" 단독은 근거가 아니다(SPEC_INC)
const DEP_INV = /예금|예치금|(단기|장기|장단기|단장기)금융상품|채무상품|국공채|국채|지방채|회사채|사모사채|금융채|상각후원가측정채권|펀드|수익증권|신탁|저축성보험|양도성|기업어음|전자단기|(?<![A-Za-z])(MMF|CMA)(?![A-Za-z])/;
/** ⑤ 칸 이름 하나를 근거로 삼을 때 — 구체 이름만(특수관계자 표 열 머리 '채권' 같은 넓은 낱말 제외). 사용제한·동반성장 예금도(②b) */
const SPEC_INC = new RegExp(`${DEP_INV.source}|사용제한|동반성장|유가증권|환매조건|(?<![A-Za-z])(RP|CD)(?![A-Za-z])`);
/** 비유동 이름("장기금융상품"·"장기예치금"·"비유동") — 유동 줄(계열 줄은 전부 유동)의 단독 근거로 쓰지 않는다. "장단기"·"단장기"는 단기 포함이라 허용 */
const nonCurrentName = (t) => /장기|비\s*유\s*동/.test(t) && !/단기/.test(t);
/** 단독 근거용 이름 검사 — 포함 성격 + 구체 이름 + 비유동 아님 + 지분 섞인 이름 아님("채무상품 및 지분상품") */
const specificInc = (nm) => { const t = (nm ?? "").replace(/\s|[ㆍ·・]/g, ""); return cashKindOf(t) === "inc" && SPEC_INC.test(t) && !nonCurrentName(t) && !/지분|주식|출자/.test(t); };
// 제목 제외 낱말 — "채권"은 금융자산·금융상품 낱말이 같이 없을 때만(「매출채권 및 상각후원가측정금융자산」은 막지 않는다)
const TITLE_EXC_BASE = /채무|부채|특수관계|연체|사채|대여|보증/;
const TITLE_EXC = { test: (t) => TITLE_EXC_BASE.test(t) || (/채권/.test(t) && !/금융자산|금융상품/.test(t)) };
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
/** leaseInFaceTable 의 모든 확인 묶음 — [{ text, face(원), leaseWon(원), u }] (같은 본표 줄·같은 리스 줄 금액은 한 번만) */
/**
 * 교차 확인 — 순위 1(리스부채 한 줄) 칸이 같은 문서(접수번호)·같은 기간의 변동표 기말과 표 단위 1 넘게 다르면 seen 에서 빼고 뺀 칸들을 돌려준다
 * (일부만 담은 줄 — 유동분만 적은 기타부채 표 등). 1 단위 차이는 반올림
 */
function crossDropPrio1(seen) {
  const dropped = [];
  for (const c of [...seen]) {
    if (c.prio !== 1) continue;
    const mv = seen.filter((m) => m.rc === c.rc && /변동표.*기말/.test(m.form));
    if (mv.length && mv.every((m) => Math.abs(m.won - c.won) > Math.max(m.u, c.u))) { dropped.push(c); seen.splice(seen.indexOf(c), 1); }
  }
  return dropped;
}
/** 리스부채 잔액 줄 이름(이자비용·자산·처분·손익·상환 등이 붙은 줄은 아님 — 감사 2026-10-19 ⑪ 「리스부채에 대한 이자비용」「리스자산 및 부채」「리스자산처분이익」) */
const LEASE_BAL_LABEL = (l) => /리스부채/.test(l) && !/이자|비용|자산|처분|손익|수익|상환|지급|할인|원리금/.test(l);
/** 원문들의 소계·합계 묶음 색인(한 번만 만든다 — 흔든 값 시험이 수만 번 부른다): { byKey: Map(u|round(|합계|) → [묶음]) } */
const blockIndexMemo = new WeakMap();
function blockIndex(texts) {
  if (blockIndexMemo.has(texts)) return blockIndexMemo.get(texts);
  const isTotal = (t) => /(^|[^가-힣])(소\s*계|합\s*계|총\s*계|계)\s*$/.test(t) || /^(소계|합계|계|총계)/.test(t.replace(/\s/g, ""));
  const byKey = new Map();
  for (const x of texts) {
    for (const m of x.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
      const inTab = clean(m[0].slice(0, 2000)).match(UNIT_RE)?.[1];
      const pre = clean(x.slice(Math.max(0, m.index - 1500), m.index));
      const before = [...pre.matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
      const u = UNIT[inTab ?? before];
      if (!u) continue;
      // 이연법인세·손익·비용 표의 '리스' 줄은 잔액이 아니다 — 표 앞 제목(마지막 번호 매김 뒤)으로
      const head = pre.slice(-200).split(/\(\d+\)|\d+\)|[①-⑳]/).at(-1) ?? "";
      // 제목이 「전기 (단위 : 백만원)」처럼 기간·단위뿐이면(XBRL 표 — 앞 표 「이자비용의 내역 당기」를 잇는다) 앞 1,500자에서 본다(402340 2023 이자비용 표 차입금·사채·리스부채·기타 = 합계)
      const tail = head.replace(/\(?\s*단위\s*:[^)]*\)?/g, "").replace(/^[\s\S]*\d[\d,]*\s*/, ""); // 앞 표 숫자 줄 뒤 글자
      const bare = !tail.replace(/(당|전)\s*(반|분)?\s*기\s*말?|\s/g, "");
      // 제목 = 표 앞 마지막 문장(titleOf) — 앞 문단의 「기타수익및기타비용」 같은 낱말이 섞이지 않게(298040 「기타금융자산 및 기타금융부채」 표)
      const title = (titleOf(pre.slice(-400)) ?? "").split(/\(\d+\)|\d+\)|[①-⑳]/).at(-1) ?? "";
      const pnlTable = /이연법인세|일시적\s*차이|비용|손익|수익/.test(bare ? clean(x.slice(Math.max(0, m.index - 8000), m.index)).slice(-600) : title);
      // 표 주제 글자(표 앞 300자 + 첫 두 줄, 띄어쓰기 없음) — 묶음이 어느 본표 줄의 주석인지 확인할 때(감사 ⑪)
      const topic = (pre.slice(-300) + [...m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)].slice(0, 2).map((r) => clean(r[0])).join(" ")).replace(/\s/g, "");
      // 열마다 따로(오른쪽 끝 기준 — 당기·전기 열). "-" 칸은 0
      const cellNum = (c) => (c === "-" ? 0 : numOf(c));
      let block = [];
      // 열 기간(감사 ⑪ 흔든 값 시험 — 다른 기간 열의 합계와 우연히 맞았다): 첫 숫자 줄 앞 머리 줄들(COLSPAN 펼침, 오른쪽 기준)의 기간 낱말, 없으면 제목의 기간(하나일 때)
      const heads = [];
      let seenNum = false;
      const tps = [...new Set([...(head ?? "").matchAll(PERIOD_RE_G)].map((mm) => periodWord(mm[0])))];
      const titlePer = tps.length === 1 ? tps[0] : null;
      // 「제53기 | 제52기」처럼 기수만 적은 머리는 큰 기수 = 당기, 하나 작은 기수 = 전기(005930 2021 보고서 차입금 주석)
      const gisu = (h) => Number(/제\s*(\d+)\s*기/.exec(h ?? "")?.[1] ?? NaN);
      const colPer = (off) => {
        const ks = [...new Set(heads.map((h) => periodWord(h[h.length - 1 - off] ?? "")).filter(Boolean))];
        if (ks.length) return ks.length === 1 ? ks[0] : null;
        const all = heads.flat().map(gisu).filter((n) => !Number.isNaN(n));
        const mine = heads.map((h) => gisu(h[h.length - 1 - off])).filter((n) => !Number.isNaN(n));
        if (all.length && mine.length) { const mx = Math.max(...all); return mine[0] === mx ? "cur" : mine[0] === mx - 1 ? "prev" : null; }
        return titlePer;
      };
      for (const r of m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)) {
        const cellsX = [...r[0].matchAll(/<T[DHEU]([^>]*)>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => ({ t: clean(c[2]).replace(/　/g, "").trim(), span: Number(/COLSPAN="(\d+)"/i.exec(c[1])?.[1] ?? 1) }));
        const cells = cellsX.map((c) => c.t);
        const i = cells.findIndex((c) => numOf(c) != null);
        if (i < 0 && !seenNum) heads.push(cellsX.flatMap((c) => Array(Math.min(c.span, 40)).fill(c.t)));
        if (i >= 0) seenNum = true;
        const label = (i < 0 ? cells : cells.slice(0, i)).join(" ");
        if (i < 0) { block = []; continue; } // 제목 줄("장기차입금:")
        const vals = cells.slice(i).reverse().map(cellNum);
        if (isTotal(label)) {
          for (let off = 0; off < vals.length; off += 1) {
            const v = vals[off];
            if (v == null) continue;
            const blk = block.filter((bb) => bb.vals[off] != null).map((bb) => ({ label: bb.label, v: bb.vals[off] }));
            if (blk.reduce((acc, bb) => acc + bb.v, 0) !== v) continue;
            const key = `${u}|${Math.round(Math.abs(v))}`;
            // 만기 구간 열(「6~12개월」·「1년 초과~5년 이하」·「2년 이상」)의 합계는 잔액이 아니다(재감사 ③ — 042660 2022 128,505 · 267260 2022 · 060370 2023)
            const interval = heads.some((h) => /개월|이내|이하|이상|초과|미만|~/.test(h[h.length - 1 - off] ?? ""));
            (byKey.get(key) ?? byKey.set(key, []).get(key)).push({ u, label, v, blk, pnlTable, topic, per: colPer(off), interval });
          }
          block = [];
          continue;
        }
        block.push({ label, vals });
      }
    }
  }
  const idx = { byKey };
  blockIndexMemo.set(texts, idx);
  return idx;
}
/**
 * 본표 값(원)과 합계가 맞는 주석 묶음 — mode "lease" = 리스부채 잔액 줄이 든 묶음, "nolease" = 리스 줄 없는 묶음. opts.pairs = 본표 두 줄 합·전체 합도 비교(차입금 확인만).
 * 본표 값은 표 단위로 1,000 이상일 때만(소액 우연 일치 차단 — 감사 2026-10-19 ⑥ 402340 2023 −10 백만원)
 */
function leaseInFaceTableAll(texts, faceVals, mode = "lease", what = "본표 차입금", opts = { pairs: true }) {
  const hits = new Map();
  // 주제 확인(감사 2026-10-19 ⑪ 흔든 값 시험): 차입금 확인은 표 주제가 차입금·사채·금융부채 주석, 다른 부채 줄·리스 없음 확인은 그 본표 줄 이름(유동·비유동·장단기
  // 뺀 꼴)이 표 주제에 있을 때만. opts.name = 본표 줄 이름
  const core = opts.name ? opts.name.replace(/\s/g, "").replace(/(유동성?|비유동|단기|장기)/g, "") : null;
  // 차입금 확인: 표 주제가 차입금·사채 주석이고 묶음 줄이 모두 차입 성격(차입·사채·리스·어음·은행 등 — 범주별 금융부채 표 합계와의 우연 일치 차단, 흔든 값 시험)
  const DEBT_ROW = /차입|사채|리스|어음|CP|유동성|대체|전환|교환|은행|금고|캐피탈|증권|보험|외화|원화|USD|EUR|JPY|CNY|운영|시설|일반|담보|신용|무역|금융기관|기타/;
  const topicOk = (bk) => (mode === "lease" && opts.pairs ? /차입금|사채/.test(bk.topic) && bk.blk.every((bb) => DEBT_ROW.test(bb.label)) : core && core.length >= 3 ? bk.topic.includes(core) && (mode !== "nolease" || /차입|사채/.test(bk.topic)) : false);
  // faceVals = 숫자 또는 { v, name }. 두 줄 합은 같은 이름 바탕의 유동·비유동 짝만(유동성장기차입부채 + 장기차입부채 — 178320 2021 장기차입부채 표 소계 251,418,463 천원).
  // 아무 두 줄 합·전체 합은 흔든 값 시험에서 우연 일치가 나와 뺐다(감사 2026-10-19 ⑪)
  const items = faceVals.map((f) => (typeof f === "object" && f ? f : { v: f, name: null })).filter((f) => f.v != null && f.v !== 0);
  const targets = items.map((f) => f.v);
  if (!targets.length) return [];
  const base = (n) => (n ?? "").replace(/\s/g, "").replace(/(유동성|유동|비유동|장기|단기)/g, "");
  const all = [...targets];
  if (opts.pairs || opts.natPairs)
    for (let i = 0; i < items.length; i += 1)
      for (let j = i + 1; j < items.length; j += 1) if (items[i].name && base(items[i].name) === base(items[j].name)) all.push(items[i].v + items[j].v);
  const { byKey } = blockIndex(texts);
  for (const face of all)
    for (const u of [1, 1e3, 1e6, 1e8]) {
      const fu = Math.abs(face) / u;
      if (fu < 1000) continue;
      for (let d = -6; d <= 6; d += 1)
        for (const bk of byKey.get(`${u}|${Math.round(fu) + d}`) ?? []) {
          // 본표(원) ↔ 표(표 단위): 표 소계는 반올림한 줄 n 개의 합이라 n/2 단위까지(178320 2023 1.127 단위, 298040 2023 「소계」 59,080 vs 59,079.26 백만원)
          // 다른 부채 줄 확인은 최대 1 단위(재감사 ③ — 001440 2020 본표 「매입채무」를 흔든 값이 주석 「매입채무 및 기타금융부채」 소계 152,794 와 2.6 단위로 맞았다)
          if (Math.abs(fu - Math.abs(bk.v)) > (opts.pairs ? sumTol(fu, bk.blk.length) : Math.min(1, sumTol(fu, bk.blk.length)))) continue;
          if (bk.pnlTable || bk.interval || !bk.v || !topicOk(bk)) continue;
          if (opts.per && bk.per !== opts.per) continue;
          // 리스 줄은 합계와 같은 부호(유동성 대체 묶음처럼 음수로 적은 표 — 178320 2025 「소계」 (347,612,453) · 장기리스부채 (10,776,841) 천원)
          const lease = bk.blk.find((bb) => LEASE_BAL_LABEL(bb.label) && bb.v !== 0 && Math.sign(bb.v) === Math.sign(bk.v));
          if (mode === "nolease") {
            if (bk.blk.length >= 1 && !bk.blk.some((bb) => /리스/.test(bb.label))) {
              const key = `${face}|nolease`;
              if (!hits.has(key)) hits.set(key, { text: `주석 표 '${bk.label}' ${bk.v.toLocaleString("en-US")}(단위 ${u}원) = 리스 줄 없는 묶음 합 = ${what} ${face.toLocaleString("en-US")}원`, face, leaseWon: 0, u, bkey: `${bk.label}|${bk.v}|${u}` });
            }
            continue;
          }
          if (bk.blk.length >= 2 && lease) {
            const key = `${face}|${Math.abs(lease.v) * u}`;
            if (!hits.has(key)) hits.set(key, { text: `주석 표 '${bk.label}' ${bk.v.toLocaleString("en-US")}(단위 ${u}원) = 리스 줄 '${lease.label}' ${lease.v.toLocaleString("en-US")} 포함 묶음 합 = ${what} ${face.toLocaleString("en-US")}원`, face, leaseWon: Math.abs(lease.v) * u, u, bkey: `${bk.label}|${bk.v}|${u}` });
          }
        }
    }
  return [...hits.values()];
}
/**
 * 원문 표 하나에서 리스부채 잔액 칸 — [{ per: "cur"|"prev", v(표 단위), form }]. 꼴:
 *  F1 '리스부채' 줄(당기말·전기말 열 — 298040 「기타금융부채」 표 리스부채 16,740 | 21,264 백만원). 유동·비유동·만기·최소리스료 열은 뺀다
 *  F2 세로 변동표(제목에 리스부채 + 변동, 줄 '기초'·'기말' — 298040 「리스부채의 변동내역」 기말 16,740)
 *  F3 가로 변동표(머리에 '기초'·'기말' 열, 줄 '리스부채' — 103590 「리스부채의 변동내역 (당기)」·「재무활동으로 인한 현금흐름」 기말 1,964,406 천원)
 * 기초 = 앞 기간 잔액(당기 표의 기초 → 전기말)
 */
function leaseCellsOf(t, prevPair = null) {
  const R = t.rowsX;
  const out = [];
  const res = { cells: out, pair: null };
  if (!R?.length) return res;
  const first = R.findIndex((row) => row.some((c) => cellVal(c) != null));
  if (first < 1) return res;
  const width = Math.max(...R.map((row) => row.length));
  const pathOf = (off) => { const p = []; for (let q = 0; q < first; q += 1) { const h = cellAt(R[q], off); if (h && !/단위/.test(h)) p.push(h.replace(/\s/g, "")); } return p; };
  // 제목의 기간 = 첫 기간 낱말(감사 2026-10-19 ⑨ — 「당기 및 전기 중 …」을 마지막 낱말로 전기로 봤다)
  // 제목에 당기·전기 낱말이 둘 다 있으면(「전기 및 당기 중 …」) 제목으로 기간을 정하지 않는다
  const tps = [...new Set([...(t.title ?? "").matchAll(PERIOD_RE_G)].map((mm) => periodWord(mm[0])))];
  const titlePer = tps.length === 1 ? tps[0] : null;
  const perOfPath = (p) => { const ks = [...new Set(p.map(periodWord).filter(Boolean))]; return ks.length === 1 ? ks[0] : ks.length ? undefined : null; };
  // 리스부채 잔액 줄 이름 — '리스부채'·'장ㆍ단기리스부채'·'(연결)재무상태표에 인식된 리스부채'(006400 만기분석 표 — 할인 전 줄은 아님)
  const isLeaseLabel = (l) => { const t = (l ?? "").replace(/\s/g, ""); return /^(장ㆍ단기|장·단기|장단기)?리스부채(\(\*\d*\))?$/.test(t) || (/재무상태표(에|상)인식된리스부채(\(\*\d*\))?$/.test(t) && !/할인/.test(t)); };
  // 변동표의 리스 줄 — 유동성·장기 등으로 나뉜 줄도(298040 재무활동 표 「리스부채」·「유동성 리스부채」 — 합)
  const isLeaseRow = (l) => /^(유동성?|비유동성?|장기|단기|장ㆍ단기|장·단기|장단기)?리스부채(\((유동성?|비유동)\))?(\(\*\d*\))?$/.test((l ?? "").replace(/\s/g, ""));
  // 리스 줄·열 여럿의 값 합치기(감사 2026-10-19 ①②): 꾸밈 없는 '리스부채'(합계)와 유동·비유동·장기·단기 줄이 함께 있으면, 합계 = 구성 합(칸수/2 안)일 때 합계만
  // (한 칸 — 순위 그대로), 아니면 전부 더함(여러 칸 합 — 반올림된 칸들의 합). [{label, v}] → { v, n(더한 칸 수), single(한 칸) }
  const plainLease = (l) => /^(장ㆍ단기|장·단기|장단기)?리스부채(\(\*\d*\))?$/.test((l ?? "").replace(/\s/g, "")) || /재무상태표(에|상)인식된리스부채/.test((l ?? "").replace(/\s/g, ""));
  // 합치기 규칙(재감사 2026-10-21 ①②): 꾸밈 없는 '리스부채' 한 줄 = 그 값(구성 줄이 함께 있으면 합계 = 구성 합일 때만 — 유동성 대체 음수 묶음은 절댓값 합), 합계와
  // 구성이 안 맞으면 후보 아님(더하지 않는다 — 이중 계산). 구성 줄만 있으면 유동·비유동 두 쪽이 다 있고 음수 줄이 없을 때만 합(순위 2.5). 유동·비유동 한쪽만·음수
  // 유동성 대체 줄(178320 「장기차입부채」 표 장기리스부채 16,224,036 + (8,652,479) = 비유동분)은 전체 리스부채가 아니라 후보 아님
  const sideOf = (l) => { const t = (l ?? "").replace(/\s/g, ""); return /^(유동성?|단기)/.test(t) ? "cur" : /^(비유동성?|장기)/.test(t) ? "non" : null; };
  const combine = (items) => {
    if (!items.length || items.some((x) => x.v == null)) return null;
    // 구역 머리(「유동성」·「비유동성」) 아래의 꾸밈 없는 '리스부채'는 그 구역 몫(042660 재무활동 표 유동성리스부채 16,873 + 비유동성 구역 리스부채 61,167 = 78,040 백만원)
    const sd = (x) => sideOf(x.label) ?? x.side ?? null;
    const plain = items.filter((x) => plainLease(x.label) && !x.side), comp = items.filter((x) => !(plainLease(x.label) && !x.side));
    if (plain.length === 1 && !comp.length) return { v: plain[0].v, n: 1, single: true };
    if (plain.length === 1) {
      const s1 = comp.reduce((acc, x) => acc + x.v, 0), s2 = comp.reduce((acc, x) => acc + Math.abs(x.v), 0);
      // 음수 구성(유동성 대체)이 있으면 절댓값 합만 — 부호 그대로의 합은 유동성 대체 뒤 비유동 순액(가상 A7 「장기리스부채 1,000 · 유동성리스부채 (300) · 리스부채 700」)
      const neg = comp.some((x) => x.v < 0);
      if ((!neg && Math.abs(plain[0].v - s1) <= comp.length / 2) || (neg && Math.abs(plain[0].v - s2) <= comp.length / 2)) return { v: plain[0].v, n: 1, single: true, total: true };
      return null;
    }
    if (plain.length >= 2 && !comp.length) return plain.every((x) => x.v >= 0) ? { v: plain.reduce((acc, x) => acc + x.v, 0), n: plain.length, single: false } : null;
    if (!plain.length && comp.length === 2 && comp.every((x) => x.v > 0) && new Set(comp.map(sd)).size === 2 && comp.every(sd)) return { v: comp[0].v + comp[1].v, n: 2, single: false };
    return null;
  };
  // 줄이 속한 구역(바로 위 숫자 없는 머리 줄이 「유동」·「비유동」) — 꾸밈 없는 '리스부채'의 몫을 정할 때
  const sectionSide = (r) => {
    for (let q = r - 1; q >= 0; q -= 1) {
      if (R[q].some((c) => cellVal(c) != null)) continue;
      // 구역 머리 = 글자 칸 하나뿐인 줄(열 머리 「유동 | 비유동」 줄은 아님)
      if (new Set(t.rows[q].filter((c) => c && c.trim())).size !== 1) return null;
      const tx = t.rows[q].join("").replace(/\s/g, "");
      // 「비유동(성)」 = 비유동, 「유동성장기차입금:」 = 유동, 「장기차입금:」 = 비유동(005930 차입금 주석 — 두 구역에 '리스부채' 줄)
      if (/비유동/.test(tx)) return "non";
      if (/유동성/.test(tx)) return "cur";
      if (/장기/.test(tx)) return "non";
      if (/유동|단기/.test(tx)) return "cur";
      return null;
    }
    return null;
  };
  const items = (rows, off) => rows.map((r) => ({ label: rowLastText(t.rows[r]), v: cellVal(cellAt(R[r], off)), side: plainLease(rowLastText(t.rows[r])) ? sectionSide(r) : null }));
  // 합치기가 안 되면(합계·구성이 안 맞음) 리스 줄들 바로 뒤 합계 줄이 그 리스 줄들의 합과 같을 때만 그 합계(033100 「리스부채 61,246,132 · 유동성리스부채 181,400,575 ·
  // 합 계 242,646,707」 원) — 한 칸 합계
  const totalAfter = (rows, off) => {
    const lastR = Math.max(...rows);
    if (rows.length < 2 || rows.some((r, i) => i && r !== rows[i - 1] + 1) || lastR + 1 >= R.length) return null;
    if (!isTotalLabel(rowLastText(t.rows[lastR + 1]) ?? "")) return null;
    const tv = cellVal(cellAt(R[lastR + 1], off));
    const sum = rows.reduce((acc, r) => acc + (cellVal(cellAt(R[r], off)) ?? NaN), 0);
    return tv != null && tv > 0 && tv === sum ? tv : null;
  };
  // 잔액 열이 아닌 열(원리금·만기·할인 전·증감) — '당기말'·'전기말'·'제47(당)기말'은 잔액 열이라 지우지 않는다(감사 ⑥⑦)
  // 「기초·당기초·전기초」 열은 기간 말 잔액이 아니다(재감사 2026-10-22 새3 — 20200330002581 1116호 최초 적용 표 「당기초」 열을 당기말로 읽었다)
  const notBalanceCol = (h) => /유동|만기|최소|이내|이하|이상|초과|미만|개월|~|할인|계약상|현금흐름|리스료|원리금|증가|감소|이자|지급|상환|최초적용/.test(h) || /^(기초|기말)(잔액|금액|장부금액)?$/.test(h) || (/기초/.test(h) && !/기말/.test(h));
  const cols0 = [...Array(width).keys()].map((off) => ({ off, path: pathOf(off) }));
  // 만기·원리금 열이 있는 표(만기분석·할인 전 리스료)는 장부금액·현재가치 열만 잔액으로 본다(감사 2026-10-19 ⑦ — 「1년미만 | 1년~5년 | 합계」의 합계는 원리금)
  // 값 열(숫자 칸이 있는 열)의 머리만 본다 — 줄 이름 열 머리 「만기분석 할인되지 않은 계약상 현금흐름」(006400)은 열 성격이 아니다
  const valueCol = (off) => R.slice(first).some((row) => cellVal(cellAt(row, off)) != null);
  const maturity = cols0.some((c) => valueCol(c.off) && c.path.some((h) => /만기|이내|초과|미만|할인|계약상|리스료|원리금|\d+년/.test(h)));
  const cols = maturity ? cols0.map((c) => ({ ...c, bal: c.path.some((h) => /장부금액|현재가치/.test(h)) })) : cols0.map((c) => ({ ...c, bal: true }));
  // 변동표 근거 — 리스·재무활동 변동표에는 증가·지급·현금흐름 같은 열·줄이 있다. 「기초 | 증감 | 기말」뿐인 표(이연법인세 일시적차이 표와 같은 꼴)는 쓰지 않는다(감사 ⑥ D3)
  const MOVE_WORD = /증가|감소|지급|상환|이자|현금흐름|취득|신규|비현금|재무|대체|해지|처분/;
  const moveHead = cols0.some((c) => c.path.some((h) => MOVE_WORD.test(h)));
  const moveRows = t.rows.slice(first).some((row) => MOVE_WORD.test(rowLastText(row) ?? ""));
  const kiCol = cols.filter((c) => c.path.some((h) => /기초/.test(h) && !/기말/.test(h)));
  const kmCol = cols.filter((c) => c.path.some((h) => /기말/.test(h) && !/기초/.test(h)));
  // 표 주제(재감사 2026-10-21 ③) = 제목 마지막 번호 매김 뒤, 제목이 「당기 (단위 : 천원)」처럼 기간·단위뿐이면 표 앞 넓은 글자(앞 표 제목 「금융원가」 등을 잇는다 —
  // 009150 2023 금융원가 표 '리스부채' 2,365,348 천원이 잔액으로 읽혔다). 손익·특수관계자 거래·매각예정 표는 리스부채 잔액 표가 아니다
  const tclause = (t.title ?? "").split(/\(\d+\)|\d+\)|[①-⑳]/).at(-1) ?? "";
  // 앞 표 숫자 줄 뒤 글자만(「174,716 전기 (단위 : 백만원)」 — 000660 특수관계자 리스 표 전기판)
  const bareTitle = !tclause.replace(/\(?\s*단위\s*:[^)]*\)?/g, "").replace(/^[\s\S]*\d[\d,]*\s*/, "").replace(/(당|전)\s*(반|분)?\s*기\s*말?|[\s\-–②①③④⑤]/g, "");
  // 기간·단위뿐인 제목이면: ① 같은 제목 안 번호 매김 앞 문장(329180 「…리스부채의 계약에 따른 현금유출 시기는 다음과 같습니다.① 당기」) ② 그것도 없으면 바로 앞 표의 제목
  // (앞 「(단위 : …)」 표시 바로 앞 글자 — 000660 「특수관계자리스거래에 대한 공시 당기」)
  const lead = (t.title ?? "").slice(0, Math.max(0, (t.title ?? "").length - tclause.length)).replace(/\(?\s*단위\s*:[^)]*\)?/g, "").replace(/^[\s\S]*\d[\d,]*\s+(?=[^\d])/, "");
  const prevTitle = () => {
    const segs = (t.preWide ?? "").split(/\(\s*단위\s*:[^)]*\)/);
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const tail = segs[i].replace(/^[\s\S]*\d[\d,]*\s+(?=[^\d])/, "").slice(-120);
      if (tail.replace(/(당|전)\s*(반|분)?\s*기\s*말?|[\s\-–②①③④⑤]/g, "")) return tail;
    }
    return "";
  };
  // 문서 구조 주제(tablesOf subj)가 있으면 그것 — 없을 때(가상 표 등)만 앞 글자로
  const subject = t.subj != null && bareTitle ? t.subj : bareTitle ? (/[가-힣]{4,}/.test(lead) ? lead : prevTitle()) : tclause;
  // 문서 구조로 주제를 못 정한 표(기간 표시뿐이고 앞 표와 이름이 대응하지 않음)는 리스 후보가 아니다
  if (bareTitle && t.subj === "") return res;
  if (/특수관계|매각예정/.test(subject)) return res;
  // 이연법인세 변동표(일시적차이 '리스부채' 줄 — 060370 2022 기초 42,308 · 기말 63,833 천원)·법인세 표는 리스부채 잔액이 아니다
  if (/이연법인세|법인세|일시적\s*차이/.test(`${t.title ?? ""} ${t.pre ?? ""}`.slice(-160)) || R.slice(0, first).some((row) => row.some((c) => /당기손익|^자본$|이연법인세/.test(c.replace(/\s/g, ""))))) return res;
  // 표 주제 = 제목, 제목이 "- 당기 (단위: 천원)"처럼 잘렸으면 표 앞 마지막 완결 문장(앞 표의 숫자·다른 문단 낱말이 섞이지 않게 — 052690 재무활동 표 「① 당기」)
  const ps = (t.pre ?? "").split(/(?<=다\.)\s*/);
  // 그 문장 안에서도 마지막 번호 매김("(2)"·"2)"·"①") 뒤만 — 앞 표의 숫자 줄("리스부채의 유동성 대체 619,955 …")이 같은 문장으로 붙는다(052690 2022)
  const sentence = ((/다\.$/.test(ps.at(-1) ?? "") ? ps.at(-1) : ps.at(-2)) ?? "").split(/\(\d+\)|\d+\)|[①-⑳]/).at(-1) ?? "";
  const own = /리스부채/.test(t.title ?? "") || (/리스부채/.test(sentence) && /변동/.test(sentence));
  // 변동표(기초 → 기말) 한 쌍의 기간 — 같은 문서·범위의 바로 앞 변동표 기초 = 이 표 기말이면 이 표는 전기 표(051600 2021 보고서: 전기 변동표 머리도 "당기초·당기말",
  // 제목은 앞 표 숫자 줄). 그 밖은 제목의 기간 낱말, 없으면 당기
  const movement = (b, e, fm, prio) => {
    const hdr = kmCol.length === 1 ? perOfPath(kmCol[0].path) : null;
    const tp = prevPair && prevPair.b === e ? "prev" : hdr || titlePer || "cur";
    res.pair = { b, e };
    if (e > 0) out.push({ per: tp, v: e, form: `${fm} 기말${tp === "prev" ? "(전기 표)" : ""}`, prio });
    // 기초 칸은 앞 기간 잔액을 옮겨 적은 것이라 같은 표 종류의 기말보다 뒤(052690 2023 보고서 리스부채 변동표 기초 974,722 vs 전기 열 기말 974,721 천원)
    if (b > 0 && tp === "cur") out.push({ per: "prev", v: b, form: `${fm} 기초`, prio: prio + 0.2 });
  };
  // F4 머리 첫 칸이 '리스부채'인 표의 합계 줄(047810 「리스부채(*) | 당기말 | 전기말」 유동·비유동·합계)
  const headLease = R.slice(0, first).some((row) => isLeaseLabel(row.find((c) => c)));
  // F5 열 머리가 '리스부채'인 세로 변동표(047810 재무활동 부채 표: 열 단기차입금 … 리스부채, 줄 기초 … 기말)
  const leaseCol = cols.filter((c) => c.path.some((h) => isLeaseRow(h)));
  let f5bItems = null, f5eItems = null;
  const f1rows = [], f3rows = [];
  for (let r = first; r < R.length; r += 1) {
    const lab = rowLastText(t.rows[r]);
    const nl = (lab ?? "").replace(/\s/g, "");
    if (leaseCol.length >= 1 && leaseCol.length <= 3 && /^(기초|기말)(잔액|금액|장부금액)?$/.test(nl)) {
      const items = leaseCol.map((c) => ({ label: c.path.find((h) => isLeaseRow(h)) ?? "", v: cellVal(cellAt(R[r], c.off)) }));
      if (/^기초/.test(nl)) f5bItems = items; else f5eItems = items;
    }
    if (headLease && isTotalLabel(lab ?? "")) {
      for (const c of cols) {
        const p = perOfPath(c.path);
        if (!p || !c.bal || c.path.some(notBalanceCol)) continue;
        const v = cellVal(cellAt(R[r], c.off));
        if (v > 0) out.push({ per: p, v, form: "리스부채 표 합계", prio: 1 });
      }
    }
    // F3 가로 변동표 — 리스 줄이 여럿(리스부채·유동성 리스부채)이면 합을 끝에서 한 번에
    if (isLeaseRow(lab) && kmCol.length === 1 && kiCol.length === 1) {
      f3rows.push(r);
      continue;
    }
    // F1 — 리스 잔액 줄(유동성·비유동·장기 리스부채 포함)은 표 끝에서 한 번에 합친다(감사 ① — 229640 「리스부채」 969,507 은 비유동분, 같은 표 유동성리스부채와 함께)
    if (isLeaseLabel(lab) || isLeaseRow(lab)) f1rows.push(r);
    // F2
    if (own && /변동/.test(`${t.title ?? ""} ${sentence}`) && /^(기초|기말)(잔액|금액|장부금액)?$/.test(nl)) {
      const valCols = cols.filter((c) => cellVal(cellAt(R[r], c.off)) != null && !c.path.some((h) => /유동/.test(h)));
      if (valCols.length === 1) {
        // 값 열 하나 — 기초·기말 줄을 모아 아래에서 한 쌍으로
        const v = cellVal(cellAt(R[r], valCols[0].off));
        if (/^기초/.test(nl)) res.f2b = v; else res.f2e = v;
        continue;
      }
      for (const c of valCols) {
        const p = perOfPath(c.path);
        if (!p) continue;
        const v = cellVal(cellAt(R[r], c.off));
        if (!(v > 0)) continue;
        if (/^기말/.test(nl)) out.push({ per: p, v, form: "리스부채 세로 변동표 기말", prio: 2 });
        else if (p === "cur") out.push({ per: "prev", v, form: "리스부채 세로 변동표 기초", prio: 2.2 });
      }
    }
  }
  // 손익 표(이자비용·금융원가·손익 내역 — 052690 「금융원가에 포함된 이자비용의 내역」 리스부채 39,403 천원)는 잔액이 아니다
  // 제목(표 앞 마지막 문장)만 본다 — 앞 표의 숫자 줄 낱말(「리스 관련 비용 … 합 계」 — 006400)이 섞이지 않게
  // 「이자부 금융부채」는 잔액 표 — 이자비용·이자수익·이자 지급 등만 손익
  const pnl = /이자\s*(비용|수익|지급|수취)|손익|수익|비용|원가/.test(subject);
  // 상환계획·만기 표(줄 이름에 「1년 이내」 등)는 잔액 줄로 읽지 않는다(장부금액·현재가치 열이 있으면 그 열만 — 위 maturity)
  // 만기 표 판정은 「N년·N개월」 구간 줄만(재감사 ① — 「초과청구공사」의 「초과」를 만기 표로 봤다, 103590 2022)
  const schedule = /상환|만기|원리금/.test(tclause) || t.rows.slice(first).some((row) => /\d+\s*개월|\d+\s*년\s*(이내|이하|이상|초과|미만)|\d+\s*~\s*\d+\s*년|^\d+\s*년$/.test(rowLastText(row) ?? ""));
  // 만기 표 안이라도 「(연결)재무상태표에 인식된 리스부채」 줄은 잔액(006400 만기분석 표)
  if (schedule && !maturity) f1rows.splice(0, f1rows.length, ...f1rows.filter((r) => /재무상태표(에|상)인식된리스부채/.test((rowLastText(t.rows[r]) ?? "").replace(/\s/g, ""))));
  if (f1rows.length && !res.pair && !pnl) {
    for (const c of cols) {
      if (!c.bal || c.path.some(notBalanceCol)) continue;
      // 열 머리에 기간이 없으면 제목의 기간(062040 만기분석 「② 전기말」 — 감사 ④)
      const pp = perOfPath(c.path);
      const p = pp === null ? titlePer : pp;
      if (!p) continue;
      let cb = combine(items(f1rows, c.off));
      if (!cb) { const tv = totalAfter(f1rows, c.off); if (tv != null) cb = { v: tv, n: 1, single: true, total: true }; }
      if (!cb || !(cb.v > 0)) continue;
      // 한 칸 = 순위 1, 여러 칸 합(반올림된 칸들의 합) = 순위 2.5 — 한 칸 합계인 변동표 기말(순위 2)보다 뒤(001440 2020 변동표 기말 2,962 vs 2,148 + 815 = 2,963)
      out.push({ per: p, v: cb.v, form: cb.single ? (cb.total ? "리스부채 합계 줄" : "리스부채 줄") : `리스부채 줄 ${cb.n}개 합`, prio: cb.single ? 1 : 2.5 });
    }
  }
  if (f3rows.length && (moveHead || own)) {
    // 리스부채 전용 변동표(제목에 리스부채) = 순위 2, 재무활동 부채 조정표 등 다른 가로 변동표 = 순위 3(리스 관련 기타 변동이 섞일 수 있다 — 103590 2022 재무활동 표
    // 기말 915,390 vs 리스부채 변동표 864,147 천원). 리스 줄이 여럿이면 합계 줄이 있을 때 합계만(감사 ② — 합계 줄 + 구성 줄을 2배로 더했다)
    const ce = combine(items(f3rows, kmCol[0].off));
    const tot = !ce && totalAfter(f3rows, kmCol[0].off) != null ? f3rows.at(-1) + 1 : null; // 리스 줄들 바로 뒤 합계 줄
    if (ce || tot != null) {
      const pick = tot != null ? [tot] : ce.total ? f3rows.filter((r) => plainLease(rowLastText(t.rows[r])) && !sectionSide(r)) : f3rows;
      // 합계 줄을 쓰면 열마다 따로 확인 — 그 열에서도 합계 = 리스 줄 합일 때만(재감사 2026-10-22 새2 — 20240319000759 기초 열 합계 10,082,926 에 유동성장기차입금 포함)
      const sumAt = (off) => { if (tot != null && totalAfter(f3rows, off) == null) return null; const vs = pick.map((r) => cellVal(cellAt(R[r], off))); return vs.some((x) => x == null) ? null : vs.reduce((acc, x) => acc + x, 0); };
      // 리스 줄 여럿을 더한 값(반올림된 칸들의 합)은 같은 표 종류의 한 칸 값보다 뒤(+0.5)
      movement(sumAt(kiCol[0].off), sumAt(kmCol[0].off), (own ? "리스부채 가로 변동표" : "재무활동 부채 변동표") + (pick.length > 1 ? `(리스 줄 ${pick.length}개 합)` : ""), (own ? 2 : 3) + (pick.length > 1 ? 0.5 : 0));
    }
  }
  if (!res.pair && f5eItems && moveRows) {
    const ce = combine(f5eItems);
    if (ce) {
      const sel = (items) => (ce.total ? items.filter((x) => plainLease(x.label)) : items);
      const sum = (items) => (items && !items.some((x) => x.v == null) ? sel(items).reduce((acc, x) => acc + x.v, 0) : null);
      movement(sum(f5bItems), sum(f5eItems), (own ? "리스부채 세로 변동표(열)" : "재무활동 부채 변동표(열)") + (ce.single ? "" : `(리스 열 ${ce.n}개 합)`), (own ? 2 : 3) + (ce.single ? 0 : 0.5));
    }
  }
  if (!res.pair && res.f2e != null && moveRows) movement(res.f2b, res.f2e, "리스부채 세로 변동표", 2);
  return res;
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
    const vals = faceDebtRows(r?.rows ?? []).map((x) => ({ v: amt(x[col]), name: x.account_nm }));
    for (const rc of rcpMemo[ry] ?? [rcp]) {
      const hs = leaseInFaceTableAll(await docTexts(rc), vals, "lease", "본표 차입금", { pairs: true, per: ry === y ? "cur" : "prev" });
      // leaseIn = 본표 차입금 줄 안에서 확인된 리스 줄 금액 합(본표 줄마다 — "빠진 만큼만 더한다", 오너 결정 1 = A 2026-10-19)
      if (hs.length) return (confMemo[key] = { text: `${hs[0].text}(${rc}, ${y} 열)`, leaseIn: hs.reduce((a, h) => a + h.leaseWon, 0), tol: hs.reduce((a, h) => a + h.u / 2, 0), rows: hs.map((h) => h.leaseWon) });
    }
    return (confMemo[key] = null);
  };
  // ⑪(감사 2026-10-19) 회계정책 문장이 본표 차입금 포함이라 하는데 차입금 주석으로 리스를 확인 못 한 해 — 가산은 ⓐ 리스가 다른 부채 줄(기타금융부채·매입채무 등)의
  // 주석 묶음 안에 있음을 확인했거나 ⓑ 정책이 가리킨 본표 차입금 줄마다 리스 줄 없는 주석 묶음 합계 = 본표 줄일 때만. 둘 다 아니면 null(가산 안 함 — 이중 계산 위험)
  const outMemo = {};
  const outsideOf = async (ry, y, hitNames) => {
    const key = `${ry}|${y}|${hitNames.join(",")}`;
    if (key in outMemo) return outMemo[key];
    const col = ry === y ? "thstrm_amount" : ry === y + 1 ? "frmtrm_amount" : null;
    const r = col ? await fnlttBs(corp, ry) : null;
    if (!r) return (outMemo[key] = null);
    const nm = (x) => (x.account_nm ?? "").replace(/\s/g, "");
    const other = r.rows.filter((x) => /부채|채무/.test(nm(x)) && !faceDebtRows([x]).length && !/총계|합계|^(유동|비유동)?부채$|리스|충당|법인세|확정급여|이연/.test(nm(x)));
    for (const rc of rcpMemo[ry] ?? []) {
      const texts = await docTexts(rc);
      // 비교 대상은 본표 한 줄씩(두 줄 합 금지 — 감사 ⑪)
      const per = ry === y ? "cur" : "prev";
      // 같은 이름 바탕의 유동·비유동 두 줄(기타금융부채 + 기타비유동금융부채 — 298040 「소계」 30,027 백만원)은 그 짝 합으로도
      const byBase = new Map();
      for (const x of other) { const b = nm(x).replace(/(유동성|유동|비유동)/g, ""); (byBase.get(b) ?? byBase.set(b, []).get(b)).push(x); }
      const a = [...byBase.entries()].flatMap(([b, xs]) => leaseInFaceTableAll(texts, xs.map((x) => ({ v: amt(x[col]), name: x.account_nm })), "lease", `본표 '${xs.map(nm).join("'+'")}'`, { pairs: false, natPairs: true, name: b, per }));
      if (a.length) return (outMemo[key] = { text: `리스부채는 차입금 밖 — ${a[0].text}(${rc}, ${y} 열)` });
      // 「정책이 가리킨 차입금 줄에 리스 없음」 확인 경로는 뺐다 — 흔든 값 시험에서 우연 일치(229640 반올림된 본표 값)가 남았고 30종목에서 쓰인 곳이 없었다
    }
    return (outMemo[key] = null);
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
  // 원문 주석 리스부채(오너 결정 1 = A) — 그 해 보고서(당기 열)와 다음 해 보고서(전기 열)가 **같은 값**을 보일 때만(이웃 보고서 대조 = 표 확인)
  const docLeaseMemo = {};
  const docLeaseOf = async (y) => {
    if (y in docLeaseMemo) return docLeaseMemo[y];
    let want = sepOf[y] ? "sep" : "con";
    // 연결 줄인데 그 해를 담은 사업보고서가 별도뿐인 해(062040 2023 — 2024 사업보고서는 별도만, 2025 연결 보고서 전전기 열 = 별도와 같은 값, 종속기업 2025 설립):
    // 그 해 연결 자산총계 = 별도 자산총계(원 단위 정확히)일 때만 별도 주석을 같은 실체로 본다
    let sameEntity = null;
    if (want === "con") {
      const rNext = y + 1 <= latest ? await fnlttBs(corp, y + 1) : null;
      if (rNext?.fs === "OFS") {
        const total = (rows, col) => amt(rows.find((x) => x.account_id === "ifrs-full_Assets" || /^자산총계$/.test((x.account_nm ?? "").replace(/\s/g, "")))?.[col]);
        let con = null;
        for (const [ry2, col] of [[y + 2, "bfefrmtrm_amount"], [y + 1, "frmtrm_amount"], [y, "thstrm_amount"]]) {
          if (ry2 > latest) continue;
          const r2 = await fnlttBs(corp, ry2);
          if (r2?.fs === "CFS" && total(r2.rows, col) != null) { con = total(r2.rows, col); break; }
        }
        const sep = total(rNext.rows, "frmtrm_amount");
        if (con != null && sep != null && con === sep) { want = "sep"; sameEntity = `연결 자산총계 = 별도 자산총계 ${con.toLocaleString("en-US")}원(그 해 사업보고서가 별도뿐)`; }
      }
    }
    const seen = []; // { ry, rc, won, u, form }
    for (const [ry, per] of [[y, "cur"], [y + 1, "prev"]]) {
      if (ry > latest) continue;
      for (const rc of await rcpsOf(ry)) {
        let tables;
        try { tables = tablesOf(await docTexts(rc)); } catch (e) { console.log(`    (리스 원문 ${rc} 읽기 실패: ${e.message})`); continue; }
        const last = {};
        for (const t of tables) {
          if (t.scope !== want || t.face) continue;
          const k = `${t.file}|${t.scope}`;
          const r0 = leaseCellsOf(t, last[k] ?? null);
          if (r0.pair) last[k] = r0.pair;
          // sig = 표 내용 표시(첫 숫자 줄까지) — 같은 주석 표를 본문·감사보고서가 다시 실은 것은 같은 표로 본다
          const sig = t.rows.slice(0, 4).map((r) => r.join("|")).join("/");
          for (const c of r0.cells) if (c.per === per) seen.push({ ry, rc, won: c.v * t.u, u: t.u, form: c.form, v: c.v, prio: c.prio, sig });
        }
      }
    }
    // 교차 확인(감사 ①): 순위 1(리스부채 한 줄) 값이 같은 문서·같은 기간의 변동표 기말과 표 단위 1 넘게 다르면 그 순위 1 값은 쓰지 않는다(일부만 담은 줄 — 103590 2022
    // 「기타부채」 리스부채 545,733 = 유동분, 변동표 기말 864,147 천원). 1 단위 차이는 반올림(006400 2021 38,561,071 vs 재무활동 38,561,072)
    const dropped = crossDropPrio1(seen);
    const groups = [];
    for (const c of seen) {
      const g = groups.find((x) => Math.abs(x.won - c.won) <= Math.max(x.u, c.u) / 2);
      if (g) { g.items.push(c); if (c.u < g.u) { g.u = c.u; g.won = c.won; } } else groups.push({ won: c.won, u: c.u, items: [c] });
    }
    // 표 종류 순위(리스부채 줄 1 > 리스부채 변동표 2 > 재무활동 부채 조정표 3) — 그 해·다음 해 보고서가 같은 값을 보이는 묶음 중 가장 높은 순위 것만. 원문끼리 1단위
    // 갈리면(103590 2021 리스부채 변동표 기말 1,964,406 vs 재무활동 표 기초·만기분석 합계 1,964,405 천원) 순위로 정한다
    // 그 해 사업보고서가 없는 해(상장 첫 보고서의 전기 — 062040 2023)는 다음 해 보고서 안 서로 다른 주석 표 둘 이상이 같은 값일 때(이웃 보고서 대조 대신)
    const noOwn = !(await rcpsOf(y)).length;
    let supported = groups
      // 그 해·다음 해 보고서가 같은 값(이웃 보고서 대조)
      .filter((g) => new Set(g.items.map((i) => i.ry)).size === 2)
      .map((g) => ({ ...g, prio: Math.min(...g.items.map((i) => i.prio ?? 9)) }));
    let noOwnNote = "";
    if (noOwn && !supported.length) {
      // 그 해 보고서가 없는 해(062040 2023)는 다음 해 보고서 안 서로 다른 표 둘 이상(감사 ⑤ — 같은 표의 당기 기초 = 전기 기말, 원본·정정본의 같은 표는 독립 확인이 아니다).
      // 표마다 반올림이 달라 칸 하나 값끼리 표 단위 1~2 갈리면(변동표 880,631 · 만기분석 장부금액 880,632 · 재무활동 리스 열 합 880,633 천원) 표 단위 2 안을 한 무리로 보고
      // 그 안에서 순위가 가장 높은 칸 값을 쓰되, 갈린 값을 사유에 남긴다
      const sorted = [...seen].sort((a, b) => (a.prio ?? 9) - (b.prio ?? 9));
      for (const lead of sorted) {
        const near = seen.filter((c) => Math.abs(c.won - lead.won) <= 2 * Math.max(c.u, lead.u));
        if (new Set(near.map((c) => c.sig)).size < 2) continue;
        const best = near.filter((c) => (c.prio ?? 9) === Math.min(...near.map((x) => x.prio ?? 9)));
        if (new Set(best.map((c) => c.won)).size !== 1) break;
        supported = [{ won: best[0].won, u: best[0].u, items: [...best, ...near.filter((c) => !best.includes(c))], prio: best[0].prio ?? 9 }];
        const vals = [...new Set(near.map((c) => c.won))];
        if (vals.length > 1) noOwnNote = ` · 다음 해 보고서 안 표마다 칸 값 갈림(${[...new Map(near.map((c) => [c.won, `${c.won.toLocaleString("en-US")}(${c.form})`])).values()].join("·")}) — 순위가 가장 높은 칸 값`;
        break;
      }
    }
    const top = supported.length ? Math.min(...supported.map((g) => g.prio)) : null;
    const ok = supported.filter((g) => g.prio === top);
    const others = supported.filter((g) => g.prio !== top);
    const desc = (g) => [...new Map(g.items.map((i) => [`${i.rc}|${i.form}`, `${i.rc} ${i.form} ${i.v.toLocaleString("en-US")}(단위 ${i.u}원)`])).values()].slice(0, 4).join(" = ");
    // 칸 하나 값끼리 갈리는 경우(062040 2023 변동표 880,631 · 만기분석 장부금액 880,632 · 재무활동 합 880,633 천원) — 고른 값과 표 단위 3 이내로 다른 값을 사유에 남긴다
    // 고른 값과 같은 금액(표 단위만 다른 같은 칸)은 빼고, 금액마다 한 번만(재감사 ④ — 「갈림: 864,147,000」에 고른 값 자신이 들어갔다)
    const near = (g) => [...new Map(groups.filter((x) => x !== g && x.won !== g.won && Math.abs(x.won - g.won) > Math.max(x.u, g.u) / 2 && Math.abs(x.won - g.won) <= 3 * Math.max(x.u, g.u)).map((x) => [x.won, `${x.won.toLocaleString("en-US")}(${x.items[0].form})`])).values()];
    let r;
    if (ok.length === 1) r = { amount: ok[0].won, how: `리스부채: 사업보고서 원문 주석 — ${desc(ok[0])}${near(ok[0]).length ? ` · 원문 칸 값 갈림: ${near(ok[0]).join("·")}` : ""}${dropped.length ? ` · 변동표 기말과 다른 리스부채 한 줄 ${[...new Set(dropped.map((d) => d.won.toLocaleString("en-US")))].join("·")} 은 일부만 담은 줄로 보고 뺌` : ""} (${noOwn ? `그 해 보고서 없음 — 다음 해 보고서 안 서로 다른 표 확인${noOwnNote}` : "그 해·다음 해 보고서 같은 값"}, ${want === "con" ? "연결" : "별도"}${sameEntity ? ` — ${sameEntity}` : ""})${others.length ? ` · 낮은 순위 표 값 ${others.map((g) => `${g.won.toLocaleString("en-US")}(${g.items[0].form})`).join("·")} 은 쓰지 않음` : ""}` };
    else if (ok.length > 1) r = { amount: null, how: `원문 주석 리스부채 후보가 여럿(${ok.map((g) => g.won.toLocaleString("en-US")).join("·")}원) — 정하지 않음` };
    else r = { amount: null, how: seen.length ? `원문 주석 리스부채가 그 해·다음 해 보고서에서 같은 값으로 확인되지 않음(${[...new Set(seen.map((c) => `${c.rc} ${c.form} ${c.won.toLocaleString("en-US")}`))].slice(0, 3).join(", ")})` : "원문 주석 리스부채 표 없음" };
    return (docLeaseMemo[y] = r);
  };
  const faceDebtOfReport = {};
  const leaseNote = {};
  for (const y of years) {
    if (faceLease[y] !== false) continue; // 본표에 리스 줄이 있거나 그해 재무상태표 없음
    const tried = [];
    let note = null, blocked = false, outsideWhy = null;
    for (const [ry, prefix] of [[y, `CFY${y}eFY`], [y + 1, `PFY${y}eFY`]]) {
      if (ry > latest) continue;
      const rcp = await rcpOf(ry);
      if (!rcp) continue;
      const names = await polOf(rcp);
      // 정책 문장의 줄 이름은 그 보고서 본표의 차입금 줄과 맞춘다(103590: 2022 보고서 "장기차입금", 2024 보고서는 줄 이름을 바꿨다)
      if (names.length && !(ry in faceDebtOfReport)) faceDebtOfReport[ry] = faceNames((await fnlttBs(corp, ry))?.rows ?? []);
      const hit = names.filter((n) => (faceDebtOfReport[ry] ?? []).some((f) => f.includes(n) || n.includes(f)));
      const L = leaseAmountOf(await xmlOf(rcp), prefix, sepOf[y]);
      // ⑩(감사 2026-10-19) 회계정책 문장이 없어도 차입금 주석 표에 리스 줄이 있고 그 묶음 합계 = 본표 차입금 줄(또는 두 줄 합)이면 포함(178320 2021 「장기리스부채」)
      const conf = await confirmOf(ry, rcp, y);
      if (conf) {
        // 확인된 리스 줄 합과 총액의 차이만 더하는 부분 가산은 쓰지 않는다 — 확인 묶음이 본표 줄 하나뿐인 해가 있어(178320 2024 '장기리스부채' 13,162,763 천원만 확인)
        // 차이를 "빠진 리스"로 볼 근거가 없다
        note = { status: "included", amount: L.amount, how: hit.length ? `회계정책 주석: 리스부채를 본표 '${hit.join("'·'")}'에 포함(사업보고서 ${rcp}) — 금액 확인: ${conf.text}` : `차입금 주석 표에 리스 줄 포함(회계정책 문장 없음, 사업보고서 ${rcp}) — ${conf.text}` };
        break;
      }
      let outside = null;
      if (hit.length) {
        // 그 해 보고서에서 못 정하면 다음 해 보고서 전기 열로도(103590 2020 — 2021 보고서 「유동기타부채」 주석 묶음에 리스부채)
        outside = await outsideOf(ry, y, hit);
        if (!outside && ry === y && y + 1 <= latest) { await rcpsOf(y + 1); outside = await outsideOf(y + 1, y, hit); }
        if (!outside) {
          tried.push(`${rcp}: 회계정책 문장('${hit.join("'·'")}')은 본표 차입금 포함이나 주석 표로 확인 못 함 — 이중 계산 위험으로 가산 안 함`);
          blocked = true;
          continue;
        }
      }
      if (L.amount != null && (await unitBad(ry))) { tried.push(`${rcp}: 단위 오류 보고서(${unitBad.why[ry]}) — 건너뜀`); continue; }
      if (L.amount != null) { note = { status: "added", amount: L.amount, how: `사업보고서 ${rcp} XBRL 주석 ${prefix} — ${L.how}${outside ? ` · ${outside.text}` : ""}` }; break; }
      tried.push(`${rcp}: ${L.how}`);
      if (outside) outsideWhy = outside.text;
    }
    // 사업보고서 XBRL 에 리스부채 주석 태그가 없는 해 — 공시 원문 주석 표(오너 결정 1 = A, 2026-10-19). 회계정책상 포함인데 확인 못 한 해는 가산하지 않는다
    if (!note && (!blocked || outsideWhy)) {
      const d = await docLeaseOf(y);
      if (d.amount != null) note = { status: "added", amount: d.amount, how: `${d.how}${outsideWhy ? ` · ${outsideWhy}` : ""}` };
      else tried.push(d.how);
    }
    if (note?.status === "added" && blocked && !outsideWhy && !/차입금 밖|리스 없음/.test(note.how)) note = null;
    leaseNote[y] = note ?? { status: "unknown", amount: null, how: tried.join(" / ") || "사업보고서 없음" };
  }
  // 분기말 회계정책 — 최근 사업보고서(포함이 아니면 아래 leaseQuarterOf 가 분기 보고서 원문 주석으로). 본표에 리스 줄이 있으면 필요 없음
  let leasePolicyLatest = null;
  const latestRcp = await rcpOf(latest);
  if (latestRcp && faceLease[latest] === false) {
    const names = await polOf(latestRcp);
    if (names.length && !(latest in faceDebtOfReport)) faceDebtOfReport[latest] = faceNames((await fnlttBs(corp, latest))?.rows ?? []);
    const hit = names.filter((n) => (faceDebtOfReport[latest] ?? []).some((f) => f.includes(n) || n.includes(f)));
    const conf = await confirmOf(latest, latestRcp, latest);
    const outside = hit.length && !conf ? await outsideOf(latest, latest, hit) : null;
    leasePolicyLatest = conf
      ? { status: "included", amount: null, how: hit.length ? `회계정책 주석: 리스부채를 본표 '${hit.join("'·'")}'에 포함(사업보고서 ${latestRcp}) — 금액 확인: ${conf.text}` : `차입금 주석 표에 리스 줄 포함(회계정책 문장 없음, 사업보고서 ${latestRcp}) — ${conf.text}` }
      : { status: "unknown", amount: null, blocked: hit.length > 0 && !outside, how: hit.length ? `최근 사업보고서 ${latestRcp} 회계정책 문장('${hit.join("'·'")}')은 본표 차입금 포함이나 주석 표로 확인 못 함${outside ? ` · ${outside.text}` : " — 분기말 리스부채 가산 안 함(이중 계산 위험)"}` : `최근 사업보고서 ${latestRcp} 회계정책에 차입금 포함 문장 없음 · 차입금 주석 표에 리스 줄 없음` };
  }
  // 분기말 — 회계정책이 포함이 아니면 최신 분기·반기 보고서 원문 주석(leaseQuarterOf)
  const leaseQuarter = leasePolicyLatest?.status === "unknown" && !leasePolicyLatest.blocked ? await leaseQuarterOf(corp, latest, leaseNote[latest], sepOf[latest]) : null;
  if (leasePolicyLatest) delete leasePolicyLatest.blocked;
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
const CASH_EXC = /대여|보증금|미수|파생|확정계약|선급|대출|매출채권|리스채권|지분증권|지분상품|주식|출자|임차|수취채권|기타채권|미청구|대손|선물환|통화스왑|기타포괄손익/;
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
  // 정기보고서 본문 단원 표시(AASSOCNOTE "D-0-3-K-…": III 재무에 관한 사항의 K 번째 단원). 2·3 = 연결재무제표·주석, 4·5 = 재무제표·주석, 그 밖 단원(6 배당·8 기타 재무·
  // IV 경영진단 등)은 범위를 정하지 않는다(감사 2026-10-19 ③ — 「5. 재무제표 주석」 뒤 단원까지 별도로 봤다). 단원 표시가 없는 주석 소제목은 앞 단원을 잇고
  // 「… (연결)」 소제목만 연결
  for (const m of x.matchAll(/<TITLE([^>]*)>([^<]*)<\/TITLE>/g)) {
    const t = m[2].replace(/\s+/g, " ").trim();
    const code = /AASSOCNOTE="([^"]+)"/.exec(m[1])?.[1];
    if (code) {
      const k = /^D-0-3-(\d+)-/.exec(code)?.[1];
      marks.push([m.index, k === "2" || k === "3" ? "con" : k === "4" || k === "5" ? "sep" : null]);
      continue;
    }
    if (/\(연결\)\s*$/.test(t) || /^\d+(-\d+)?\.\s*연결\s*재무제표(\s*주석)?$/.test(t)) marks.push([m.index, "con"]);
    else if (/^\d+(-\d+)?\.\s*재무제표(\s*주석)?$/.test(t)) marks.push([m.index, "sep"]);
    else if (/^[IVX]+\.\s/.test(t)) marks.push([m.index, null]);
  }
  return (pos) => { let s = null; for (const [i, k] of marks) { if (i > pos) break; s = k; } return s; };
}
/** 표 앞 글자에서 표 제목 — 마지막 문장 끝 뒤 글자(없으면 마지막 문장). 앞 문단의 낱말(“…보증금에 포함…”)이 섞이지 않게 */
const titleOf = (b) => {
  const ps = b.split(/(?<=다\.|\)\.|다\))\s*/);
  const last = ps.at(-1).trim();
  // 마지막 조각이 단위 표시뿐이면("…변동내역은 다음과 같습니다. (단위: 백만원)") 앞 문장을 붙인다
  if (!last.replace(/\(?\s*단위\s*:[^)]*\)?/g, "").trim()) return `${(ps.at(-2) ?? "").trim()} ${last}`.trim();
  return last;
};
/** 원문 표 → [{ u, rows: [[칸 글자]], rowsX(병합 칸을 펼친 줄), scope, title, face }] (표 단위를 못 읽으면 뺀다) */
function tablesOf(texts) {
  const out = [];
  for (const [file, x] of texts.entries()) {
    const scopeAt = scopeIndex(x);
    let prevTitle = "";
    // 문서 구조로 정한 표 주제(재감사 2026-10-22 ③): 앞 숫자 표가 끝난 뒤부터 이 표 앞까지의 글(문단·제목 + 「당기 (단위 : 백만원)」 같은 제목용 작은 표)을
    // 이 표의 머리로 본다. 머리의 마지막 번호 매김 뒤가 기간·단위뿐이면 ① 같은 머리 안의 「…다음과 같습니다.」 문장 ② 없으면 앞 숫자 표의 주제를 잇는다
    // (329180 2024 「특수관계자리스거래에 대한 공시 당기」 표 다음 「전기 (단위 : 백만원)」 표, 009150 반기 「금융원가」 표 「전반기」). 글자 수로 자르지 않는다
    let lastEnd = 0, capBuf = "", prevSubj = "", prevSig = null, prevPer = null;
    // 머리 글의 기간 — 기간 낱말이 한 가지일 때만(「당기」·「리스부채의 내역 당기」 = 당기, 「당기말과 전기말 …」 = 정하지 않음)
    const perOfClause = (c) => { const ks = [...new Set([...(c ?? "").matchAll(PERIOD_RE_G)].map((mm) => periodWord(mm[0])))]; return ks.length === 1 ? ks[0] : null; };
    for (const m of x.matchAll(/<TABLE[\s\S]*?<\/TABLE>/gi)) {
      const gapText = clean(x.slice(lastEnd, m.index));
      lastEnd = m.index + m[0].length;
      const head = `${capBuf} ${gapText}`.trim();
      const tableText = clean(m[0]);
      // 제목용 표 = 숫자 칸이 하나도 없는 표(「당기 | (단위 : 백만원)」·문단을 담은 틀 표 「(3) 특수관계자와의 주요 채권ㆍ채무 내역 … 다음과 같습니다.」 — 034020)
      const caption = tableText.length <= 1500 && ![...m[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].some((c) => cellVal(clean(c[1]).replace(/　/g, "").trim()) != null);
      let subj = null;
      if (caption) capBuf = `${head} ${tableText}`.trim();
      else {
        capBuf = "";
        const h = head.replace(/\(?\s*단위\s*:[^)]*\)?/g, " ").replace(/\s+/g, " ").trim();
        // 마지막 문장(앞 문단의 각주 「(*) … 비용(매출원가)으로 인식한 금액은 …입니다.」가 섞이지 않게) → 그 안의 마지막 번호 매김 뒤
        const sents = h.split(/(?<=다\.|\)\.|다\))\s*/).filter((x) => x.trim());
        const last = sents.at(-1) ?? "";
        const parts = last.split(/\(\d+\)|\d+\)|[①-⑳]/);
        const clause = (parts.at(-1) ?? "").trim();
        if (bareSubject(clause)) {
          const lead = parts.slice(0, -1).join(" ").trim();
          const prevSent = sents.at(-2) ?? "";
          // 표를 여는 문장 — 「다음과·아래와·다음 표와 같습니다/같음/같다」
          const intro = (x) => /(다음|아래)\s*(표\s*)?(와|과)?\s*같\s*(습\s*니\s*다|음|다)/.test(x);
          // ① 같은 문장 안 번호 매김 앞 제목(「15. 매입채무 및 기타금융부채 (1) 당기」) ② 앞 문장이 표를 여는 문장이면 그 문장
          // ③ 그 밖에는 앞 숫자 표와 줄·열 이름이 대응할 때만 앞 표 주제를 잇는다(재감사 2026-10-23 — 문장 꼴로 가르면 「당기 중 리스부채에 대한 이자비용을
          //    금융원가로 인식하였습니다.」·각주·「가)」·「-」 머리 같은 빈틈이 계속 남았다). 당기 리스 표 뒤 전기 리스 표는 줄 이름이 같아 잇고, 이자비용·매각예정·
          //    특수관계자 표는 줄 이름이 달라 잇지 않는다 — 대응이 없으면 주제 없음(리스 후보 아님, leaseCellsOf)
          const sig = tableSig(m[0]);
          // ④ 그것도 아니면 표 자신의 머리 칸(첫 숫자 줄 위)에 「리스부채」가 있을 때 그 머리 글(「구분 | 당기말 | 전기말 // 리스부채」·「차입금 | 사채 | 리스 부채」 — 앞 표가
          //    사용권자산 표라 대응이 없는 리스 표)
          const hd = tableHead(m[0]);
          // ③ 은 「기간 짝」일 때만(재감사 2026-10-23 — 각주 꼴 손익 문장 뒤 같은 「당기」 표가 줄 이름만 겹쳐 이어받았다): 앞 숫자 표 머리에 기간이 하나 있고
          //    이 표 기간이 그 짝(당기 ↔ 전기)이고 줄 이름이 대응할 때. 같은 기간이 반복되거나 앞 표 머리에 기간이 없으면 잇지 않는다
          // ③ 앞: 앞 숫자 표와 이 표 사이 글(각주 포함) 어느 문장에든 손익·특수관계자·매각예정 낱말이 있으면 잇지 않는다
          // (재감사 2026-10-23 — 「(1) 차입금 및 리스부채의 내역」 표 뒤 「당기 중 발생한 이자비용은 금융원가로 인식하였습니다.」 + 손익 표가 줄 이름이 겹쳐 앞 주제를 이었다)
          // 각주도 예외 없이(재감사 2026-10-26 — 「(*) 당기 중 발생한 이자비용은 …」 각주 뒤 「전기」 표가 기간 짝·줄 이름 대응으로 이어받았다)
          const gapOwn = sents.slice(0, -1).some((x) => /이자\s*(비용|수익|지급|수취)|손익|수익|비용|원가|특수관계|매각예정/.test(x));
          // ②' 이 표 앞 글(앞 숫자 표 뒤부터)에 표를 소개하는 문장(「다음 표는 … 나타내고 있습니다.」)이 있으면 그 문장부터 끝까지(062040 유동성위험 만기표 — 소개 문장 뒤에
          //     설명 문장이 두 개 더 있다)
          const ii = sents.slice(0, -1).findLastIndex((x) => intro(x) || /(다음|아래)\s*표[는은]/.test(x));
          // ④' 줄 이름이 전부 리스부채 줄(유동·비유동 리스부채·합계)인 표는 그 자체로 리스부채 표(XBRL 「| 공시금액 // 유동 리스부채 // 비유동 리스부채 // 합계」)
          const rl = tableRowLabels(m[0]);
          const pureLease = rl.length >= 1 && rl.every((x) => /리스\s*부채/.test(x) && !/이자|비용|수익|손익|현금유출|지급|특수관계/.test(x));
          subj = lead && !bareSubject(lead) && !/다\.$/.test(lead) ? lead.slice(-200) : !lead && intro(prevSent) ? prevSent.trim().slice(-200) : !lead && ii >= 0 ? sents.slice(ii, -1).join(" ").slice(-300) : prevPer && perOfClause(clause) && perOfClause(clause) !== prevPer && sigMatch(prevSig, sig) && !gapOwn ? prevSubj : /리스\s*부채/.test(hd) ? `${prevSent} ${hd}`.trim().slice(-300) : pureLease ? `${prevSent} ${rl.join(" · ")}`.trim().slice(-300) : "";
          // (④·④' 은 표 앞 문장을 주제에 붙인다 — 「당기 중 특수관계자 채권채무를 보유…」·「…매각예정으로 분류하였습니다.」 뒤 리스부채 표는 손익·특수관계자·매각예정 거르기에 걸린다)
        } else subj = clause.slice(-200);
        prevSubj = subj;
        prevSig = tableSig(m[0]);
        prevPer = perOfClause(clause);
      }
      // 「전기 (단위 : 원)」처럼 기간 낱말뿐인 제목은 바로 앞 표의 제목을 이어받는다(XBRL 표 — "…의 내역 당기" 다음 표가 "전기"만)
      // 표 앞 글자 — 잘린 자리의 반쪽 태그(「IDTH="600">」 — 000660 특수관계자 표 제목이 기간뿐인 줄 모르게 했다)는 떼고
      const textBefore = (n) => clean(x.slice(Math.max(0, m.index - n), m.index).replace(/^[^<]*>/, ""));
      let title = titleOf(textBefore(600).slice(-200));
      if (/^(당|전)\s*(반|분)?\s*기\s*말?\s*(\(단위[^)]*\))?$/.test(title) && prevTitle) title = `${prevTitle.replace(/(당|전)\s*(반|분)?\s*기\s*말?\s*(\(단위[^)]*\))?$/, "").trim()} ${title}`;
      prevTitle = title;
      const inTab = clean(m[0].slice(0, 2000)).match(UNIT_RE)?.[1];
      const before = [...clean(x.slice(Math.max(0, m.index - 1500), m.index)).matchAll(new RegExp(UNIT_RE.source, "g"))].at(-1)?.[1];
      const u = UNIT[inTab ?? before];
      if (!u) continue;
      const trs = [...m[0].matchAll(/<TR[\s\S]*?<\/TR>/gi)].map((r) => [...r[0].matchAll(/<T[DHEU]([^>]*)>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => ({ t: clean(c[2]).replace(/　/g, "").trim(), span: Number(/COLSPAN="(\d+)"/i.exec(c[1])?.[1] ?? 1), rspan: Number(/ROWSPAN="(\d+)"/i.exec(c[1])?.[1] ?? 1) })));
      // rowsX = 병합 칸(COLSPAN·ROWSPAN)을 펼친 격자 — 위 줄에서 내려온 ROWSPAN 칸을 그 자리에 채운다(047810 재무활동 부채 표 「합계{r2}」가 둘째 머리 줄에 없어
      // 오른쪽 기준으로 열이 한 칸씩 밀렸다)
      const grid = [];
      const carry = []; // 열 → { t, left }
      for (const r of trs) {
        const row = [];
        let col = 0;
        const put = (t) => { row[col] = t; col += 1; };
        const flushCarry = () => { while (carry[col]?.left > 0) { put(carry[col].t); carry[col - 1].left -= 1; } };
        for (const c of r) {
          flushCarry();
          for (let k = 0; k < Math.min(c.span, 40); k += 1) {
            if (c.rspan > 1) carry[col] = { t: c.t, left: c.rspan - 1 };
            put(c.t);
          }
        }
        flushCarry();
        grid.push(row.map((x) => x ?? ""));
      }
      out.push({
        u,
        file,
        // 본표 — 「자산총계」·「부채총계」(칸 글자 사이 띄어쓰기 — SK스퀘어 「자 산 총 계」) 줄이 있는 표
        face: /자산총계|부채총계|부채와자본총계|부채및자본총계/.test(clean(m[0]).replace(/\s/g, "")),
        scope: scopeAt(m.index),
        // title = 표 바로 앞 제목(주석 제목·"…의 내역 당기 (단위 : 원)") — ⑤b·⑦ 이 금융자산 내역 표인지 볼 때 쓴다
        title,
        // pre = 표 앞 글자 끝 200자(제목이 "- 당기 (단위: 천원)"처럼 짧게 잘린 표의 주제 낱말 확인용 — 060370 「2) 리스부채 ① … 변동내역 - 당기」)
        pre: textBefore(600).slice(-200),
        // preWide = 표 앞 넓은 글자 — 제목이 「전기 (단위 : 백만원)」뿐인 XBRL 표가 앞 표 제목(「특수관계자리스거래에 대한 공시 당기」·「금융원가」)을 잇는지 볼 때
        preWide: textBefore(8000).slice(-600),
        // subj = 문서 구조로 정한 표 주제(위) — 제목용 작은 표는 null
        subj,
        rows: trs.map((r) => r.map((c) => c.t)),
        rowsX: grid,
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
    // 재감사 2026-10-19: 바로 위 머리 줄만 보고, 머리 줄 어디든 "합계" 칸이 둘 이상인 표(20240328000773 「금융상품의 분류내역 및 공정가치」 — 합계 열이 여럿)는
    // 칸 수가 정확히 같을 때만
    const nh = rows[q].length - lead, nv = rows[r].length - lead;
    const heads = rows.slice(0, rows.findIndex((x) => x.some((c) => cellVal(c) != null)));
    const multiTotal = heads.reduce((a, x) => a + x.filter((c) => /합\s*계/.test(c)).length, 0) >= 2;
    const up = q > 0 && !rows[q - 1].some((c) => cellVal(c) != null) ? rows[q - 1] : null;
    const upTotal = !multiTotal && up != null && /합\s*계/.test(up.filter(Boolean).at(-1) ?? "");
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
function cashBreakdowns(tables, X, nears = []) {
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
          // 숫자 칸의 줄 이름이 비유동(「장기금융상품」·「비유동금융자산」 — 사용제한 표)이면 유동 줄 근거가 아니다(감사 2026-10-19 ④)
          if (nm && Math.abs(T - target) <= 0.5 && specificInc(nm) && !NOT_CONTENT.test(nm.replace(/\s/g, "")) && !nonCurrentName(rowLastText(rows[r]).replace(/\s/g, ""))) out.push({ parts: [{ label: nm, v: T }], u, how: `주석 표 칸 이름 '${nm}' ${T.toLocaleString("en-US")}(단위 ${u}원)` });
        // ⑤b 표 머리의 한 칸짜리 줄(XBRL 축 멤버 — 033100 「상각후원가측정금융자산의 내역」 머리 '단기금융상품', 줄 '상각후원가측정금융자산(유동)')이 성격을
        // 밝히는 경우. 머리 하나만 근거로 삼으므로 좁게(재감사 2026-10-18 — 047810 연체 분석 표 'A.연체되지 않은 채권' 아래 대여금·보증금, 특수관계자 채권·채무
        // 표, 사채 부채 표가 걸렸다): ① 표 제목이 금융자산·금융상품 내역 표이고 채권·채무·부채·특수관계·연체·사채·대여·보증 낱말이 없음 ② 머리가 예금성·투자성
        // 이름(DEP_INV, 제외 낱말 없음) ③ X 칸 줄 이름이 금융자산 이름이고 제외 성격 아님 ④ X 칸 열 머리가 제외 성격 아님 ⑤ 그런 머리 줄이 정확히 하나
        const xr = rowLastText(rows[r]);
        // ⑥ X 줄 이름이 변동표 낱말(기초·기말·취득 등 NOT_CONTENT)이 아님(재감사 2026-10-19 — 「수준3 당기손익인식금융자산의 변동내역」 기말 줄) ⑦ 머리가 비유동 이름·지분 섞인
        // 이름 아님(specificInc — 「사용이 제한된 금융자산」 표의 장기금융상품·장기예치금, 「채무상품 및 지분상품」)
        if (Math.abs(T - target) <= 0.5 && FIN_ASSET_NAME.test(xr) && !NOT_CONTENT.test(xr.replace(/\s/g, "")) && !nonCurrentName(xr.replace(/\s/g, "")) && cashKindOf(xr) !== "exc" && cashKindOf(colHead(rows, r, off) ?? "") !== "exc"
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
          if (heads.length === 1 && heads[0][1] === "inc" && specificInc(heads[0][0])) out.push({ parts: [{ label: heads[0][0], v: T }], u, how: `주석 표 머리 '${heads[0][0]}' 아래 '${rowLastText(rows[r])}' ${T.toLocaleString("en-US")}(단위 ${u}원)` });
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
      // 머리 줄은 자산(부채·순부채·차입 낱말 없음 — 감사 ② 「이자부 금융상품의 장부금액」 금융자산 = 금융부채 + 순부채 표)
      if (gv.length < 2 || gv.some((v) => v == null) || isTotalLabel(glab) || !FIN_ASSET_NAME.test(glab) || /부채|차입|순부채/.test(glab)) continue;
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
        if (/부채|차입|순부채|순자산/.test(lab)) { parts.length = 0; break; }
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
          // 합계 칸 없이 연속 줄 합만 보는 경로라 정확히 같을 때만(재감사 2026-10-19 — 001440 2023 가짜 X×0.9993 이 연속 4줄과 0.67 단위로 맞았다)
          if (parts.length >= 2 && sum * u === X && content(parts)) {
            out.push({ parts: [...parts], u, how: `주석 표 같은 열 연속 내역 ${parts.length}개 합 ${sum.toLocaleString("en-US")}(단위 ${u}원)` });
            break;
          }
          // 반올림 범위 안이지만 정확히 같지 않은 연속 줄 — 채택하지 않고 판독 실패 사유로만 남긴다(내역 미공시와 구분)
          if (parts.length >= 2 && sum * u !== X && Math.abs(sum - target) <= parts.length / 2 && content(parts)) nears.push(`${parts.map((p) => p.label).join("·")} 합 ${sum.toLocaleString("en-US")}(단위 ${u}원)`);
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
  const nears = [];
  for (const rc of [...new Set(tables.map((t) => t.rc))]) for (const b of cashBreakdowns(tables.filter((t) => t.rc === rc), X, nears)) found.push({ ...b, rc });
  if (ctx) ctx.nears = nears;
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
  // 좁힌 꼴(재감사 2026-10-19 — 오너 지시로 다시 시도): ① 같은 보고서·같은 범위·그 해 기간 열의 범주별 금융자산 내역 표, 서로 다른 표에서 표마다 정확히 한 칸
  // ② 칸 = 그 표의 「유동」 열·자산 내역 줄, 이름이 예금성·투자성(specificInc — 채무상품·정기예금 등), 합계·소계·순액·비유동·파생·지분 줄 금지 ③ 같은 금액 칸은 하나로
  // ④ 칸 2~3, 합이 X 와 표 단위 반올림(칸수/2) 안, 그런 조합이 보고서 안에 정확히 하나(보고서끼리도 같은 조합) ⑤ 본표에 따로 있는 줄과 같은 금액 칸은 뺀다
  // ⑥ 기존 판독이 실패했을 때만(notFound 에서 부른다)
  const faceVals = ctx.face ?? [];
  const byRc = new Map(); // rc → [{ tkey, cells: Map(won → cell) }]
  for (const [ti, t] of tables.entries()) {
    if (t.face || t.scope !== want || !t.rowsX) continue;
    const per = ctx.period(t.rc);
    if (!per || !/금융자산|금융상품/.test(t.title ?? "") || TITLE_EXC.test(t.title ?? "")) continue;
    if (X / t.u < 1000) continue;
    const R = t.rowsX;
    const first = R.findIndex((row) => row.some((c) => cellVal(c) != null));
    if (first < 1) continue;
    const titlePer = periodWord([...(t.title ?? "").matchAll(PERIOD_RE_G)][0]?.[0] ?? "");
    const cells = new Map();
    for (let r = first; r < R.length; r += 1) {
      const lab = rowLastText(t.rows[r]);
      const nl = (lab ?? "").replace(/\s/g, "");
      if (!lab || isTotalLabel(lab) || NOT_CONTENT.test(nl) || /순액|파생|지분|주식|출자|부채|사채|상각|할인|합계|소계/.test(nl) || nonCurrentName(nl) || !specificInc(lab)) continue;
      const lead = R[r].findIndex((c) => cellVal(c) != null);
      for (let off = 0; off < R[r].length - lead; off += 1) {
        const v = cellVal(cellAt(R[r], off));
        if (!v || v <= 0) continue;
        const path = [];
        for (let q = 0; q < first; q += 1) { const h = cellAt(R[q], off); if (h && !/단위/.test(h)) path.push(h); }
        if (!path.some((h) => /유\s*동/.test(h) && !/비\s*유\s*동/.test(h)) || path.some((h) => /비\s*유\s*동/.test(h))) continue;
        const pp = path.map(periodWord).filter(Boolean);
        const cp = pp.length ? (new Set(pp).size === 1 ? pp[0] : null) : titlePer;
        if (cp !== per) continue;
        const won = v * t.u;
        if (faceVals.some((f) => f != null && Math.abs(Math.abs(f) - won) <= t.u / 2)) continue;
        cells.set(won, { label: lab, v, u: t.u, won, tkey: ti });
      }
    }
    if (!cells.size) continue;
    const list = byRc.get(t.rc) ?? byRc.set(t.rc, []).get(t.rc);
    list.push({ ti, cells: [...cells.values()] });
  }
  const found = [];
  for (const [rc, tbls] of byRc) {
    // 같은 금액 칸은 표가 달라도 하나(같은 내역을 두 표가 다시 적은 것 — 20240328000773 단기금융상품 100,540 / 금융상품 100,540)
    const sets = new Map();
    const pickRec = (i, chosen, used) => {
      if (chosen.length >= 2) {
        const sum = chosen.reduce((a, c) => a + c.won, 0);
        if (Math.abs(sum - X) <= chosen.reduce((a, c) => a + c.u, 0) / 2) sets.set(chosen.map((c) => c.won).sort((a, b) => a - b).join("+"), [...chosen]);
      }
      if (chosen.length === 3) return;
      for (let j = i; j < tbls.length; j += 1)
        for (const c of tbls[j].cells) {
          if (used.has(c.won)) continue;
          used.add(c.won);
          chosen.push(c);
          pickRec(j + 1, chosen, used);
          chosen.pop();
          used.delete(c.won);
        }
    };
    if (tbls.length >= 2) pickRec(0, [], new Set());
    if (sets.size > 1) return null;
    if (sets.size === 1) found.push({ rc, pick: [...sets.values()][0], key: [...sets.keys()][0] });
  }
  if (!found.length || new Set(found.map((f) => f.key)).size !== 1) return null;
  const { rc, pick } = found[0];
  return { pick, result: (tbls, line) => partsResult(tbls, X, pick, `${line} 주석 내역(${rc}) 범주별 금융자산 내역 표 ${pick.length}개의 유동·그 해 열 칸(표마다 한 칸) 합`) };
}
// 기간 낱말은 단독 낱말·열 머리 꼴만(재감사 ④ — 「산일전기」의 「전기」, 「당기손익」·「전기설비」는 기간이 아니다): 앞 글자가 한글이 아니고 뒤가 한글이 아니거나 조사·말·초
/** 표의 줄·열 이름 묶음(숫자 아닌 칸 글자, 띄어쓰기·각주 표시 뺌, 「구분·당기·합계」 같은 흔한 칸 제외) — 앞 표 주제를 이을지 볼 때 */
const SIG_GENERIC = /^(구분|과목|계정과목|내역|내용|금액|공시금액|장부금액|합계|소계|계|총계|기초|기말|단위.*|(당|전)(반|분)?기(말|초)?|제\d+(\((당|전)\))?(반|분)?기(말|초)?|\d+년|\d+년\d+월\d+일|-)$/;
function tableSig(html) {
  const out = new Set();
  for (const c of html.matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)) {
    const t = clean(c[1]).replace(/　/g, "").replace(/\(\s*\*\s*\d*\s*\)|\(\s*주\s*\d*\s*\)/g, "").replace(/\s/g, "");
    if (!t || cellVal(t) != null || SIG_GENERIC.test(t)) continue;
    out.add(t);
  }
  return out;
}
/** 표 머리 글 — 첫 숫자 칸이 있는 줄 위 줄들의 글자 */
function tableHead(html) {
  const out = [];
  for (const r of html.matchAll(/<TR[\s\S]*?<\/TR>/gi)) {
    const cs = [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1]).replace(/　/g, "").trim());
    if (cs.some((c) => cellVal(c) != null)) break;
    out.push(cs.filter(Boolean).join(" | "));
  }
  return out.filter(Boolean).join(" // ");
}
/** 숫자 칸이 있는 줄의 이름(첫 숫자 칸 앞 마지막 글자, 합계·소계 줄 제외) */
function tableRowLabels(html) {
  const out = [];
  for (const r of html.matchAll(/<TR[\s\S]*?<\/TR>/gi)) {
    const cs = [...r[0].matchAll(/<T[DHEU][^>]*>([\s\S]*?)<\/T[DHEU]>/gi)].map((c) => clean(c[1]).replace(/　/g, "").trim());
    const i = cs.findIndex((c) => cellVal(c) != null);
    if (i < 0) continue;
    const lab = cs.slice(0, i).filter(Boolean).at(-1) ?? "";
    if (!lab || isTotalLabel(lab)) continue;
    out.push(lab);
  }
  return out;
}
/** 두 표의 이름 묶음이 대응하는가 — 작은 쪽 이름의 과반이 다른 쪽에 그대로 있고, 겹치는 이름이 둘 이상(이름이 하나뿐이면 그 하나) */
function sigMatch(a, b) {
  if (!a || !b || !a.size || !b.size) return false;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  const small = Math.min(a.size, b.size);
  return n * 2 > small && (n >= 2 || small === 1);
}
/** 표 머리가 기간·단위·번호뿐인가(「당기」·「- 전반기」·「제 19(당) 기」) */
const bareSubject = (c) => !(c ?? "").replace(/\(?\s*단위\s*:[^)]*\)?/g, "").replace(/제\s*\d+\s*(\(\s*(당|전)\s*\))?\s*(반|분)?\s*기\s*말?/g, "").replace(/(당|전)\s*(반|분)?\s*기\s*(말|초)?|[\s\-–:.()（）②①③④⑤]/g, "");
// 기간 낱말(재감사 2026-10-22 새1): 앞 글자가 아니라 뒤 글자로 낱말을 가른다 — 띄어쓰기 빠진 「…조정내용당기 및 전기 중」의 「당기」, 「당기금액·전기금액·당기잔액·당기장부금액·
// 당기현재·당기기말·당기합계」 머리도 기간. 「당」 앞이 한글이면 「해당·상당·적당·배당·충당·할당·담당·타당」 낱말은 빼고(「정·부」는 넣지 않는다 —
// 「자본조정당기말과 전기말」·「약정당기말」·「여부당기말」의 당기를 놓쳤다, 재감사 2026-10-22), 「전」 앞이 한글이면(「산일전기」·
// 「일진전기」) 「및·와·과」 뒤만 기간. 「당기손익·당기순이익·전기설비」는 뒤 글자로 빠진다
const PERIOD_RE_G = /(?:(?<![해상적배충할담타])당|(?:^|(?<=[^가-힣]|[및와과]))전)\)?\s*(반|분)?\s*기(?=$|[^가-힣]|[말초와과의에은는중및까부]|금액|잔액|장부|현재|기[말초]|합계)/g;
/** 기간 낱말 → "cur"(당기·당반기·"제 19(당) 기") | "prev"(전기) | null */
const periodWord = (t) => { const m = new RegExp(PERIOD_RE_G.source).exec(t ?? ""); return m ? (m[0][0] === "당" ? "cur" : "prev") : null; };
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
      if (!glab || !FIN_ASSET_NAME.test(glab) || isTotalLabel(glab) || /부채|차입/.test(glab)) continue;
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
        if (/부채|차입|순부채|순자산/.test(lab)) { pick.length = 0; break; }
        pick.push({ label: lab, v, u: t.u, won: v * t.u });
      }
      if (pick.length < 2 || !pick.every((c) => FIN_ASSET_NAME.test(c.label) && !NOT_CONTENT.test(c.label.replace(/\s/g, "")))) continue;
      const sum = pick.reduce((a, c) => a + c.v, 0);
      if (Math.abs(sum - X / t.u) <= sumTol(X / t.u, Math.max(1, cells))) hits.push({ t, glab, pick });
    }
  }
  if (!hits.length) return null;
  // 0 인 줄은 비교에서 뺀다 — 다음 해 보고서 전기 열은 0 줄(파생상품자산 0)을 생략한다(079550 2020: 2020 보고서 당기 열 = 2021 보고서 전기 열, 0 줄만 다름)
  const keys = new Set(hits.map((h) => h.pick.filter((c) => c.won !== 0).map((c) => `${c.label.replace(/\s/g, "")}=${c.won}`).join(",")));
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
    // ⑦(범주별 표 유동 열 칸 합)은 우연 일치가 있어(감사 2026-10-19 ① — 값을 흔든 시험 130,112회 중 11회 틀린 값) 포함 근거에서 빼고 판독 실패 사유로만
    const cc = groupPeriodCols(tables, X, ctx) ?? categoryCurrentCols(tables, X, ctx);
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
  if (ctx?.nears?.length) return { cash: null, reason: "unread", how: `${base} — 판독 실패(합계 칸 없는 표의 연속 줄 합이 반올림 범위 안이지만 정확히 같지 않아 채택 안 함: ${[...new Set(ctx.nears)].slice(0, 2).join(", ")})` };
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
    const ctx = { fs: own.fs, period: (rc) => (yearOf[rc] === y ? "cur" : yearOf[rc] === y + 1 ? "prev" : null), face: own.rows.filter((x) => x.sj_div === "BS").map((x) => amt(x[own.col])) };
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
  const ctx = { fs: rowsFs, period: () => "cur", face: (rows ?? []).map((x) => amt(x.thstrm_amount)) };
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
 * 시험 전용(--fuzz7, DB 쓰기 없음) — 계열 줄마다 본표 값 X 를 ±15% 흔들어(0.0005 간격, 1 제외) 범주별 표 유동 열(⑦)·빈 묶음 머리(⑧b) 판독에 넣고
 * 틀린 값을 채택한 횟수를 센다(감사 2026-10-19 흔든 값 시험과 같은 방식)
 */
async function fuzz7(corp, latest, sym) {
  const st = { tried: 0, acc7: [], acc8b: [], base7: [], base8b: [] };
  const rcpsOf = {};
  const rcps = async (ry) => (rcpsOf[ry] ??= await annualRcps(corp, ry));
  const cases = [];
  for (let y = latest; y >= latest - 5; y -= 1) {
    let own = null;
    for (const [ry, col] of [[y + 2, "bfefrmtrm_amount"], [y + 1, "frmtrm_amount"], [y, "thstrm_amount"]]) {
      if (ry > latest) continue;
      const r = await fnlttBs(corp, ry);
      if (r?.rows.some((x) => amt(x[col]) != null)) { own = { ry, col, rows: r.rows, fs: r.fs }; break; }
    }
    if (!own) continue;
    const lines = familyRows(own.rows).map((x) => ({ line: x.account_nm.replace(/\s/g, ""), value: amt(x[own.col]) })).filter((x) => x.value != null && x.value !== 0);
    if (!lines.length) continue;
    const yearOf = {};
    const docs = [];
    for (const ry of [...new Set([y, y + 1, own.ry].filter((ry) => ry <= latest))]) for (const rc of await rcps(ry)) { docs.push(rc); yearOf[rc] = ry; }
    const ctx = { fs: own.fs, period: (rc) => (yearOf[rc] === y ? "cur" : yearOf[rc] === y + 1 ? "prev" : null), face: own.rows.filter((x) => x.sj_div === "BS").map((x) => amt(x[own.col])) };
    const tables = [];
    for (const rc of docs) for (const t of tablesOf(await docTexts(rc))) tables.push({ ...t, rc });
    for (const l of lines) cases.push({ label: `${sym} ${y} ${l.line} ${own.fs}`, X: l.value, tables, ctx });
  }
  const it = await latestInterim(corp, latest);
  if (it) {
    let rows = null, fs = null;
    for (const f of ["CFS", "OFS"]) {
      const j = await jget(`${B}/fnlttSinglAcntAll.json?crtfc_key=${DART}&corp_code=${corp}&bsns_year=${it.year}&reprt_code=${it.code}&fs_div=${f}`);
      if (j.status === "013") continue;
      if (j.status !== "000") throw new Error(`fnltt ${j.status}`);
      rows = (j.list ?? []).filter((r) => r.sj_div === "BS"); fs = f; break;
    }
    const lines = familyRows(rows).map((x) => ({ line: x.account_nm.replace(/\s/g, ""), value: amt(x.thstrm_amount) })).filter((x) => x.value != null && x.value !== 0);
    const tables = [];
    for (const rc of it.rcps) for (const t of tablesOf(await docTexts(rc))) tables.push({ ...t, rc });
    const ctx = { fs, period: () => "cur", face: (rows ?? []).map((x) => amt(x.thstrm_amount)) };
    for (const l of lines) cases.push({ label: `${sym} ${it.year}Q${it.q} ${l.line} ${fs}`, X: l.value, tables, ctx });
  }
  for (const c of cases) {
    if (categoryCurrentCols(c.tables, c.X, c.ctx)) st.base7.push(c.label);
    if (groupPeriodCols(c.tables, c.X, c.ctx)) st.base8b.push(c.label);
    for (let k = -300; k <= 300; k += 1) {
      if (k === 0) continue;
      const X = Math.round(c.X * (1 + k * 0.0005));
      st.tried += 1;
      const r7 = categoryCurrentCols(c.tables, X, c.ctx);
      if (r7) st.acc7.push(`${c.label} f=${(1 + k * 0.0005).toFixed(4)} :: ${r7.pick.map((p) => `${p.label} ${p.v}`).join(" + ")}`);
      if (groupPeriodCols(c.tables, X, c.ctx)) st.acc8b.push(`${c.label} f=${(1 + k * 0.0005).toFixed(4)}`);
    }
  }
  return st;
}
const FUZZ7 = process.argv.includes("--fuzz7");
const FUZZL = process.argv.includes("--fuzzL");
/**
 * 시험 전용(--fuzzL, DB 쓰기 없음) — 사업연도마다 그 해·다음 해 보고서의 본표 차입금 줄·다른 부채 줄 값을 ±15%(0.0005 간격, 1 제외) 흔들어
 * 차입금 리스 포함 확인(lease, 두 줄 합 포함)·차입금 밖 확인(other)·리스 없음 확인(nolease)에 넣고 채택 횟수를 센다
 */
async function fuzzLease(corp, latest, sym) {
  const st = { lease: 0, other: 0, nolease: 0, accLease: [], accOther: [], accNo: [] };
  const nm = (x) => (x.account_nm ?? "").replace(/\s/g, "");
  const debtRows = (rows) => rows.filter((x) => /차입|사채|장기부채/.test(nm(x)) && !/대여|자산/.test(nm(x)));
  for (let y = latest; y >= latest - 5; y -= 1) {
    for (const ry of [y, y + 1]) {
      if (ry > latest) continue;
      const col = ry === y ? "thstrm_amount" : "frmtrm_amount";
      const r = await fnlttBs(corp, ry);
      if (!r) continue;
      const debtR = debtRows(r.rows).filter((x) => amt(x[col]) != null && amt(x[col]) !== 0);
      const debt = debtR.map((x) => amt(x[col]));
      const otherR = r.rows.filter((x) => /부채|채무/.test(nm(x)) && !debtRows([x]).length && !/총계|합계|^(유동|비유동)?부채$|리스|충당|법인세|확정급여|이연/.test(nm(x)) && amt(x[col]) != null && amt(x[col]) !== 0);
      for (const rc of await annualRcps(corp, ry)) {
        const texts = await docTexts(rc);
        // 원래 값(f = 1)으로도 걸리는 묶음은 흔든 값 판정에서 「틀린 채택」이 아니다(반올림 범위 안에서 같은 묶음)
        const per0 = ry === y ? "cur" : "prev";
        const truth = new Set([
          ...leaseInFaceTableAll(texts, debtR.map((x) => ({ v: amt(x[col]), name: x.account_nm })), "lease", "본표 차입금", { pairs: true, per: per0 }),
          ...otherR.flatMap((x) => leaseInFaceTableAll(texts, otherR.filter((z) => nm(z).replace(/(유동성|유동|비유동)/g, "") === nm(x).replace(/(유동성|유동|비유동)/g, "")).map((z) => ({ v: amt(z[col]), name: z.account_nm })), "lease", "", { pairs: false, natPairs: true, name: nm(x).replace(/(유동성|유동|비유동)/g, ""), per: per0 })),
        ].map((h) => h.bkey));
        for (let k = -300; k <= 300; k += 1) {
          if (k === 0) continue;
          const f = 1 + k * 0.0005;
          const tag = `${sym} ${y} (${rc}) f=${f.toFixed(4)}`;
          const per = ry === y ? "cur" : "prev";
          if (debt.length) {
            st.lease += 1;
            const h = leaseInFaceTableAll(texts, debtR.map((x) => ({ v: Math.round(amt(x[col]) * f), name: x.account_nm })), "lease", "본표 차입금", { pairs: true, per });
            const hw = h.filter((x) => !truth.has(x.bkey));
            if (hw.length) st.accLease.push(`${tag} ${hw[0].text}`);

          }
          const byBase = new Map();
          for (const x of otherR) { const b = nm(x).replace(/(유동성|유동|비유동)/g, ""); (byBase.get(b) ?? byBase.set(b, []).get(b)).push(x); }
          for (const [b, xs] of byBase) {
            st.other += 1;
            const h3 = leaseInFaceTableAll(texts, xs.map((x) => ({ v: Math.round(amt(x[col]) * f), name: x.account_nm })), "lease", `본표 '${b}'`, { pairs: false, natPairs: true, name: b, per });
            const hw3 = h3.filter((x) => !truth.has(x.bkey));
            if (hw3.length) st.accOther.push(`${tag} ${hw3[0].text}`);
          }
        }
      }
    }
  }
  return st;
}

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
const fuzzAll = { tried: 0, acc7: [], acc8b: [], base7: [], base8b: [] };
const fuzzLAll = { lease: 0, other: 0, nolease: 0, accLease: [], accOther: [], accNo: [] };
const failed = []; // 조회·판독 예외가 난 종목(종료코드 1 — 1호기 배치 실패 감시 job-fin-kr-da 로 잡힌다)
let skipped = 0;
for (const sym of symbols) {
  if (QUOTA.stopped) { stopAt = sym; break; }
  const corp = corpOf(sym);
  if (!corp) { console.log(`  ${sym}: corp_code 없음`); failed.push(sym); continue; }
  if (FUZZL) {
    const ly = await latestFy(corp);
    const st = await fuzzLease(corp, ly, sym);
    for (const k of ["lease", "other", "nolease"]) fuzzLAll[k] += st[k];
    fuzzLAll.accLease.push(...st.accLease); fuzzLAll.accOther.push(...st.accOther); fuzzLAll.accNo.push(...st.accNo);
    console.log(`  ${sym}: 차입금 리스 포함 ${st.lease}회·채택 ${st.accLease.length} · 차입금 밖 ${st.other}회·채택 ${st.accOther.length} · 리스 없음 ${st.nolease}회·채택 ${st.accNo.length}`);
    continue;
  }
  if (FUZZ7) {
    const ly = await latestFy(corp);
    const st = await fuzz7(corp, ly, sym);
    fuzzAll.tried += st.tried;
    fuzzAll.acc7.push(...st.acc7); fuzzAll.acc8b.push(...st.acc8b); fuzzAll.base7.push(...st.base7); fuzzAll.base8b.push(...st.base8b);
    console.log(`  ${sym}: 흔든 값 ${st.tried}회 · ⑦ 틀린 채택 ${st.acc7.length} · ⑧b 틀린 채택 ${st.acc8b.length} · 원래 값 ⑦ ${st.base7.length} · ⑧b ${st.base8b.length}`);
    continue;
  }
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
if (FUZZL) {
  console.log(`리스 흔든 값 시험 합계 — 차입금 리스 포함 ${fuzzLAll.lease}회·채택 ${fuzzLAll.accLease.length} · 차입금 밖 ${fuzzLAll.other}회·채택 ${fuzzLAll.accOther.length} · 리스 없음 ${fuzzLAll.nolease}회·채택 ${fuzzLAll.accNo.length}`);
  for (const a of [...fuzzLAll.accLease, ...fuzzLAll.accOther, ...fuzzLAll.accNo].slice(0, 60)) console.log(`  채택: ${a}`);
}
if (FUZZ7) {
  console.log(`흔든 값 시험 합계 ${fuzzAll.tried}회 · ⑦ 틀린 채택 ${fuzzAll.acc7.length} · ⑧b 틀린 채택 ${fuzzAll.acc8b.length}`);
  for (const a of [...fuzzAll.acc7, ...fuzzAll.acc8b].slice(0, 40)) console.log(`  틀린 채택: ${a}`);
  console.log(`원래 값으로 걸린 줄 ⑦: ${fuzzAll.base7.join(" / ") || "없음"}`);
  console.log(`원래 값으로 걸린 줄 ⑧b: ${fuzzAll.base8b.join(" / ") || "없음"}`);
}
const qs = QUOTA.state();
console.log(`DART 하루 요청(적재) ${qs.count}/${qs.cap} — ${qs.day} KST · 이번 실행 DART 요청 ${DISK.stats.requests}건(목록 ${DISK.stats.listPages}) · 디스크 캐시 ${env.DART_CACHE_DIR ? `적중 ${DISK.stats.hit} · 미스 ${DISK.stats.miss} · 새로 씀 ${DISK.stats.write}` : "꺼짐(DART_CACHE_DIR 없음)"} · 건너뜀(변화 없음) ${skipped}종목${FULL ? "(--full)" : ""}`);
if (failed.length) {
  console.log(`실패 ${failed.length}종목: ${[...new Set(failed)].join(" ")}`);
  process.exitCode = 1;
}
await cli.close();
console.log("완료");
