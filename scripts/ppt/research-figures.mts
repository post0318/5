/**
 * 핵심 사업 그림 후보 — 증권사 리포트 PDF 에서 그림을 잘라 후보로 만든다(오너 2026-10-31 발표 3 「㉯」).
 *
 * 「리서치 PDF 는 요약 발췌만 저장」 원칙의 오너 예외: **잘라낸 그림만** 저장한다. PDF 원문·본문 글은 디스크 캐시(같은 PDF 를 두 번
 * 받지 않기 위한 것, 서버 안)에만 두고 DB·화면·결과물에 싣지 않는다. 출처 = 증권사·리포트 제목·발행일(왼쪽 출처 줄), 사내 참고 용도.
 *
 * 대상: kr_research(이미 수집 중)의 종목 리포트(category 기업) 중 로그인 없이 PDF 가 바로 열리는 pdfUrl, 종목별 최근 것부터.
 * 읽기만 한다(DB 쓰기 없음). 후보 저장 구조는 아직 파일(index.json + 그림 PNG) — 저장소(DB·TTL)는 화면과 함께 결정.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/ppt/research-figures.mts --symbols=kr:005930,us:NVDA [--per=3] [--out=~/ppt/figures]
 *
 * 외부 요청: PDF 한 개당 1회. 받은 PDF·실패 응답은 ~/ppt/pdf-cache 에 기억해 다시 받지 않는다(실패는 7일 뒤 재시도).
 * 같은 호스트 요청 사이 1.5초.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
const CACHE = home("~/ppt/pdf-cache");
const FAIL_RETRY_MS = 7 * 864e5;
const HOST_GAP_MS = 1500;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Meta = { url: string; ok: boolean; at: string; status?: number; contentType?: string; bytes?: number; error?: string };
const stats = { requests: 0, cacheHits: 0, failCacheHits: 0 };
const lastHit = new Map<string, number>();

async function fetchPdf(url: string): Promise<{ path: string | null; reason: string | null }> {
  mkdirSync(CACHE, { recursive: true });
  const key = createHash("sha1").update(url).digest("hex");
  const pdfPath = resolve(CACHE, `${key}.pdf`);
  const metaPath = resolve(CACHE, `${key}.json`);
  if (existsSync(metaPath)) {
    const m = JSON.parse(readFileSync(metaPath, "utf8")) as Meta;
    if (m.ok && existsSync(pdfPath)) {
      stats.cacheHits++;
      return { path: pdfPath, reason: null };
    }
    if (!m.ok && Date.now() - Date.parse(m.at) < FAIL_RETRY_MS) {
      stats.failCacheHits++;
      return { path: null, reason: `이전 실패 기억(${m.at.slice(0, 10)}): ${m.error}` };
    }
  }
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + HOST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
  stats.requests++;
  const meta: Meta = { url, ok: false, at: new Date().toISOString() };
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
    meta.status = res.status;
    meta.contentType = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    meta.bytes = buf.length;
    if (!res.ok) meta.error = `HTTP ${res.status}`;
    else if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") meta.error = `PDF 아님(${meta.contentType}, 로그인·안내 페이지로 보임)`;
    else {
      writeFileSync(pdfPath, buf);
      meta.ok = true;
    }
  } catch (e) {
    meta.error = e instanceof Error ? e.message : String(e);
  }
  writeFileSync(metaPath, JSON.stringify(meta));
  return meta.ok ? { path: pdfPath, reason: null } : { path: null, reason: meta.error ?? "알 수 없음" };
}

async function main() {
  process.loadEnvFile(home("~/5/.env.local")); // 2호기: 검증용 로컬 DB(읽기만)
  const symbols = (arg("symbols") ?? "").split(",").filter(Boolean).map((s) => {
    const [market, symbol] = s.split(":");
    return { market, symbol };
  });
  if (!symbols.length) throw new Error("--symbols=kr:005930,us:NVDA 필요");
  const per = Number(arg("per") ?? 3);
  const outRoot = home(arg("out") ?? "~/ppt/figures");
  const py = existsSync(home("~/ppt/venv/bin/python")) ? home("~/ppt/venv/bin/python") : "python3";
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const col = client.db().collection("kr_research");
  const summary: unknown[] = [];
  try {
    for (const { market, symbol } of symbols) {
      const q: Record<string, unknown> = { symbol, category: "기업", pdfUrl: { $regex: "^https?://" } };
      if (market !== "kr") q.market = market;
      const docs = await col.find(q).sort({ date: -1 }).limit(per * 4).project({ source: 1, title: 1, date: 1, pdfUrl: 1 }).toArray();
      const outDir = resolve(outRoot, `${market}_${symbol}`);
      mkdirSync(outDir, { recursive: true });
      const reports: unknown[] = [];
      let used = 0;
      for (const d of docs) {
        if (used >= per) break;
        const r = await fetchPdf(d.pdfUrl as string);
        if (!r.path) {
          reports.push({ source: d.source, title: d.title, date: d.date, pdfUrl: d.pdfUrl, skipped: r.reason });
          continue;
        }
        used++;
        const meta = { source: d.source, title: d.title, date: d.date, pdfUrl: d.pdfUrl };
        const metaFile = resolve(outDir, "_report.json");
        writeFileSync(metaFile, JSON.stringify(meta));
        const p = spawnSync(py, [resolve(ROOT, "scripts/ppt/research_figures.py"), "--pdf", r.path, "--meta", metaFile, "--out", outDir], { encoding: "utf8" });
        if (p.status !== 0) {
          console.error(p.stderr);
          reports.push({ ...meta, error: `그림 추출 실패(종료코드 ${p.status})` });
          continue;
        }
        reports.push({ ...meta, figures: JSON.parse(p.stdout) });
      }
      writeFileSync(resolve(outDir, "index.json"), JSON.stringify({ market, symbol, at: new Date().toISOString(), reports }, null, 2));
      summary.push({ market, symbol, reports });
    }
  } finally {
    await client.close();
  }
  console.log(JSON.stringify({ stats, summary }, null, 2));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
