import "server-only";
import { createRequire } from "node:module";
import type PptxGenJS from "pptxgenjs";
import { formatNumber, formatPercent } from "@/lib/format";
import type { StockSlideData } from "./slide-data";

// Next/turbopack가 pptxgenjs를 ESM으로 오해 → createRequire로 CJS 강제 로드
const nodeRequire = createRequire(import.meta.url);
const pptxgen = nodeRequire("pptxgenjs") as typeof PptxGenJS;

/**
 * 종목 소개 PPT (4:3). 원본(한화투자증권 MYPICK) 레이아웃:
 * 헤더(번호+제목) · 회사 개요 밴드 · 2×2 그리드(주요사업 / 시장점유율 / 재무제표 / 주가).
 * 네이티브 차트 미사용(2007 호환) — 주가선은 도형으로 직접 그린다.
 */

const F_TITLE = "한화고딕L";
const F_BODY = "한화고딕EL";
const SZ_TITLE = 22;
const SZ_SECTION = 18;
const SZ_BODY = 12;

// 예시.pptx 팔레트
const ORANGE = "F37320";
const INK = "1A1A1A";
const SUB = "8B8B8B";
const RULE = "D6D6D6";
const HEADFILL = "F4EEE7";
const LINE = "333333"; // 주가선
const KEYFILL = "FBF3EA";

const W = 10;
const H = 7.5;

const numf = (v: number | null, d = 0) => (v == null ? "–" : formatNumber(v, d));
const pctf = (v: number | null) => (v == null ? "–" : formatPercent(v, { alreadyPercent: false }));
const perf = (v: number | null) => (v == null ? "–" : `${formatNumber(v, 1)}x`);

function sectionTitle(s: PptxGenJS.Slide, x: number, y: number, w: number, label: string) {
  s.addText(label, {
    x, y, w, h: 0.42, valign: "middle",
    color: ORANGE, fontFace: F_BODY, fontSize: SZ_SECTION, bold: true,
  });
}

function bulletBox(
  s: PptxGenJS.Slide,
  x: number,
  y: number,
  w: number,
  h: number,
  items: string[],
  emptyHint: string,
) {
  s.addShape("rect", { x, y, w, h, fill: { color: "FFFFFF" }, line: { color: RULE, width: 1 } });
  const rows = items.length ? items : [emptyHint];
  s.addText(
    rows.map((t) => ({
      text: t,
      options: {
        bullet: { code: "2013", indent: 12 }, // "–"
        breakLine: true,
        color: items.length ? INK : SUB,
        italic: !items.length,
      },
    })),
    {
      x: x + 0.16, y: y + 0.12, w: w - 0.32, h: h - 0.24, valign: "top",
      fontFace: F_BODY, fontSize: SZ_BODY, lineSpacingMultiple: 1.25,
    },
  );
}

function addSlide(pptx: PptxGenJS, d: StockSlideData) {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };

  // ── 헤더 (예시.pptx 좌표) ────────────────────────────
  s.addText(d.slideNo, {
    x: 0.3, y: 0.24, w: 0.62, h: 0.56, valign: "middle", align: "left",
    color: ORANGE, fontFace: F_TITLE, fontSize: 30, bold: true,
  });
  s.addText(
    [
      { text: d.name, options: { bold: true, color: INK } },
      { text: d.sector ? `  ·  ${d.sector}` : "", options: { color: SUB, fontSize: 14 } },
      { text: `  (${d.symbol})`, options: { color: SUB, fontSize: 14 } },
    ],
    {
      x: 0.96, y: 0.3, w: 6.6, h: 0.5, valign: "middle",
      fontFace: F_TITLE, fontSize: SZ_TITLE,
    },
  );
  if (d.logo) {
    // TradingView 로고는 정사각형 컬러 배지 스타일(와이드 워드마크 아님) —
    // 정사각형 자리에 맞춘다(오너 지시, 2026-09 — 로고 자동 삽입 재도입).
    s.addImage({ data: d.logo, x: 8.98, y: 0.28, w: 0.6, h: 0.6, sizing: { type: "contain", w: 0.6, h: 0.6 } });
  }

  // ── 회사 개요 밴드 (0.43, 1.02, 9.22×0.91) ──────────
  const ovY = 1.02;
  const ovH = 0.91;
  const ovText = d.overview.trim();
  s.addShape("rect", {
    x: 0.43, y: ovY, w: 9.22, h: ovH,
    fill: { color: "FBF3EA" }, line: { color: ORANGE, width: 1 },
  });
  s.addText(ovText || "(회사 설명을 입력하세요)", {
    x: 0.62, y: ovY + 0.06, w: 8.84, h: ovH - 0.12, valign: "middle",
    fontFace: F_BODY, fontSize: SZ_BODY, color: ovText ? INK : SUB, italic: !ovText,
    lineSpacingMultiple: 1.15,
  });

  // ── 영역 제목 (y≈2.55) + 본문 (y≈3.04) ──────────────
  const secY = 2.55;
  const bodyY = 3.04;
  const leftX = 0.49;
  const rightX = 5.14;
  const leftW = 4.4;
  const rightW = 4.5;

  // 좌: 사업 생태계(방사형 다이어그램, AI 자동 생성 또는 직접 입력) — 없으면
  // 기존처럼 주요 사업 불릿 목록으로 대체(오너 지시, 2026-09 — Gemini가
  // 종목명만으로 이 다이어그램을 만들어낸 사례 제시).
  if (d.ecosystem && d.ecosystem.nodes.length > 0) {
    sectionTitle(s, leftX, secY, leftW, "사업 생태계");
    drawEcosystem(s, d.ecosystem, leftX, bodyY, leftW, 2.56);
  } else {
    sectionTitle(s, leftX, secY, leftW, "주요 사업");
    bulletBox(s, leftX, bodyY, leftW, 2.56, d.business, "(주요 사업 내용을 입력하세요)");
  }

  // 우: 핵심 시장점유율 — 실제 데이터 있으면 도넛차트(편집 가능한 네이티브 차트)
  sectionTitle(s, rightX, secY, rightW, "핵심 시장점유율 · 경쟁 구도");
  drawMarketShare(s, d, rightX, bodyY, rightW, 2.56);

  // ── 하단: 재무제표(좌) / 주가차트(우) ───────────────
  const botSecY = 4.78;
  const botBodyY = 5.24;
  sectionTitle(s, leftX, botSecY - 0.02, leftW, `재무제표  (단위: ${d.unitLabel})`);
  drawFinTable(s, d, leftX, botBodyY, leftW);

  sectionTitle(s, rightX, botSecY - 0.02, rightW, d.priceLabel);
  drawPriceChart(s, d, rightX, botBodyY, rightW, 1.78);

  // ── 푸터 (예시 좌표) ────────────────────────────────
  const srcs = [
    `실적 ${d.sources.financials}`,
    d.sources.consensus ? `추정 ${d.sources.consensus}` : null,
    `주가 ${d.sources.price}`,
  ].filter(Boolean).join("  ·  ");
  s.addText(`※ 출처 — ${srcs}`, {
    x: 0.42, y: 7.02, w: 6.5, h: 0.2, color: SUB, fontFace: F_BODY, fontSize: 7.5,
  });
  s.addText(
    "본 자료는 참고용이며 투자 조언이 아닙니다. 추정치는 시장 컨센서스로 실제와 다를 수 있습니다.",
    { x: 0.37, y: 7.24, w: 7.4, h: 0.18, color: SUB, fontFace: F_TITLE, fontSize: 7 },
  );
  if (d.brand) {
    s.addText(d.brand, {
      x: 7.6, y: 7.24, w: 2.0, h: 0.18, align: "right",
      color: SUB, fontFace: F_BODY, fontSize: 7.5,
    });
  }
}

// x1,y1 -> x2,y2 직선 하나 — pptxgenjs의 "line" 도형은 bbox 좌상단→우하단
// 대각선이 기본이라, 실제 두 점의 기울기가 반대 방향(우상향)이면 flipH로
// 대각선을 뒤집어야 한다.
function connectLine(
  s: PptxGenJS.Slide,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1) || 0.01;
  const h = Math.abs(y2 - y1) || 0.01;
  const flipH = x1 < x2 !== y1 < y2;
  s.addShape("line", { x, y, w, h, flipH, line: { color, width: 1 } });
}

const ECO_COLORS = [ORANGE, "2E5C8A", "6B8E23", "8B5FA6", "C0392B", "16A085", "7F8C8D"];

/**
 * 사업 생태계 방사형 다이어그램 — 중심 허브(회사의 사업 본질) + 부채꼴로
 * 펼쳐진 노드(제품/사업부/자회사, 카테고리별 색상 구분) + 연결선. 아이콘까지
 * 손으로 그린 원본 예시(예시.pptx)와 달리 원+텍스트+선만으로 구성 — 이
 * 정도는 좌표 계산만으로 도형 조합이 가능하다(오너 지적, 2026-09 — "불가능
 * 하다"고 했던 게 틀렸음. 원 안에 커스텀 아이콘을 넣는 것만 불가능하고,
 * 방사형 배치 자체는 삼각함수로 계산 가능).
 */
function drawEcosystem(
  s: PptxGenJS.Slide,
  eco: NonNullable<StockSlideData["ecosystem"]>,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const nodes = eco.nodes.slice(0, 10);
  const n = nodes.length;
  const categories: string[] = [];
  for (const node of nodes) {
    const cat = node.category || "기타";
    if (!categories.includes(cat)) categories.push(cat);
  }
  const colorOf = (cat: string) => ECO_COLORS[categories.indexOf(cat || "기타") % ECO_COLORS.length];

  const hubR = 0.4;
  const nodeR = n > 8 ? 0.38 : n > 5 ? 0.42 : 0.48;
  const hubCx = x + w / 2;
  const hubCy = y + h - hubR - 0.04;
  const orbit = Math.min(w / 2 - nodeR - 0.08, hubCy - y - nodeR - 0.04);

  const angleStartDeg = 10;
  const angleEndDeg = 170;
  const pos = nodes.map((node, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const deg = angleStartDeg + t * (angleEndDeg - angleStartDeg);
    const rad = (deg * Math.PI) / 180;
    return { cx: hubCx + orbit * Math.cos(rad), cy: hubCy - orbit * Math.sin(rad), node };
  });

  // 선(원보다 먼저 그려서 원 아래로 깔리게)
  for (const p of pos) connectLine(s, hubCx, hubCy, p.cx, p.cy, RULE);

  // 노드 원 + 라벨
  for (const p of pos) {
    const color = colorOf(p.node.category);
    s.addShape("ellipse", {
      x: p.cx - nodeR, y: p.cy - nodeR, w: nodeR * 2, h: nodeR * 2,
      fill: { color }, line: { color: "FFFFFF", width: 1.5 },
    });
    s.addText(p.node.label, {
      x: p.cx - nodeR + 0.04, y: p.cy - nodeR, w: nodeR * 2 - 0.08, h: nodeR * 2,
      align: "center", valign: "middle", fontFace: F_BODY, fontSize: n > 8 ? 6.5 : 7.5,
      bold: true, color: "FFFFFF", lineSpacingMultiple: 0.9,
    });
  }

  // 허브(중심)
  s.addShape("ellipse", {
    x: hubCx - hubR, y: hubCy - hubR, w: hubR * 2, h: hubR * 2,
    fill: { color: INK }, line: { color: "FFFFFF", width: 2 },
  });
  s.addText(eco.core || "Core", {
    x: hubCx - hubR, y: hubCy - hubR, w: hubR * 2, h: hubR * 2,
    align: "center", valign: "middle", fontFace: F_TITLE, fontSize: 8.5, bold: true, color: "FFFFFF",
  });
}

const SHARE_RE = /^(.+?)\s+([\d.]+)\s*%?$/;
const SHARE_COLORS = [ORANGE, "4A4A4A", "C9C9C9", "F0B27A", "9AA3AF"];

/** "삼성전자 36.0%" 같은 줄을 파싱해 도넛차트로 — 네이티브 차트라 PPT에서 값 수정 가능. */
function drawMarketShare(
  s: PptxGenJS.Slide,
  d: StockSlideData,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const rows = d.marketShare
    .map((line) => line.match(SHARE_RE))
    .filter((m): m is RegExpMatchArray => m != null)
    .map((m) => ({ name: m[1].trim(), value: Number(m[2]) }))
    .filter((r) => Number.isFinite(r.value));

  if (rows.length === 0) {
    s.addShape("rect", {
      x, y, w, h, fill: { color: "FFFFFF" }, line: { color: RULE, width: 1, dashType: "dash" },
    });
    s.addText("직접 작성 영역", {
      x, y: y + h / 2 - 0.15, w, h: 0.3, align: "center",
      color: SUB, fontFace: F_BODY, fontSize: 9, italic: true,
    });
    return;
  }

  s.addChart(
    "doughnut" as PptxGenJS.CHART_NAME,
    [{ name: "시장점유율", labels: rows.map((r) => r.name), values: rows.map((r) => r.value) }],
    {
      x, y, w, h,
      chartColors: SHARE_COLORS,
      showLegend: true,
      legendPos: "r",
      legendFontFace: F_BODY,
      legendFontSize: 8,
      dataLabelColor: "FFFFFF",
      showValue: true,
      showPercent: false,
      dataLabelFontSize: 9,
      dataLabelFormatCode: "0.0",
    },
  );
}

function drawFinTable(s: PptxGenJS.Slide, d: StockSlideData, x: number, y: number, w: number) {
  const f = d.fin;
  const cellFont = 9;
  const head = (t: string, i: number): PptxGenJS.TableCell => ({
    text: t,
    options: {
      bold: true, color: INK, fill: { color: HEADFILL }, fontFace: F_BODY, fontSize: cellFont,
      align: (i === 0 ? "left" : "right") as PptxGenJS.HAlign,
    },
  });
  const cell = (t: string, o: Partial<PptxGenJS.TableCellProps> = {}): PptxGenJS.TableCell => ({
    text: t,
    options: { fontFace: F_BODY, fontSize: cellFont, color: INK, valign: "middle", ...o },
  });
  const key = (label: string, vals: string[]): PptxGenJS.TableRow => [
    cell(label, { bold: true, fill: { color: KEYFILL } }),
    ...vals.map((v) => cell(v, { align: "right", bold: true, fill: { color: KEYFILL } })),
  ];
  const sub = (label: string, vals: string[]): PptxGenJS.TableRow => [
    cell(label, { italic: true, color: SUB }),
    ...vals.map((v) => cell(v, { align: "right", italic: true, color: SUB })),
  ];
  const norm = (label: string, vals: string[]): PptxGenJS.TableRow => [
    cell(label),
    ...vals.map((v) => cell(v, { align: "right" })),
  ];

  const rows: PptxGenJS.TableRow[] = [
    ["구분", ...f.years].map(head),
    key("매출액", f.revenue.map((v) => numf(v))),
    sub("  성장률(YoY)", f.revenueGrowth.map(pctf)),
    key("순이익", f.netIncome.map((v) => numf(v))),
    sub("  마진율", f.netMargin.map(pctf)),
    norm("EPS", f.eps.map((v) => numf(v, 2))),
    norm("PER", f.per.map(perf)),
  ];
  const c1 = 1.25;
  const cv = (w - c1) / 3;
  s.addTable(rows, {
    x, y, w, colW: [c1, cv, cv, cv],
    border: { type: "solid", color: RULE, pt: 0.5 },
    rowH: 0.26, valign: "middle", fontFace: F_BODY,
  });
}

const downsample = <T,>(a: T[], n: number) => {
  if (a.length <= n) return a;
  const step = a.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(a[Math.floor(i * step)]);
  out.push(a[a.length - 1]);
  return out;
};

/** 주가(좌축) + 나스닥(우축) 이중축 라인차트 — 네이티브 차트(PPT에서 데이터 수정 가능). */
function drawPriceChart(
  s: PptxGenJS.Slide,
  d: StockSlideData,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  if (d.price.length < 5) {
    s.addShape("rect", { x, y, w, h, fill: { color: "FFFFFF" }, line: { color: RULE, width: 1 } });
    s.addText("주가 데이터 없음", {
      x, y: y + h / 2 - 0.2, w, h: 0.4, align: "center", color: SUB, fontFace: F_BODY, fontSize: 9,
    });
    return;
  }

  const calloutH = 0.22;
  const A = downsample(d.price, 60);
  const B = d.bench.length >= 5 ? downsample(d.bench, 60) : [];
  const dl = (iso: string) => iso.slice(2).replace(/-/g, ".");

  // pptxgenjs 4.0.1의 콤보(이중축) 차트는 라이브러리 자체 버그로 write() 시
  // "(colorStr || "").replace is not a function" 에러를 낸다(옵션과 무관 —
  // 가장 단순한 2-시리즈 콤보도 재현됨). 단일축 라인차트로 우회: 두 시리즈를
  // 시작일=100 지수로 정규화해 같은 축에 놓는다(네이티브 차트라 데이터는 그대로 유지).
  const a0 = A[0].close;
  const b0 = B.length ? B[0].close : 1;
  const idxA = A.map((p) => (p.close / a0) * 100);
  const chartSeries = [
    { name: d.name, labels: A.map((p) => dl(p.date)), values: idxA },
  ];
  if (B.length) {
    chartSeries.push({
      name: d.benchLabel,
      labels: B.map((p) => dl(p.date)),
      values: B.map((p) => (p.close / b0) * 100),
    });
  }

  s.addChart("line" as PptxGenJS.CHART_NAME, chartSeries, {
    x, y: y + calloutH, w, h: h - calloutH,
    chartColors: [LINE, "9AA3AF"],
    lineSize: 1.5,
    lineDataSymbol: "none",
    showLegend: true, legendPos: "t", legendFontFace: F_BODY, legendFontSize: 7,
    catAxisLabelFontFace: F_BODY, catAxisLabelFontSize: 7, catAxisLabelColor: SUB,
    valAxisLabelFontFace: F_BODY, valAxisLabelFontSize: 7, valAxisLabelColor: SUB,
    valAxisTitle: "시작일=100",
    showValAxisTitle: true,
    valAxisTitleFontSize: 7,
    dataLabelFontSize: 0,
    valGridLine: { style: "dash", color: RULE, size: 0.5 },
  });

  // 상단: 현재가·등락
  const last = d.price[d.price.length - 1].close;
  const first = d.price[0].close;
  const chg = first ? (last - first) / first : 0;
  s.addText(
    [
      { text: `${formatNumber(last, 2)} ${d.currency}  `, options: { bold: true, color: INK, fontSize: 9 } },
      {
        text: `${chg >= 0 ? "▲" : "▼"} ${formatPercent(Math.abs(chg), { alreadyPercent: false })}`,
        options: { color: chg >= 0 ? "1F8A4C" : "C0392B", fontSize: 8 },
      },
    ],
    { x, y, w, h: calloutH, fontFace: F_BODY, align: "right" },
  );
}

export async function buildStockPptx(slides: StockSlideData[]): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "SCREEN4X3", width: W, height: H });
  pptx.layout = "SCREEN4X3";
  pptx.theme = { headFontFace: F_TITLE, bodyFontFace: F_BODY };
  pptx.author = "글로벌 종목 리서치";
  for (const d of slides) addSlide(pptx, d);
  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}
