/**
 * 블룸버그 FA 스냅샷(PDF) → 검증기 기준 데이터(.cache/bbg/{종목}.json) — 오너가 종목별로 내려받아 주는 zip(0_{ticker}_YYMMDD.zip)을
 * 판독해 저장한다(오너 결정 2026-09-28 — 블룸버그를 검증기 정식 외부 소스로). 블룸버그 원자료는 라이선스 데이터라 저장소에 올리지 않는다
 * (.cache/ 는 gitignore). 화면 4종: BBG GAAP · BBG 조정 · 조정(recon) · 운용리스 제외(+ 있으면 공시기준·표준화).
 *
 *   node scripts/reference/bbg-import.mjs C:/Users/.../Downloads/0_glw_260928.zip [더 많은 zip 또는 PDF 폴더 …]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { grid } from "./bbg-grid.mjs";

export const BBG_DIR = process.env.BBG_DIR ?? path.join(process.cwd(), ".cache", "bbg");

async function importOne(src) {
  const name = path.basename(src).replace(/\.zip$/i, "");
  const t = (/^0_([a-z0-9.]+)_/i.exec(name)?.[1] ?? name).toUpperCase();
  let dir = src;
  if (/\.zip$/i.test(src)) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbg-"));
    // Windows 는 PowerShell Expand-Archive(Git Bash 의 GNU tar 는 "C:" 를 원격 호스트로 오인한다), 그 밖은 unzip
    if (process.platform === "win32") execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${src.replace(/'/g, "''")}' -DestinationPath '${dir}' -Force`]);
    else execFileSync("unzip", ["-o", "-q", src, "-d", dir]);
  }
  const pdfs = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.pdf$/i.test(f));
  const out = [];
  for (const f of pdfs) {
    const g = await grid(path.join(dir, f));
    const kind = ((g.header.match(/구분: (\S+ \S+(?: \S+)?)/) ?? [])[1] ?? "?").replace(/ (원본|정정).*/, "");
    out.push({ file: path.basename(f), kind, template: g.template, cols: g.cols, rows: g.rows });
  }
  fs.mkdirSync(BBG_DIR, { recursive: true });
  fs.writeFileSync(path.join(BBG_DIR, `${t}.json`), JSON.stringify(out));
  return `${t}: ${out.map((x) => x.kind).join(" | ")}`;
}

if (process.argv[1]?.endsWith("bbg-import.mjs")) {
  const args = process.argv.slice(2);
  if (!args.length) { console.error("사용법: node scripts/reference/bbg-import.mjs <zip 또는 PDF 폴더> …"); process.exit(1); }
  for (const a of args) console.log(await importOne(a));
}
