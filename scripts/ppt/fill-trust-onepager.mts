/**
 * PLUS 더블S 주식신탁 템플릿(1장)을 종목 데이터로 채운다.
 *
 * 양식·좌표·폰트는 템플릿을 유지하고, 회사명·재무 숫자·주가 차트만 바꾼다.
 * 핵심포인트·점유율·로고·왼쪽 그림(Kodex 캡처)은 앱에 소스가 없으면 템플릿을 유지하거나 비운다.
 * 없는 숫자는 만들지 않는다.
 *
 * 실행:
 *   NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json \
 *     scripts/ppt/fill-trust-onepager.mts --symbol=005930
 *
 * 환경: .env.local (DART_API_KEY, DATA_GO_KR_KEY, MONGODB_URI, DART_CACHE_DIR)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// DB·DART 모듈은 환경변수를 읽은 뒤에 불러야 한다(mongodb URI 를 모듈 로드 때 고정).
type FactsMod = typeof import("@/lib/markets/kr/dart-facts");
type EvMod = typeof import("@/lib/markets/kr/dart-ev");
type CorpMod = typeof import("@/lib/markets/kr/corpcode");
type PriceMod = typeof import("@/lib/markets/kr/fsc-price");
type DaMod = typeof import("@/lib/db/kr-da");
type IdxMod = typeof import("@/lib/macro/kr/fsc-index");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_TEMPLATE =
  "/home/ubuntu/.cursor/projects/home-ubuntu-5/uploads/d33a65c9-5984-4ea3-9fd6-b99c91eb1317/26.07_사내한_PLUS 더블S 주식신탁_수정11.pptx";
/** 템플릿 본문이 이 종목(삼성전자 보통주)이다. 다른 종목의 소개·점유율·로고로 쓰지 않는다. */
const TEMPLATE_SYMBOL = "005930";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

function loadEnv() {
  process.loadEnvFile(resolve(ROOT, ".env.local"));
}

function truncInt(n: number): number {
  return Math.trunc(n);
}

function fmtInt(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  const neg = n < 0;
  const s = Math.abs(Math.trunc(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${s}` : s;
}

/** 소수점 2자리 버림 */
function fmt2(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  const neg = n < 0;
  const v = Math.trunc(Math.abs(n) * 100 + 1e-6);
  const s = `${Math.trunc(v / 100)}.${String(v % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

function eok(won: number | null | undefined): number | null {
  if (won == null || !Number.isFinite(won)) return null;
  return truncInt(won / 1e8);
}

function yoy(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur / prev) - 1) * 100;
}

function perOf(price: number | null, eps: number | null): number | null {
  if (price == null || eps == null || !(price > 0) || !(eps > 0)) return null;
  return price / eps;
}

const NAVER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function num(s: string | undefined | null): number | null {
  if (s == null) return null;
  const n = Number(String(s).replace(/[%,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

interface NaverCol {
  year: number;
  key: string;
  consensus: boolean;
}

interface NaverTable {
  cols: NaverCol[];
  rows: Record<string, Record<string, number | null>>;
}

/** 앱과 같은 네이버 금융 연간 탭. 추정 열이 여러 개면 모두 읽는다(앱 화면은 첫 추정연도만 씀). */
async function fetchNaverAnnual(code: string): Promise<NaverTable | null> {
  const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/finance/annual`, {
    headers: { "User-Agent": NAVER_UA, Referer: "https://m.stock.naver.com/" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    financeInfo?: {
      trTitleList?: { key: string; isConsensus?: string }[];
      rowList?: { title: string; columns: Record<string, { value?: string }> }[];
    };
  };
  const fi = j.financeInfo;
  if (!fi?.trTitleList || !fi.rowList) return null;
  const cols: NaverCol[] = fi.trTitleList.map((t) => ({
    year: Number(String(t.key).slice(0, 4)),
    key: t.key,
    consensus: t.isConsensus === "Y",
  }));
  const rows: NaverTable["rows"] = {};
  for (const row of fi.rowList) {
    const byKey: Record<string, number | null> = {};
    for (const c of cols) byKey[c.key] = num(row.columns?.[c.key]?.value);
    rows[row.title] = byKey;
  }
  return { cols, rows };
}

/** 네이버 과거열 ÷ DART 억원. 1=억원, 100=백만원, 10000=만원. 맞으면 나눌 수. */
function naverScale(naverHist: number, dartEok: number): number | null {
  if (!dartEok) return null;
  const ratio = naverHist / dartEok;
  for (const s of [1, 100, 10_000, 0.01, 0.0001]) {
    if (Math.abs(ratio - s) / s < 0.02) return s;
  }
  return null;
}

function yearEndClose(closes: Map<string, number>, year: number): number | null {
  const prefix = String(year);
  let best: string | null = null;
  let v: number | null = null;
  for (const [d, c] of closes) {
    if (!d.startsWith(prefix)) continue;
    if (best == null || d > best) {
      best = d;
      v = c;
    }
  }
  return v;
}

async function main() {
  loadEnv();
  const factsMod: FactsMod = await import("@/lib/markets/kr/dart-facts");
  const evMod: EvMod = await import("@/lib/markets/kr/dart-ev");
  const corpMod: CorpMod = await import("@/lib/markets/kr/corpcode");
  const priceMod: PriceMod = await import("@/lib/markets/kr/fsc-price");
  const daMod: DaMod = await import("@/lib/db/kr-da");
  const idxMod: IdxMod = await import("@/lib/macro/kr/fsc-index");
  const { annualSeries, daAndAmortSeries, fetchKrFacts } = factsMod;
  const { krEpsByYear, krOpIncomeByYear } = evMod;
  const { resolveCorpCode } = corpMod;
  const { fetchKrDailyCloses } = priceMod;
  const { getKrDaDocChecked } = daMod;
  const { fetchKrIndexDaily } = idxMod;

  const symbol = (arg("symbol") ?? TEMPLATE_SYMBOL).replace(/\D/g, "").padStart(6, "0").slice(-6);
  const template = arg("template") ?? DEFAULT_TEMPLATE;
  const out = arg("out") ?? resolve(ROOT, "reports/ppt", `${symbol}-trust-onepager.pptx`);
  const logo = arg("logo");
  const notes: string[] = [];
  const blanks: { slot: string; reason: string }[] = [];

  const { corpName } = resolveCorpCode("", symbol);
  const isTemplate = symbol === TEMPLATE_SYMBOL;

  const titleRuns = isTemplate
    ? ["삼성전자 ", "보통주", " ", `(${symbol}) `]
    : [`${corpName} `, "", "", `(${symbol}) `];

  // ── 재무 (OpenDART + 감가상각 적재본) ──
  const headers = ["", "", ""];
  const rows: Record<string, string[]> = {
    rev: ["", "", ""],
    growth: ["", "", ""],
    ebitda: ["", "", ""],
    ebitdaMargin: ["", "", ""],
    net: ["", "", ""],
    netMargin: ["", "", ""],
    per: ["", "", ""],
  };
  let sourceLeft = "OpenDART";

  let revWon = new Map<number, number>();
  let netWon = new Map<number, number>();
  let opWon = new Map<number, number>();
  let daWon = new Map<number, number>();
  let epsWon = new Map<number, number>();
  let actualYear: number | null = null;

  try {
    const { corpCode } = resolveCorpCode("", symbol);
    const [facts, daR] = await Promise.all([fetchKrFacts(corpCode, "annual"), getKrDaDocChecked(symbol)]);
    if (!facts) {
      blanks.push({ slot: "재무표 실적", reason: "OpenDART 연간 재무가 비어 있음" });
    } else {
      const IS = ["IS", "CIS"];
      revWon = annualSeries(facts, ["ifrs-full_Revenue", "dart_Revenue"], ["매출액", "수익(매출액)", "영업수익", "매출"], IS);
      netWon = annualSeries(facts, ["ifrs-full_ProfitLoss"], ["당기순이익", "당기순이익(손실)"], IS);
      opWon = krOpIncomeByYear(facts);
      epsWon = krEpsByYear(facts);
      const da = daAndAmortSeries(facts, daR.doc);
      daWon = da.byYear;
      if (daR.warning) blanks.push({ slot: "EBITDA", reason: daR.warning });
      const years = [...revWon.keys()].sort((a, b) => a - b);
      actualYear = years.at(-1) ?? null;
      if (actualYear == null) blanks.push({ slot: "재무표 매출", reason: "DART 매출액 연도가 없음" });
    }
  } catch (e) {
    blanks.push({ slot: "재무표 실적", reason: `DART 조회 실패 — ${e instanceof Error ? e.message : String(e)}` });
  }

  // ── 시세 (차트·연말 PER) ──
  const today = new Date();
  const endYmd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const beginYmd = "20230101";
  let priceRows: { d: string; px: string; ks: string }[] | null = null;
  const closes = new Map<string, number>();
  try {
    const [stock, kospi] = await Promise.all([
      fetchKrDailyCloses(symbol, beginYmd, endYmd),
      fetchKrIndexDaily("코스피", beginYmd, endYmd),
    ]);
    const kospiBy = new Map(kospi.map((r) => [r.date.replace(/-/g, ""), r.close]));
    const dates = [...stock.keys()].filter((d) => kospiBy.has(d)).sort();
    for (const d of stock.keys()) closes.set(d, stock.get(d)!);
    if (dates.length < 100) {
      blanks.push({
        slot: "주가 차트(삼성전자·코스피)",
        reason: `금융위 일별 시세가 ${dates.length}일뿐이라 템플릿 차트를 유지 (종목 ${stock.size}일, 코스피 ${kospi.length}일)`,
      });
    } else {
      priceRows = dates.map((d) => {
        const ks = kospiBy.get(d)!;
        const ksT = Math.trunc(Math.abs(ks) * 100 + 1e-6) / 100;
        return {
          d: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
          px: String(Math.trunc(stock.get(d)!)),
          ks: ksT.toFixed(2),
        };
      });
      notes.push(`주가 차트 ${priceRows[0].d}~${priceRows.at(-1)!.d} ${priceRows.length}일 (금융위 주식시세·지수시세)`);
    }
  } catch (e) {
    blanks.push({ slot: "주가 차트", reason: `시세 조회 실패 — ${e instanceof Error ? e.message : String(e)}. 템플릿 차트 유지` });
  }

  if (actualYear != null) {
    headers[0] = `FY${actualYear}`;
    const rev = eok(revWon.get(actualYear));
    const net = eok(netWon.get(actualYear));
    const op = opWon.get(actualYear);
    const da = daWon.get(actualYear);
    const ebitda = op != null && da != null ? eok(op + da) : null;
    if (op != null && da != null) notes.push(`FY${actualYear} EBITDA = 영업이익 ${fmtInt(eok(op))} + 감가상각 ${fmtInt(eok(da))} 억원`);
    if (op == null || da == null) {
      blanks.push({
        slot: `FY${actualYear} EBITDA`,
        reason: op == null ? "영업이익 없음" : "감가상각 적재본·공시 줄 없음 — 추정하지 않음",
      });
    }
    rows.rev[0] = fmtInt(rev);
    rows.net[0] = fmtInt(net);
    rows.ebitda[0] = fmtInt(ebitda);
    rows.growth[0] = fmt2(yoy(rev, eok(revWon.get(actualYear - 1))));
    rows.ebitdaMargin[0] = rev && ebitda != null ? fmt2((ebitda / rev) * 100) : "";
    rows.netMargin[0] = rev && net != null ? fmt2((net / rev) * 100) : "";
    const ye = yearEndClose(closes, actualYear);
    const eps = epsWon.get(actualYear) ?? null;
    if (ye == null) blanks.push({ slot: `FY${actualYear} PER`, reason: "그 해 연말 종가(금융위)가 없음" });
    else if (eps == null) blanks.push({ slot: `FY${actualYear} PER`, reason: "DART EPS 없음" });
    else if (!(eps > 0)) blanks.push({ slot: `FY${actualYear} PER`, reason: "EPS가 0 이하 — PER 비움" });
    rows.per[0] = fmt2(perOf(ye, eps));
    if (!rows.growth[0]) blanks.push({ slot: `FY${actualYear} 성장률`, reason: "직전연도 매출이 없어 YoY를 계산하지 않음" });
  }

  // ── 컨센서스 (네이버 연간, FnGuide 열). 단위는 같은 해 DART 매출과 맞을 때만. ──
  let estYears: number[] = [];
  try {
    const table = await fetchNaverAnnual(symbol);
    if (!table) {
      blanks.push({ slot: "추정 열", reason: "네이버 연간 컨센서스 응답 없음" });
    } else {
      const hist = table.cols.filter((c) => !c.consensus && actualYear != null && c.year === actualYear);
      const histCol = hist[0] ?? table.cols.filter((c) => !c.consensus).sort((a, b) => b.year - a.year)[0];
      const dartE = histCol ? eok(revWon.get(histCol.year)) : null;
      const naverHist = histCol ? table.rows["매출액"]?.[histCol.key] : null;
      const scale = naverHist != null && dartE != null ? naverScale(naverHist, dartE) : null;
      if (scale == null) {
        blanks.push({
          slot: "FY 추정 매출·순이익·PER",
          reason: `네이버 매출(${naverHist ?? "없음"})과 DART 억원(${dartE ?? "없음"}, ${histCol?.year ?? "?"}) 단위가 맞지 않아 추정 열을 비움`,
        });
      } else {
        const toEok = (v: number | null) => (v == null ? null : truncInt(v / scale));
        estYears = table.cols.filter((c) => c.consensus && (actualYear == null || c.year > actualYear)).map((c) => c.year).sort((a, b) => a - b).slice(0, 2);
        if (estYears.length === 0) blanks.push({ slot: "추정 열", reason: "실적 이후 추정연도가 없음" });
        if (estYears.length < 2) blanks.push({ slot: "추정 2년차", reason: "네이버 컨센서스는 추정연도가 하나뿐" });
        notes.push(`네이버 단위 대조 ${histCol?.year} 매출 비율 ${scale} (1=억원)`);
        sourceLeft = "OpenDART, 네이버(FnGuide 컨센서스)";
        estYears.forEach((y, i) => {
          const col = table.cols.find((c) => c.consensus && c.year === y);
          if (!col) return;
          const idx = i + 1;
          headers[idx] = `FY${y} (e)`;
          const rev = toEok(table.rows["매출액"]?.[col.key] ?? null);
          const net = toEok(table.rows["당기순이익"]?.[col.key] ?? null);
          rows.rev[idx] = fmtInt(rev);
          rows.net[idx] = fmtInt(net);
          const prevRev = i === 0 ? (actualYear != null ? eok(revWon.get(actualYear)) : null) : num(rows.rev[idx - 1]?.replace(/,/g, "") ?? null);
          rows.growth[idx] = fmt2(yoy(rev, prevRev));
          rows.netMargin[idx] = rev && net != null ? fmt2((net / rev) * 100) : "";
          const per = table.rows["PER"]?.[col.key] ?? null;
          rows.per[idx] = fmt2(per);
          blanks.push({ slot: `FY${y} EBITDA·마진`, reason: "추정 감가상각이 없어 EBITDA를 만들지 않음" });
          if (rev == null) blanks.push({ slot: `FY${y} 매출`, reason: "네이버 추정 매출 없음" });
          if (net == null) blanks.push({ slot: `FY${y} 순이익`, reason: "네이버 추정 순이익 없음" });
          if (per == null) blanks.push({ slot: `FY${y} PER`, reason: "네이버 추정 PER 없음" });
        });
      }
    }
  } catch (e) {
    blanks.push({ slot: "추정 열", reason: `네이버 컨센서스 조회 실패 — ${e instanceof Error ? e.message : String(e)}` });
  }

  if (!isTemplate) {
    blanks.push({ slot: "핵심포인트", reason: "앱에 종목 소개 문구가 없어 템플릿(삼성전자) 문장을 지움" });
    blanks.push({ slot: "점유율 표·도넛", reason: "앱에 메모리 점유율(TrendForce 등)이 없음" });
    if (!logo) blanks.push({ slot: "로고", reason: "이 종목 로고 파일이 없음. 삼성 로고는 그대로 두지 않으려면 --logo=png 를 넘긴다. 지금은 템플릿 로고를 유지하지 않고 파일을 바꾸지 않음 — 삼성 로고가 남음" });
  } else {
    notes.push("핵심포인트·점유율 표·도넛·로고·왼쪽 Kodex 그림은 템플릿 유지 (앱에 해당 데이터 없음, 숫자를 만들지 않음)");
    blanks.push({ slot: "핵심포인트", reason: "생성기 없음 — 템플릿 문장(1969년 설립·HBM·DRAM/NAND) 유지" });
    blanks.push({ slot: "점유율(삼성 36.0%·SK 32.1%·마이크론 22.4%)과 도넛", reason: "TrendForce 수집 경로 없음 — 템플릿 숫자 유지. 도넛 캐시 순서(마이크론 36% 등)는 표와 어긋나 있으나 소스가 없어 고치지 않음" });
    blanks.push({ slot: "로고", reason: "템플릿 삼성 로고 유지" });
    blanks.push({ slot: "왼쪽 그림(치킨게임·Kodex ETF CAPEX)", reason: "래스터 캡처. 앱에 같은 차트 데이터 없음 — 그림 유지" });
  }

  const spec = {
    symbol,
    name: corpName,
    chartName: corpName,
    titleRuns,
    keepKeyPoints: isTemplate,
    keyPointRuns: isTemplate ? null : ["핵심포인트 없음 — 앱에 종목 소개 문구가 없습니다."],
    keepShare: isTemplate,
    keepLogo: isTemplate || Boolean(logo),
    logoPath: logo,
    headers,
    rows,
    sourceLeftRuns: ["※ ", "출처 ", ": ", sourceLeft],
    sourceRightRuns: [
      "※ ",
      "출처 ",
      ": ",
      (priceRows ? "금융위(KRX) 시세" : "KRX") + (isTemplate ? ", TrendForce(템플릿)" : ""),
    ],
    prices: priceRows,
    notes,
    blanks,
  };

  const dataPath = resolve(ROOT, "reports/ppt", `${symbol}-trust-onepager.json`);
  mkdirSync(dirname(dataPath), { recursive: true });
  writeFileSync(dataPath, JSON.stringify(spec, null, 2));

  const py = resolve(ROOT, "scripts/ppt/fill_trust_pptx.py");
  const r = spawnSync("python3", [py, "--template", template, "--data", dataPath, "--out", out], { encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(JSON.stringify({ out, dataPath, headers, rows, notes, blanks }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
