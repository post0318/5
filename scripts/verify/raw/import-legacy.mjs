#!/usr/bin/env node
/**
 * 기존 보관 파일 → 공유 원본 보관소 들여오기(설계 10 §3.5 「지금 폴더와 옮기는 순서」 1·2, 오너 승인 2026-10-15).
 *
 * 들여오는 것(원본만 — 판독 결과·파생 파일은 대상 아님):
 *  - 앱 SEC 공시 원본  ~/sec-cache/sec-archives  (파일 이름 = sha1("URL|accept") — URL 을 index.json 목록과 검증기 파일 이름으로 복원)
 *  - 검증기 SEC 공시 원본 ~/sec-cache/verify-archives (파일 이름 = "{cik}_{accn}_{파일}")
 *  - 앱 DART  ~/dart-cache/{fnltt,alot}/<열쇠>/<판본>.json, {xbrl,doc}/<xx>_<접수번호>/<접수번호>.bin
 *  - 앱 EDINET ~/edinet-cache/doc/S100/<docID>/type1.zip
 * 들여오지 않는 것: SEC 갱신형(companyfacts·submissions — 12시간마다 새로 받음), 검증기 DART·KRX 캐시(걸러낸 결과라 원본 아님),
 *  앱 EDINET 날짜 목록(걸러낸 결과).
 *
 * 방법: 형식 검사 + 신원 확인을 통과한 파일만 하드링크(같은 디스크 — 공간이 더 들지 않고 원래 파일은 그대로라 앱이 계속 쓴다).
 * 실패·복원 못 한 파일은 들여오지 않고 결과에 사유를 남긴다(원래 파일은 건드리지 않는다). 옛 폴더 삭제는 이 스크립트가 하지 않는다(순서 4).
 *
 * 실행: RAW_STORE_DIR=/home/ubuntu/raw-store node scripts/verify/raw/import-legacy.mjs [--dry-run] [--only=sec,dart,edinet]
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkJson, checkNonEmpty, checkXml, checkZip, unzipEntries } from "./common/format.mjs";
import { openStore } from "./common/store.mjs";
import { equivalentFor, identityFor } from "./us/sec.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const ROOT = process.env.RAW_STORE_DIR;
if (!ROOT) throw new Error("RAW_STORE_DIR 를 지정하라(2호기 /home/ubuntu/raw-store)");
const HOME = homedir();
const only = new Set(String(args.only ?? "sec,dart,edinet").split(","));
const dry = !!args["dry-run"];
const store = openStore({ root: ROOT, actor: "verify" });
const out = { at: new Date().toISOString(), root: ROOT, dry, groups: {} };

function tally(group) {
  return (out.groups[group] ??= { seen: 0, imported: 0, dup: 0, rejected: 0, conflict: 0, unidentified: 0, bytes: 0, reasons: {} , samples: [] });
}
function note(g, status, why, path, size = 0) {
  g[status]++;
  if (status === "imported") g.bytes += size;
  if (why) {
    const k = why.replace(/[0-9a-f]{8,}|\d{6,}/g, "#").slice(0, 80);
    g.reasons[k] = (g.reasons[k] ?? 0) + 1;
    if (g.samples.length < 30) g.samples.push({ status, why, path });
  }
}
function doImport(g, q, src) {
  g.seen++;
  const size = statSync(src).size;
  if (dry) {
    const buf = readFileSync(src);
    const v = q.validate(buf);
    if (!v.ok) return note(g, "rejected", `형식: ${v.why}`, src);
    const id = q.identity ? q.identity(buf) : { ok: true };
    if (!id.ok) return note(g, "rejected", `신원: ${JSON.stringify(id.got)?.slice(0, 120)}`, src);
    return note(g, "imported", null, src, size);
  }
  const r = store.importFile(q, src);
  note(g, r.status, r.why, src, size);
}

// ── SEC ────────────────────────────────────────────────────────────
const ARCH = "https://www.sec.gov/Archives/edgar/data/";
const extOf = (file) => (file.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "bin").toLowerCase();
function secValidator(ext) {
  if (ext === "json") return (b) => checkJson(b);
  if (ext === "xml" || ext === "xsd") return checkXml;
  if (ext === "zip") return checkZip;
  return checkNonEmpty;
}
function secQ(cik, a18, file) {
  const ext = extOf(file);
  return { market: "us", source: "sec", key: `${Number(cik)}/${a18}/${file}`, version: a18, ext, validate: secValidator(ext), identity: identityFor({ cik, a18, file, ext }), equivalent: equivalentFor(ext), meta: { url: `${ARCH}${Number(cik)}/${a18}/${file}` } };
}
function importSec() {
  const g = tally("sec");
  const appDir = join(HOME, "sec-cache", "sec-archives");
  const verDir = join(HOME, "sec-cache", "verify-archives");
  // 1) 검증기 파일 — 이름에서 바로 복원
  const known = new Map(); // sha1 key → {cik,a18,file}
  if (existsSync(verDir)) {
    for (const n of readdirSync(verDir)) {
      const m = n.match(/^(\d+)_(\d{18})_(.+)$/);
      if (!m) { g.seen++; note(g, "unidentified", "검증기 파일 이름 형식 아님", join(verDir, n)); continue; }
      const [, cik, a18, file] = m;
      for (const acc of ["", "application/json"]) known.set(sha1(`${ARCH}${Number(cik)}/${a18}/${file}|${acc}`), { cik, a18, file });
      doImport(g, secQ(cik, a18, file), join(verDir, n));
    }
  }
  // 2) 앱 파일 — index.json 목록에서 URL 후보를 만들어 sha1 로 맞춘다
  if (existsSync(appDir)) {
    const names = readdirSync(appDir);
    for (const n of names) {
      const p = join(appDir, n);
      let j = null;
      const fd = openSync(p, "r");
      const hb = Buffer.alloc(40);
      readSync(fd, hb, 0, 40, 0);
      closeSync(fd);
      const head = hb.toString("utf8");
      if (!head.startsWith('{"directory"')) continue;
      try { j = JSON.parse(readFileSync(p, "utf8")); } catch (e) { g.seen++; note(g, "rejected", `index.json 파싱 실패 ${String(e.message).slice(0, 40)}`, p); continue; }
      const dm = String(j?.directory?.name ?? "").match(/\/Archives\/edgar\/data\/(\d+)\/(\d{18})$/);
      if (!dm) continue;
      const [, cik, a18] = dm;
      const dirUrl = `${ARCH}${cik}/${a18}`;
      for (const acc of ["application/json", ""]) known.set(sha1(`${dirUrl}/index.json|${acc}`), { cik, a18, file: "index.json" });
      for (const it of j.directory.item ?? []) for (const acc of ["", "application/json"]) known.set(sha1(`${dirUrl}/${it.name}|${acc}`), { cik, a18, file: it.name });
    }
    for (const n of names) {
      const p = join(appDir, n);
      const k = known.get(n);
      if (!k) { g.seen++; note(g, "unidentified", "URL 복원 못 함(목록에 없는 파일)", p); continue; }
      doImport(g, secQ(k.cik, k.a18, k.file), p);
    }
  }
}
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

// ── DART ───────────────────────────────────────────────────────────
function importDart() {
  const g = tally("dart");
  const base = join(HOME, "dart-cache");
  const jsonOk = (b) => checkJson(b, (j) => (j.status === "000" || j.status === "013" ? null : `status ${j.status}`));
  for (const kind of ["fnltt", "alot"]) {
    const d = join(base, kind);
    if (!existsSync(d)) continue;
    for (const keyDir of readdirSync(d)) {
      const corp = keyDir.split("_")[0];
      const files = readdirSync(join(d, keyDir)).filter((f) => f.endsWith(".json")).sort((a, b) => (a === "none.json" ? -1 : b === "none.json" ? 1 : a.localeCompare(b)));
      for (const f of files) {
        const v = f.replace(/\.json$/, "");
        doImport(g, {
          market: "kr", source: "dart", key: `${kind}_${keyDir}`, version: v, ext: "json", validate: jsonOk, irrecoverable: true,
          identity: (b) => {
            const j = JSON.parse(b);
            if (j.status === "013") return { ok: true };
            const row = j.list?.[0];
            return { ok: row?.corp_code === corp && (v === "none" || row?.rcept_no == null || row.rcept_no <= v), got: { corp: row?.corp_code, rcept: row?.rcept_no } };
          },
        }, join(d, keyDir, f));
      }
    }
  }
  // 측정 작업이 받아 둔 원문(~/5/reports/q12-q14/raw/dart-doc/<접수번호>.zip) — DART document.xml 원본 그대로
  const meas = join(HOME, "5", "reports", "q12-q14", "raw", "dart-doc");
  if (existsSync(meas)) {
    for (const n of readdirSync(meas).filter((x) => /^\d{14}\.zip$/.test(x))) {
      const rc = n.slice(0, 14);
      doImport(g, {
        market: "kr", source: "dart", key: `doc_${rc}`, version: rc, ext: "zip", validate: checkZip,
        identity: (b) => { const names = unzipEntries(b).map((e) => e.name); return { ok: names.length > 0 && names.every((x) => x.startsWith(rc)), got: names.slice(0, 3) }; },
      }, join(meas, n));
    }
  }
  for (const kind of ["xbrl", "doc"]) {
    const d = join(base, kind);
    if (!existsSync(d)) continue;
    for (const sub of readdirSync(d)) {
      const rc = sub.split("_")[1];
      const p = join(d, sub, `${rc}.bin`);
      if (!rc || !existsSync(p)) { g.seen++; note(g, "unidentified", "폴더 형식 아님", join(d, sub)); continue; }
      doImport(g, {
        market: "kr", source: "dart", key: `${kind}_${rc}`, version: rc, ext: "zip", validate: checkZip,
        identity: (b) => {
          const names = unzipEntries(b).map((e) => e.name);
          if (kind === "doc") return { ok: names.length > 0 && names.every((n) => n.startsWith(rc)), got: names.slice(0, 3) };
          const corps = new Set(names.map((n) => n.match(/^(?:entity)?(\d{8})_/)?.[1]).filter(Boolean));
          return { ok: corps.size === 1, got: [...corps] };
        },
      }, p);
    }
  }
}

// ── EDINET ─────────────────────────────────────────────────────────
function importEdinet() {
  const g = tally("edinet");
  const d = join(HOME, "edinet-cache", "doc");
  if (!existsSync(d)) return;
  for (const pre of readdirSync(d)) {
    for (const docID of readdirSync(join(d, pre))) {
      const p = join(d, pre, docID, "type1.zip");
      if (!/^S1[0-9A-Z]{6}$/.test(docID) || !existsSync(p)) { g.seen++; note(g, "unidentified", "폴더 형식 아님", join(d, pre, docID)); continue; }
      doImport(g, {
        market: "jp", source: "edinet", key: `doc_${docID}`, version: docID, ext: "zip", validate: checkZip,
        identity: (b) => { const n = unzipEntries(b).filter((e) => /PublicDoc\//.test(e.name)).length; return { ok: n > 0, got: n }; },
      }, p);
    }
  }
}

if (only.has("sec")) importSec();
if (only.has("dart")) importDart();
if (only.has("edinet")) importEdinet();
out.store = store.stats;
out.incidents = store.incidents.length;
const rep = join(process.cwd(), "reports");
mkdirSync(rep, { recursive: true });
const f = join(rep, `raw-import-${out.at.replace(/[:.]/g, "-")}${dry ? "-dry" : ""}.json`);
writeFileSync(f, JSON.stringify(out, null, 1));
for (const [k, g] of Object.entries(out.groups)) {
  console.log(`${k}: 본 ${g.seen} · 들여옴 ${g.imported}(${(g.bytes / 1e6).toFixed(0)}MB) · 이미 있음 ${g.dup} · 거부 ${g.rejected} · 충돌 ${g.conflict} · 복원 못 함 ${g.unidentified}`);
  for (const [r, n] of Object.entries(g.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${n} × ${r}`);
}
console.log(`결과 ${f}`);
