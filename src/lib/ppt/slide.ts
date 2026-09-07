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
    s.addImage({ data: d.logo, x: 8.02, y: 0.3, w: 1.6, h: 0.62, sizing: { type: "contain", w: 1.6, h: 0.62 } });
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

  // 좌: 주요 사업 (텍스트)
  sectionTitle(s, leftX, secY, leftW, "주요 사업");
  bulletBox(s, leftX, bodyY, leftW, 2.56, d.business, "(주요 사업 내용을 입력하세요)");

  // 우: 핵심 시장점유율 — 빈 영역(라벨만)
  sectionTitle(s, rightX, secY, rightW, "핵심 시장점유율 · 경쟁 구도");
  s.addShape("rect", {
    x: rightX, y: bodyY, w: rightW, h: 1.62,
    fill: { color: "FFFFFF" }, line: { color: RULE, width: 1, dashType: "dash" },
  });
  s.addText("직접 작성 영역", {
    x: rightX, y: bodyY + 0.66, w: rightW, h: 0.3, align: "center",
    color: SUB, fontFace: F_BODY, fontSize: 9, italic: true,
  });

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

  const A = downsample(d.price, 70);
  const B = d.bench.length >= 5 ? downsample(d.bench, 70) : [];
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
      align: "right", color: LINE, fontFace: F_BODY, fontSize: 7,
    });
    if (B.length) {
      s.addText(formatNumber(b0 * r, 0), {
        x: x + w - pr + 0.03, y: y + gy - 0.1, w: pr - 0.05, h: 0.2,
        align: "left", color: SUB, fontFace: F_BODY, fontSize: 7,
      });
    }
  }

  // 폴리라인을 직선 세그먼트 도형으로 그림 (custGeom 미사용 → PowerPoint 2007 호환)
  const polyline = (rows: { close: number }[], base: number, color: string, wpt: number) => {
    for (let i = 1; i < rows.length; i++) {
      const x1 = x + cx(i - 1, rows.length);
      const y1 = y + cyR(rows[i - 1].close / base);
      const x2 = x + cx(i, rows.length);
      const y2 = y + cyR(rows[i].close / base);
      s.addShape("line", {
        x: Math.min(x1, x2), y: Math.min(y1, y2),
        w: Math.abs(x2 - x1) || 0.001, h: Math.abs(y2 - y1) || 0.001,
        flipV: y2 < y1,
        line: { color, width: wpt },
      });
    }
  };
  if (B.length) polyline(B, b0, "9AA3AF", 1);
  polyline(A, a0, LINE, 1.75);

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
      { text: "■ ", options: { color: LINE, fontSize: 8 } },
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
