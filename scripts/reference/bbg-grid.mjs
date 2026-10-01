// 블룸버그 FA PDF → 좌표 기반 표(행 라벨 → 열별 값). 열 = "기간말" 행의 날짜 x 위치(오른쪽 정렬 숫자라 끝 x 로 맞춘다).
import fs from "node:fs";
import path from "node:path";
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
export async function grid(file) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
  const rows = [];
  let cols = null, template = null, kinds = null, header = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => i.str.trim()).map((i) => ({ s: i.str.trim(), x: i.transform[4], xe: i.transform[4] + i.width, y: Math.round(i.transform[5]) }));
    const byY = new Map();
    for (const it of items) { const k = [...byY.keys()].find((y) => Math.abs(y - it.y) <= 2) ?? it.y; (byY.get(k) ?? byY.set(k, []).get(k)).push(it); }
    const lines = [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([, its]) => its.sort((a, b) => a.x - b.x));
    for (const ln of lines) {
      if (p === 1 && !cols) header += " " + ln.map((i) => i.s).join(" ");
      if (ln[0].s === "기간말") { cols = ln.slice(1).map((i) => ({ date: i.s, xe: i.xe })); continue; }
      if (/원본:|정정:|예상:|현재/.test(ln.map((i) => i.s).join(" ")) && !kinds) { template = ln[0].s; kinds = ln.map((i) => i.s); }
      if (!cols) continue;
      const labelParts = ln.filter((i) => !/^-?[\d,]+\.\d+$|^-?[\d,]+$/.test(i.s) || i.x < cols[0].xe - 120);
      const nums = ln.filter((i) => /^-?[\d,]+(\.\d+)?$/.test(i.s) && i.x >= cols[0].xe - 120);
      if (!nums.length) continue;
      const vals = {};
      for (const n of nums) {
        let best = null;
        for (const c of cols) if (!best || Math.abs(c.xe - n.xe) < Math.abs(best.xe - n.xe)) best = c;
        vals[best.date] = Number(n.s.replace(/,/g, ""));
      }
      rows.push({ label: labelParts.map((i) => i.s).join(" ").trim(), vals });
    }
  }
  return { header, template, kinds, cols: cols?.map((c) => c.date) ?? [], rows };
}
if (process.argv[1]?.endsWith("bbg-grid.mjs") && process.argv[2]) {
  const g = await grid(process.argv[2]);
  console.log(g.template, g.cols.join(" "));
  for (const r of g.rows.slice(0, Number(process.argv[3] ?? 20))) console.log(r.label.padEnd(24), JSON.stringify(r.vals));
}
