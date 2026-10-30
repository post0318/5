/**
 * 종목 1페이지 PPT 생성기 — 종목 하나 + 회사별 설정 → 슬라이드 1장 (docs/ppt/00-requirements.md · 01-template-analysis.md).
 *
 * 숫자는 따로 계산하지 않고 앱의 단일 기준 결과를 그대로 받는다(실행 중인 앱 API):
 *   실적 열 = 하이라이트(/highlights — 시장별 단일 기준 함수), 예상(e) 열 = Yahoo 컨센서스(오너 답 3 — FnGuide 안 씀),
 *   주가·지수 = 앱 시세(/price-chart, Yahoo 일별 종가).
 * 회사별 설정(settings JSON)은 사람·MCP 에이전트가 고르는 것 — 개요·투자 포인트, 점유율(사업·항목·출처·기준 시점),
 * 핵심 사업(내용 + 출처 — 칸 형식은 오너 샘플 대기), 로고 파일, 표시 이름, 상품명. 설정이 없으면 빈칸 + 사유(그림자 채우기 금지).
 * 화면(발표자료 작성 화면)·저장소·일괄 생성 방식은 오너 결정 전이라 만들지 않았다 — 이 함수가 그 핵심이다.
 *
 * 실행:
 *   npx tsx --tsconfig tsconfig.json scripts/ppt/onepager.mts --market=kr --symbol=005930 \
 *     [--settings=설정.json] [--base=http://127.0.0.1:3000] [--template=~/ppt/out/template.pptx] [--out-dir=~/ppt/out/onepager] [--render]
 * 결과: {outDir}/{market}_{symbol}.pptx · .spec.json · .report.json (· .png 렌더링)
 * 템플릿·결과물은 사내한 자료라 저장소 밖에 둔다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatNumber } from "@/lib/format";

type Market = "kr" | "us" | "jp";

export interface PointSource { title: string; publisher: string; publishedAt: string; url?: string }

/** 회사별 설정 — 발표자료 작성 화면(미정)이 저장할 내용과 같은 모양. 전부 선택 항목. */
export interface OnepagerSettings {
  displayName?: string;
  productName?: string;
  /**
   * 투자포인트(오너 2026-10-31) — 세 줄: ① 설립연도·사업·점유율 ② 현재 사업 부문과 차별점 ③ 종합 핵심 투자포인트.
   * 문장마다 출처(제목·매체·발행일·주소) 필수 — 출처 없는 문장은 넣지 않는다. 작성은 claude.ai 커넥터(설계안 docs/ppt/02-points-connector.md).
   */
  points?: { kind: "founding" | "business" | "thesis"; text: string; sources: PointSource[] }[];
  logo?: { path: string };
  /** 점유율 — 항목별 출처는 내장 엑셀 시트에 보관, 슬라이드에는 하단 출처 한 줄로만. */
  share?: { title: string; source: string; asOf: string; url?: string; items: { name: string; value: number }[] };
  /** 핵심 사업 칸 — 형식은 오너 샘플 대기(차트·표·짧은 글 자유). 출처(문서·기준 시점)가 반드시 붙는다. */
  coreBusiness?: { title?: string; items?: { name: string; value?: number; unit?: string }[]; text?: string[]; source: { doc: string; asOf: string; url?: string } };
}

interface HlRow { key: string; label: string; values: (number | null)[]; cellNotes?: (string | null)[] }
interface Highlights {
  currency: string;
  columns: { key: string; label: string; date: string; kind: "fy" | "ltm" | "estimate" }[];
  rows: HlRow[];
  valuationRows?: HlRow[];
  source?: string;
}
interface ConsRow { fy: number; isEstimate: boolean; revenue: number | null; revenueYoY: number | null; netIncome: number | null; eps: number | null; per: number | null }
interface Consensus { rows: ConsRow[]; asOf?: string | null }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** 금액 단위 사다리(오너 2026-10-31): 표 크기는 고정, 숫자가 칸에 안 들어가면 글자를 줄이지 않고 다음 단위로(소수 둘째 자리, 버림). */
type Unit = { div: number; digits: number; header: string };
const MARKET_INFO: Record<Market, { sourceName: string; units: Unit[]; finSource: string; priceFormat: string; axisFormat: string }> = {
  kr: { sourceName: "DART", units: [{ div: 1e8, digits: 0, header: "구분(억원)" }, { div: 1e12, digits: 2, header: "구분(조원)" }], finSource: "OpenDART", priceFormat: "#,##0", axisFormat: "#,##0" },
  us: { sourceName: "SEC EDGAR", units: [{ div: 1e6, digits: 0, header: "구분(백만달러)" }, { div: 1e9, digits: 2, header: "구분(십억달러)" }], finSource: "SEC EDGAR", priceFormat: "#,##0.00", axisFormat: "#,##0" },
  jp: { sourceName: "EDINET", units: [{ div: 1e8, digits: 0, header: "구분(억엔)" }, { div: 1e12, digits: 2, header: "구분(조엔)" }], finSource: "EDINET", priceFormat: "#,##0", axisFormat: "#,##0" },
};
/** 재무표 값 칸 폭(템플릿 2.76cm − 칸 안쪽 여백) · 글자 12pt(오너 2026-10-31). 숫자·콤마 폭은 대체 글꼴 실측보다 넉넉히 0.6em 로 본다. */
const FIN_CELL_CM = 2.76 - 0.1;
const FIN_PT = 12;
/** 하단 출처 한 줄 — 템플릿 #6(왼쪽 아래)을 오른쪽 출처 칸(#7) 끝까지 넓혀 한 줄로(오너 2026-10-31). 8pt, 한글 1em·그 밖 0.55em 근사. */
const SOURCE_LINE_CM = 28.35 - 1.25 - 0.5;
const sourceWidthCm = (s: string) =>
  ([...s].reduce((a, c) => a + (/[가-힣ㄱ-ㅎ一-龥ぁ-ヿ]/.test(c) ? 1 : c === " " ? 0.3 : 0.55), 0) * 8) / 72 * 2.54;
const numWidthCm = (s: string) => (s.length * 0.6 * FIN_PT) / 72 * 2.54;
const LABELS = {
  revenue: "매출액",
  growth: "  성장률% , YoY",
  ebitda: "EBITDA",
  ebitdaMargin: "  마진율 (%)",
  net: "순이익",
  netMargin: "  마진율 (%)",
  per: "PER",
} as const;
type RowKey = keyof typeof LABELS;

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const home = (p: string) => p.replace(/^~(?=\/)/, homedir());

async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(240_000) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const amt = (v: number | null | undefined, u: Unit) => (v == null ? "" : formatNumber(v / u.div, u.digits, { fallback: "" }));
const pct = (v: number | null | undefined) => formatNumber(v ?? null, 2, { fallback: "" });

function ymdKst(d = new Date()): string {
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

/** 핵심 함수: 종목 하나 + 설정 → 채우기 입력(spec). 파일은 쓰지 않는다. */
export async function buildOnepagerSpec(market: Market, symbol: string, settings: OnepagerSettings, base: string) {
  const mi = MARKET_INFO[market];
  const blanks: { slot: string; reason: string }[] = [];
  const enc = encodeURIComponent(symbol);

  const [ov, hlRes, cons] = await Promise.all([
    getJson<{ profile: { name: string } }>(base, `/api/markets/${market}/${enc}/overview`),
    getJson<{ highlights: Highlights }>(base, `/api/markets/${market}/${enc}/highlights`),
    getJson<Consensus>(base, `/api/markets/${market}/${enc}/consensus`),
  ]);
  const hl = hlRes.highlights;
  const name = settings.displayName ?? ov.profile.name.replace(/\(주\)|㈜/g, "").trim();
  const title = market === "kr" ? `${name} 보통주 (${symbol})` : `${name} (${symbol})`;

  // ── 재무표: 최근 사업연도 실적 + FY+1(e)·FY+2(e) ──
  const fyIdx = hl.columns.map((c, i) => (c.kind === "fy" ? i : -1)).filter((i) => i >= 0).at(-1);
  if (fyIdx == null) throw new Error("하이라이트에 사업연도 열이 없음");
  const fyKey = hl.columns[fyIdx].key; // "FY2025"
  const fy = Number(fyKey.slice(2));
  const row = (k: string) => hl.rows.find((r) => r.key === k) ?? hl.valuationRows?.find((r) => r.key === k);
  const raw: Record<RowKey, (number | null)[]> = { revenue: [], growth: [], ebitda: [], ebitdaMargin: [], net: [], netMargin: [], per: [] };
  const hlMap: Record<RowKey, string> = { revenue: "revenue", growth: "revenue_yoy", ebitda: "ebitda", ebitdaMargin: "ebitda_m", net: "ni", netMargin: "ni_m", per: "per" };
  const isAmt = (k: RowKey) => k === "revenue" || k === "ebitda" || k === "net";

  for (const k of Object.keys(LABELS) as RowKey[]) {
    const r = row(hlMap[k]);
    const v = r?.values[fyIdx] ?? null;
    raw[k].push(v);
    if (v == null) blanks.push({ slot: `재무표 ${fyKey} ${LABELS[k].trim()}`, reason: r?.cellNotes?.[fyIdx] ?? "앱 하이라이트에 값 없음" });
  }

  // 예상(e): Yahoo 컨센서스. 미국·일본 하이라이트의 예상 열이 같은 Yahoo 값(+ 앱 규칙 예상 순이익 = 예상 EPS × 현재 주식수)이라 그것을 쓰고,
  // 한국 하이라이트 예상 열은 네이버(FnGuide) 값이라 쓰지 않고 컨센서스 API 의 Yahoo 행을 쓴다(순이익 예상은 Yahoo 에 없음 → 빈칸).
  const consAsOf = cons.asOf ?? ymdKst();
  const headers = [`FY${fy}`];
  for (const ey of [fy + 1, fy + 2]) {
    headers.push(`FY${ey} (e)`);
    if (market === "kr") {
      const c = cons.rows.find((r) => r.isEstimate && r.fy === ey);
      if (!c) blanks.push({ slot: `재무표 FY${ey}(e) 전체`, reason: "Yahoo 컨센서스에 이 연도 예상 없음" });
      const vals: Record<RowKey, number | null> = {
        revenue: c?.revenue ?? null,
        growth: c?.revenueYoY ?? null,
        ebitda: null,
        ebitdaMargin: null,
        net: c?.netIncome ?? null,
        netMargin: c?.netIncome != null && c?.revenue ? (c.netIncome / c.revenue) * 100 : null,
        per: c?.per ?? null,
      };
      for (const k of Object.keys(LABELS) as RowKey[]) {
        raw[k].push(vals[k]);
        if (c && vals[k] == null) blanks.push({ slot: `재무표 FY${ey}(e) ${LABELS[k].trim()}`, reason: k.startsWith("ebitda") ? "Yahoo 컨센서스에 EBITDA 예상 없음" : "Yahoo 컨센서스에 값 없음" });
      }
    } else {
      const ci = hl.columns.findIndex((c) => c.kind === "estimate" && c.key === `FY${ey}E`);
      if (ci < 0) blanks.push({ slot: `재무표 FY${ey}(e) 전체`, reason: "Yahoo 컨센서스에 이 연도 예상 없음" });
      for (const k of Object.keys(LABELS) as RowKey[]) {
        const r = row(hlMap[k]);
        const v = ci >= 0 ? (r?.values[ci] ?? null) : null;
        raw[k].push(v);
        if (ci >= 0 && v == null) blanks.push({ slot: `재무표 FY${ey}(e) ${LABELS[k].trim()}`, reason: r?.cellNotes?.[ci] ?? (k.startsWith("ebitda") ? "Yahoo 컨센서스에 EBITDA 예상 없음" : "Yahoo 컨센서스에 값 없음") });
      }
    }
  }
  // 단위: 금액 칸이 모두 들어가는 가장 작은 단위
  const keys = Object.keys(LABELS) as RowKey[];
  const fmtAll = (u: Unit) =>
    Object.fromEntries(keys.map((k) => [k, raw[k].map((v) => (isAmt(k) ? amt(v, u) : pct(v)))])) as Record<RowKey, string[]>;
  let unit = mi.units[0];
  let rows = fmtAll(unit);
  for (const u of mi.units) {
    unit = u;
    rows = fmtAll(u);
    if (keys.every((k) => rows[k].every((c) => numWidthCm(c) <= FIN_CELL_CM))) break;
  }
  const tooWide = keys.flatMap((k) => rows[k].filter((c) => numWidthCm(c) > FIN_CELL_CM));
  if (tooWide.length) blanks.push({ slot: "재무표 칸 폭", reason: `가장 큰 단위(${unit.header})로도 칸을 넘는 값: ${tooWide.join(", ")}` });

  // ── 주가 차트: 종목 + 비교 지수(한국 코스피·코스닥 / 미국 S&P500 / 일본 닛케이225), 기간 = 최근 3년(일별 종가), 가로축 반기 「YY-MM」 ──
  let price: Record<string, unknown> | null = null;
  let priceReason: string | null = null;
  let priceAsOf = "";
  try {
    let indexTicker = market === "us" ? "^GSPC" : market === "jp" ? "^N225" : "^KS11";
    let indexName = market === "us" ? "S&P500" : market === "jp" ? "닛케이225" : "KOSPI";
    if (market === "kr") {
      // 코스닥 종목 판정 = Yahoo 에 .KS 가 없고 .KQ 가 있음
      const ks = await getJson<{ rows: unknown[] }>(base, `/api/markets/kr/${enc}/price-chart?yahoo=${encodeURIComponent(`${symbol}.KS`)}`).catch((e: unknown) => {
        console.warn(`[ppt] ${symbol}.KS 시세 없음 — 코스닥으로 판정: ${e instanceof Error ? e.message : String(e)}`);
        return { rows: [] as unknown[] };
      });
      if (ks.rows.length < 2) {
        indexTicker = "^KQ11";
        indexName = "KOSDAQ";
      }
    }
    type Bars = { rows: { date: string; close: number }[] };
    const [st, ix] = await Promise.all([
      getJson<Bars>(base, `/api/markets/${market}/${enc}/price-chart`),
      getJson<Bars>(base, `/api/markets/${market}/${enc}/price-chart?yahoo=${encodeURIComponent(indexTicker)}`),
    ]);
    const today = ymdKst();
    const from = `${Number(today.slice(0, 4)) - 3}${today.slice(4)}`; // 최근 3년(오너 2026-10-31)
    const ixBy = new Map(ix.rows.map((r) => [r.date, r.close]));
    const days = st.rows.filter((r) => r.date >= from && ixBy.has(r.date));
    if (days.length < 100) {
      priceReason = `종목·지수 공통 거래일이 ${days.length}일뿐 (종목 ${st.rows.length}일, 지수 ${ix.rows.length}일)`;
    } else {
      priceAsOf = days.at(-1)!.date;
      price = {
        dates: days.map((r) => r.date),
        stock: days.map((r) => r.close),
        index: days.map((r) => Math.trunc(ixBy.get(r.date)! * 100) / 100),
        stockName: name,
        indexName,
        source: `Yahoo Finance 일별 종가(${indexTicker})`,
        asOf: priceAsOf,
        priceFormat: mi.priceFormat,
        axisFormat: mi.axisFormat,
      };
    }
  } catch (e) {
    priceReason = `시세 조회 실패 — ${e instanceof Error ? e.message : String(e)}`;
  }

  const share = settings.share ?? null;
  const coreBusiness = settings.coreBusiness ?? null;

  // 투자포인트: 출처 없는 문장은 넣지 않는다(빈칸 + 사유)
  const points = (settings.points ?? []).filter((p) => {
    const ok = p.sources?.length && p.sources.every((s) => s.publisher && s.publishedAt);
    if (!ok) blanks.push({ slot: `투자포인트(${p.kind})`, reason: "출처(매체·발행일) 없는 문장 — 넣지 않음" });
    return ok;
  });

  // 하단 출처 한 줄(오너 2026-10-31): 쓰인 출처를 중복 없이 모은다. 매체마다 한 번(날짜가 여럿이면 가장 늦은 날짜).
  const used: { name: string; date: string | null }[] = [{ name: mi.sourceName, date: null }];
  if (consAsOf) used.push({ name: "Yahoo Finance", date: null });
  if (price) used.push({ name: "Yahoo Finance", date: null });
  if (share) used.push({ name: share.source, date: share.asOf });
  if (coreBusiness) used.push({ name: coreBusiness.source.doc, date: coreBusiness.source.asOf });
  for (const p of points) for (const s of p.sources) used.push({ name: s.publisher, date: s.publishedAt });
  const byName = new Map<string, string | null>();
  for (const u of used) {
    const prev = byName.get(u.name);
    byName.set(u.name, prev == null ? u.date : u.date != null && u.date > prev ? u.date : prev);
  }
  const withDates = `※ 출처 : ${[...byName].map(([n, d]) => (d ? `${n}(${d})` : n)).join(", ")}`;
  const noDates = `※ 출처 : ${[...byName.keys()].join(", ")}`;
  const sourceLine = sourceWidthCm(withDates) <= SOURCE_LINE_CM ? withDates : noDates;
  if (sourceWidthCm(sourceLine) > SOURCE_LINE_CM) blanks.push({ slot: "하단 출처 줄", reason: `한 줄(8pt)을 넘음 — 매체를 묶어 줄여야 함: ${sourceLine}` });
  const sources = {
    fin: `${mi.finSource}(FY${fy} 실적), Yahoo Finance 컨센서스(예상, ${consAsOf} 기준)`,
    price: price ? `Yahoo Finance 일별 종가(주가·지수, ${priceAsOf})` : null,
    share: share ? `${share.source}(${share.asOf})${share.url ? ` ${share.url}` : ""}` : null,
    coreBusiness: coreBusiness ? `${coreBusiness.source.doc}(${coreBusiness.source.asOf})` : null,
    points: points.map((p) => p.sources),
  };

  return {
    market,
    symbol,
    title,
    overview: points.map((p) => p.text),
    points,
    overviewReason: points.length ? null : "회사별 설정에 투자포인트 없음(커넥터 작성 미연결)",
    productName: settings.productName ?? null,
    logo: settings.logo?.path ? { path: home(settings.logo.path) } : { reason: "회사별 설정에 로고 없음(로고 서비스 미선정)" },
    fin: { unitHeader: unit.header, unitChanged: unit !== mi.units[0], headers, labels: LABELS, rows },
    sourceLine,
    sources,
    price,
    priceReason,
    share,
    shareReason: share ? null : "회사별 설정에 점유율(사업·출처·기준 시점) 없음",
    coreBusiness,
    coreBusinessReason: coreBusiness ? null : "회사별 설정에 핵심 사업 자료 없음(칸 형식은 오너 샘플 대기)",
    blanks,
    asOf: ymdKst(),
  };
}

function run(cmd: string, args: string[], allowStatus: number[] = [0]): number {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status == null || !allowStatus.includes(r.status)) throw new Error(`${cmd} 실패(종료코드 ${r.status})`);
  return r.status;
}

async function main() {
  const market = (arg("market") ?? "kr") as Market;
  if (!(market in MARKET_INFO)) throw new Error(`알 수 없는 시장 ${market}`);
  const symbol = arg("symbol");
  if (!symbol) throw new Error("--symbol 필요");
  const base = arg("base") ?? "http://127.0.0.1:3000";
  const template = home(arg("template") ?? "~/ppt/out/template.pptx");
  const outDir = home(arg("out-dir") ?? "~/ppt/out/onepager");
  const settingsPath = arg("settings");
  const settings: OnepagerSettings = settingsPath ? JSON.parse(readFileSync(home(settingsPath), "utf8")) : {};
  const py = existsSync(home("~/ppt/venv/bin/python")) ? home("~/ppt/venv/bin/python") : "python3";

  const spec = await buildOnepagerSpec(market, symbol, settings, base);
  mkdirSync(outDir, { recursive: true });
  const stem = resolve(outDir, `${market}_${symbol}${arg("tag") ? `_${arg("tag")}` : ""}`);
  writeFileSync(`${stem}.spec.json`, JSON.stringify(spec, null, 2));
  run(py, [resolve(ROOT, "scripts/ppt/onepager_fill.py"), "--template", template, "--spec", `${stem}.spec.json`, "--out", `${stem}.pptx`, "--report", `${stem}.report.json`]);
  // 점검 실패(종료코드 2)여도 렌더링까지 해서 눈으로 볼 수 있게 하고, 마지막에 실패로 끝낸다.
  const checkStatus = run(py, [resolve(ROOT, "scripts/ppt/onepager_check.py"), "--pptx", `${stem}.pptx`, "--spec", `${stem}.spec.json`, "--report", `${stem}.report.json`], [0, 2]);
  if (process.argv.includes("--render")) {
    run("soffice", ["--headless", "--convert-to", "pdf", "--outdir", outDir, `${stem}.pptx`]);
    run("pdftoppm", ["-r", "150", "-png", "-singlefile", `${stem}.pdf`, stem]);
    console.log(`렌더링 ${stem}.png`);
  }
  if (checkStatus !== 0) throw new Error(`점검 실패 — ${stem}.report.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
