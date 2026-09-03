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

const NAVY = "1B3A6B";
const ORANGE = "E8720C";
const GOLD = "F5A623";
const INK = "1A1A1A";
const SUB = "6E6E6E";
const RULE = "CFD6E0";
const HEADFILL = "EDEFF3";
const KEYFILL = "F3F1E7";

const W = 10;
const H = 7.5;
const MX = 0.4;

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

  // ── 헤더 ─────────────────────────────────────────────
  s.addText("종목", {
    x: MX, y: 0.22, w: 1.0, h: 0.6, valign: "middle", align: "center",
    color: "FFFFFF", fontFace: F_TITLE, fontSize: 20, bold: true, fill: { color: NAVY },
  });
  s.addShape("rect", { x: MX, y: 0.84, w: 1.0, h: 0.05, fill: { color: NAVY } });
  s.addText(`투자종목  ${d.name}  (${d.symbol})`, {
    x: MX + 1.2, y: 0.22, w: W - MX * 2 - 1.2, h: 0.6, valign: "middle",
    color: NAVY, fontFace: F_TITLE, fontSize: SZ_TITLE, bold: true,
  });

  // ── 회사 개요 밴드 ──────────────────────────────────
  const ovY = 1.05;
  const ovLines = d.overview ? d.overview.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
  const ovH = 1.0;
  s.addShape("roundRect", {
    x: MX, y: ovY, w: W - MX * 2, h: ovH, rectRadius: 0.02,
    fill: { color: "FBF6F0" }, line: { color: GOLD, width: 1 },
  });
  s.addText(
    (ovLines.length ? ovLines : ["(회사 설명을 입력하세요)"]).map((t) => ({
      text: t,
      options: {
        bullet: { code: "2013", indent: 12 },
        breakLine: true,
        color: ovLines.length ? INK : SUB,
        italic: !ovLines.length,
      },
    })),
    {
      x: MX + 0.22, y: ovY + 0.1, w: W - MX * 2 - 0.44, h: ovH - 0.2, valign: "middle",
      fontFace: F_BODY, fontSize: SZ_BODY, lineSpacingMultiple: 1.2,
    },
  );

  // ── 2×2 그리드 ──────────────────────────────────────
  const gridTop = ovY + ovH + 0.3;
  const gap = 0.3;
  const colW = (W - MX * 2 - gap) / 2;
  const leftX = MX;
  const rightX = MX + colW + gap;
  const rowH = 2.32;
  const r1 = gridTop;
  const r2 = gridTop + rowH + 0.34;
  const boxOff = 0.46; // 영역제목 높이

  // TL — 주요 사업
  sectionTitle(s, leftX, r1, colW, "주요 사업");
  bulletBox(s, leftX, r1 + boxOff, colW, rowH - boxOff, d.business, "(주요 사업 내용을 입력하세요)");

  // TR — 핵심 시장점유율
  sectionTitle(s, rightX, r1, colW, "핵심 시장점유율 · 경쟁 구도");
  bulletBox(s, rightX, r1 + boxOff, colW, rowH - boxOff, d.marketShare, "(시장 점유율·경쟁 구도를 입력하세요)");

  // BL — 재무제표
  sectionTitle(s, leftX, r2, colW, `재무제표  (단위: ${d.unitLabel})`);
  drawFinTable(s, d, leftX, r2 + boxOff, colW);

  // BR — 주가
  sectionTitle(s, rightX, r2, colW, d.priceLabel);
  drawPriceChart(s, d, rightX, r2 + boxOff + 0.06, colW, rowH - boxOff - 0.2);

  // ── 푸터 ─────────────────────────────────────────────
  const srcs = [
    `실적 ${d.sources.financials}`,
    d.sources.consensus ? `추정 ${d.sources.consensus}` : null,
    `주가 ${d.sources.price}`,
  ].filter(Boolean).join("  ·  ");
  s.addShape("rect", { x: 0, y: H - 0.5, w: W, h: 0.012, fill: { color: RULE } });
  s.addText(`※ 출처 — ${srcs}`, {
    x: MX, y: H - 0.46, w: W - MX * 2, h: 0.18, color: SUB, fontFace: F_BODY, fontSize: 7,
  });
  s.addText(
    "본 자료는 이해를 돕기 위한 참고용이며 투자 조언이 아닙니다. 추정치는 시장 컨센서스로 실제와 다를 수 있습니다.",
    { x: MX, y: H - 0.28, w: W - MX * 2, h: 0.2, color: SUB, fontFace: F_BODY, fontSize: 7, italic: true },
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

/** 주가(좌축) + 나스닥(우축) 이중축 라인차트를 도형으로 직접 그림 (2007 호환) */
function drawPriceChart(
  s: PptxGenJS.Slide,
  d: StockSlideData,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  s.addShape("rect", { x, y, w, h, fill: { color: "FFFFFF" }, line: { color: RULE, width: 1 } });
  if (d.price.length < 5) {
    s.addText("주가 데이터 없음", {
      x, y: y + h / 2 - 0.2, w, h: 0.4, align: "center", color: SUB, fontFace: F_BODY, fontSize: 9,
    });
    return;
  }
  const pl = 0.5;
  const pr = 0.55;
  const ptop = 0.3;
  const pbot = 0.34;
  const plotW = w - pl - pr;
  const plotH = h - ptop - pbot;

  const A = downsample(d.price, 110);
  const B = d.bench.length >= 5 ? downsample(d.bench, 110) : [];
  const a0 = A[0].close;
  const b0 = B.length ? B[0].close : 1;
  // 좌축 = 종목의 (3년) 저가~고가. 시작시점 비율(=1)을 좌우 공통 기준으로 삼아
  // 나스닥도 동일 비율축에 얹는다(범위 밖은 클램프).
  const aRatios = A.map((p) => p.close / a0);
  const rLo = Math.min(...aRatios);
  const rHi = Math.max(...aRatios);
  const rRange = rHi - rLo || 1;
  const cx = (i: number, n: number) => pl + (i / (n - 1)) * plotW;
  const clamp = (v: number) => Math.min(ptop + plotH, Math.max(ptop, v));
  const cyR = (r: number) => clamp(ptop + (1 - (r - rLo) / rRange) * plotH);

  // 가로 가이드 3줄 — 같은 비율선에 좌(주가)·우(나스닥) 값 각각 표기
  for (let g = 0; g <= 2; g++) {
    const r = rLo + (rRange * g) / 2;
    const gy = cyR(r);
    s.addShape("line", {
      x: x + pl, y: y + gy, w: plotW, h: 0,
      line: { color: RULE, width: 0.5, dashType: "dash" },
    });
    s.addText(formatNumber(a0 * r, 0), {
      x: x + 0.02, y: y + gy - 0.1, w: pl - 0.06, h: 0.2,
      align: "right", color: NAVY, fontFace: F_BODY, fontSize: 7,
    });
    if (B.length) {
      s.addText(formatNumber(b0 * r, 0), {
        x: x + w - pr + 0.03, y: y + gy - 0.1, w: pr - 0.05, h: 0.2,
        align: "left", color: SUB, fontFace: F_BODY, fontSize: 7,
      });
    }
  }

  // 나스닥 (회색)
  if (B.length) {
    const bPts: NonNullable<PptxGenJS.ShapeProps["points"]> = B.map((p, i) => ({
      x: cx(i, B.length), y: cyR(p.close / b0), ...(i === 0 ? { moveTo: true } : {}),
    }));
    s.addShape("custGeom" as PptxGenJS.SHAPE_NAME, { x, y, w, h, points: bPts, fill: { type: "none" }, line: { color: "9AA3AF", width: 1 } });
  }

  // 종목 (네이비) — 영역 + 선
  const aPts: NonNullable<PptxGenJS.ShapeProps["points"]> = A.map((p, i) => ({
    x: cx(i, A.length), y: cyR(p.close / a0), ...(i === 0 ? { moveTo: true } : {}),
  }));
  s.addShape("custGeom" as PptxGenJS.SHAPE_NAME, {
    x, y, w, h,
    points: [...aPts, { x: cx(A.length - 1, A.length), y: ptop + plotH }, { x: cx(0, A.length), y: ptop + plotH }, { close: true }],
    fill: { color: NAVY, transparency: 90 },
    line: { type: "none" },
  });
  s.addShape("custGeom" as PptxGenJS.SHAPE_NAME, { x, y, w, h, points: aPts, fill: { type: "none" }, line: { color: NAVY, width: 1.75 } });

  // x축 라벨
  const dl = (i: number) => A[i].date.slice(2).replace(/-/g, ".");
  s.addText(
    [
      { text: dl(0), options: { align: "left" } },
      { text: dl(Math.floor(A.length / 2)), options: { align: "center" } },
      { text: dl(A.length - 1), options: { align: "right" } },
    ],
    { x: x + pl, y: y + h - pbot + 0.04, w: plotW, h: 0.16, color: SUB, fontFace: F_BODY, fontSize: 7 },
  );

  // 상단: 현재가·등락 + 범례
  const last = d.price[d.price.length - 1].close;
  const first = d.price[0].close;
  const chg = first ? (last - first) / first : 0;
  s.addText(
    [
      { text: "■ ", options: { color: NAVY, fontSize: 8 } },
      { text: `${d.name}   `, options: { color: INK, fontSize: 7.5 } },
      { text: "■ ", options: { color: "9AA3AF", fontSize: 8 } },
      { text: d.benchLabel, options: { color: SUB, fontSize: 7.5 } },
    ],
    { x: x + pl, y: y + 0.04, w: plotW * 0.6, h: 0.2, fontFace: F_BODY, align: "left" },
  );
  s.addText(
    [
      { text: `${formatNumber(last, 2)} ${d.currency}  `, options: { bold: true, color: INK, fontSize: 9 } },
      {
        text: `${chg >= 0 ? "▲" : "▼"} ${formatPercent(Math.abs(chg), { alreadyPercent: false })}`,
        options: { color: chg >= 0 ? "1F8A4C" : "C0392B", fontSize: 8 },
      },
    ],
    { x: x + pl + plotW * 0.4, y: y + 0.04, w: plotW * 0.6, h: 0.2, fontFace: F_BODY, align: "right" },
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
