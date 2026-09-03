import "server-only";
import pptxgen from "pptxgenjs";
import { formatNumber, formatPercent } from "@/lib/format";
import type { StockSlideData } from "./slide-data";

/**
 * 종목 소개 PPT (4:3, 종목당 1슬라이드).
 * 구조: 헤더 바 · 개요 불릿 밴드 · 좌(재무표) / 우(주가 라인차트) · 하단 출처·면책.
 */

const RED = "C8102E"; // 헤더
const ORANGE = "F47D37"; // 밴드·소제목
const NAVY = "175097";
const GRAY = "8B8B8B";
const INK = "222222";

const num = (v: number | null, d = 0) => (v == null ? "-" : formatNumber(v, d));
const pctf = (v: number | null) => (v == null ? "-" : formatPercent(v, { alreadyPercent: false }));

function addSlide(pptx: pptxgen, d: StockSlideData) {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };

  // ── 헤더 ─────────────────────────────────
  s.addShape("rect", { x: 0, y: 0, w: 10, h: 0.62, fill: { color: RED } });
  s.addText(
    [
      { text: "투자종목  ", options: { color: "FFD9DE", fontSize: 12 } },
      { text: `${d.name}  (${d.symbol})`, options: { color: "FFFFFF", fontSize: 16, bold: true } },
    ],
    { x: 0.35, y: 0, w: 7.5, h: 0.62, valign: "middle" },
  );
  s.addText(`${d.market.toUpperCase()} · ${d.asOf}`, {
    x: 7.7, y: 0, w: 2.0, h: 0.62, valign: "middle", align: "right",
    color: "FFFFFF", fontSize: 9,
  });

  // ── 개요 불릿 밴드 ───────────────────────
  const bulletH = 1.35;
  s.addShape("rect", { x: 0.35, y: 0.82, w: 9.3, h: bulletH, fill: { color: "FEF1E9" }, line: { color: ORANGE, width: 1 } });
  const bullets = d.bullets.length
    ? d.bullets.slice(0, 4)
    : ["(개요를 입력하면 여기에 표시됩니다)"];
  s.addText(
    bullets.map((t) => ({ text: t, options: { bullet: { characterCode: "2022" }, breakLine: true } })),
    { x: 0.55, y: 0.9, w: 8.9, h: bulletH - 0.16, valign: "top", color: INK, fontSize: 10.5, lineSpacingMultiple: 1.15 },
  );

  const bodyY = 2.42;
  // ── 좌: 재무 요약 ────────────────────────
  s.addShape("rect", { x: 0.35, y: bodyY, w: 4.55, h: 0.32, fill: { color: ORANGE } });
  s.addText(`재무 요약 (${d.unitLabel})`, {
    x: 0.35, y: bodyY, w: 4.55, h: 0.32, valign: "middle", align: "center",
    color: "FFFFFF", fontSize: 10, bold: true,
  });

  const f = d.fin;
  const rows: pptxgen.TableRow[] = [
    ["구분", ...f.years].map((t) => ({
      text: t,
      options: { bold: true, color: "FFFFFF", fill: { color: NAVY }, align: "center" as const, fontSize: 9 },
    })),
    mkRow("매출액", f.revenue.map((v) => num(v)), true),
    mkRow("  성장률(YoY)", f.revenueGrowth.map((v) => pctf(v))),
    mkRow("순이익", f.netIncome.map((v) => num(v)), true),
    mkRow("  순이익률", f.netMargin.map((v) => pctf(v))),
    mkRow("EPS", f.eps.map((v) => num(v, 2))),
    mkRow("PER", f.per.map((v) => (v == null ? "-" : `${formatNumber(v, 2)}x`))),
  ];
  s.addTable(rows, {
    x: 0.35, y: bodyY + 0.4, w: 4.55, colW: [1.55, 1.0, 1.0, 1.0],
    fontSize: 9, color: INK, border: { type: "solid", color: "DDDDDD", pt: 0.5 },
    valign: "middle", rowH: 0.34,
  });

  // ── 우: 주가 차트 ───────────────────────
  s.addShape("rect", { x: 5.1, y: bodyY, w: 4.55, h: 0.32, fill: { color: ORANGE } });
  s.addText(d.priceLabel, {
    x: 5.1, y: bodyY, w: 4.55, h: 0.32, valign: "middle", align: "center",
    color: "FFFFFF", fontSize: 10, bold: true,
  });

  if (d.price.length > 5) {
    const labels = d.price.map((p) => p.date.slice(2, 7));
    s.addChart(
      pptx.ChartType.line,
      [{ name: d.name, labels, values: d.price.map((p) => p.close) }],
      {
        x: 5.1, y: bodyY + 0.42, w: 4.55, h: 3.15,
        chartColors: [NAVY], lineSize: 1.5, lineSmooth: true,
        showLegend: false, showTitle: false,
        catAxisLabelFontSize: 7, valAxisLabelFontSize: 7,
        catAxisLabelFrequency: String(Math.ceil(labels.length / 8)),
      },
    );
  } else {
    s.addText("주가 데이터 없음", {
      x: 5.1, y: bodyY + 1.4, w: 4.55, h: 0.4, align: "center", color: GRAY, fontSize: 10,
    });
  }

  // ── 하단 출처·면책 ──────────────────────
  const srcs = [
    `실적: ${d.sources.financials}`,
    d.sources.consensus ? `추정: ${d.sources.consensus}` : null,
    `주가: ${d.sources.price}`,
  ].filter(Boolean).join("  ·  ");
  s.addText(`※ 출처 — ${srcs}`, { x: 0.35, y: 6.55, w: 9.3, h: 0.25, color: GRAY, fontSize: 7.5 });
  s.addText(
    "본 자료는 이해를 돕기 위한 참고용이며 투자 조언이 아닙니다. 추정치는 시장 컨센서스 기준으로 실제와 다를 수 있습니다.",
    { x: 0.35, y: 6.82, w: 9.3, h: 0.3, color: GRAY, fontSize: 7.5, italic: true },
  );
}

function mkRow(label: string, cells: string[], highlight = false): pptxgen.TableRow {
  return [
    { text: label, options: { bold: highlight, fill: highlight ? { color: "FFF3E9" } : undefined } },
    ...cells.map((c) => ({
      text: c,
      options: { align: "right" as const, fill: highlight ? { color: "FFF3E9" } : undefined },
    })),
  ];
}

export async function buildStockPptx(slides: StockSlideData[]): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "SCREEN4X3", width: 10, height: 7.5 });
  pptx.layout = "SCREEN4X3";
  pptx.author = "글로벌 종목 리서치";
  for (const d of slides) addSlide(pptx, d);
  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}
