/**
 * 적재 스크립트(populate-kr-da.mjs)용 DART 요청 계층 — 디스크 캐시 + 정기공시 목록 한 번 받기(2026-10-05 오너 원칙 "DART·EDGAR 는 디스크 캐시와
 * 스냅샷으로 검증·출력한다 — 로직이 바뀌었다고 원문을 다시 받지 않는다").
 *
 * 앱 src/lib/markets/kr/dart-cache.ts 와 **같은 배치·판본 규칙**(1호기에서 같은 폴더 /opt/macro/dart-cache 를 앱과 같이 쓴다 — 적재 스크립트는 앱 쪽이라
 * 공유해도 된다. 검증기 캐시 scripts/verify-kr/cache.mjs 만 독립 구현):
 *  - <DART_CACHE_DIR>/<종류>/<요청 열쇠>/<판본>.(json|bin), 요청 하나에 판본 파일 하나, 새 판본을 쓰면 옛 판본 즉시 삭제, 읽을 때 파일 시각 갱신,
 *    프로세스당 1회 정리(90일 미사용 삭제, DART_CACHE_MAX_GB 기본 2 초과분 오래 안 쓴 것부터)
 *  - fnlttSinglAcntAll(종류 fnltt, 열쇠 corp_사업연도_보고서코드_연결별도): 판본 = 그 보고서 최신 접수번호(정기공시 목록), 목록에 없으면 "none".
 *    12월 결산이 아닌 회사는 디스크 캐시 안 씀. 상태 000·013 만 저장
 *  - 접수번호로 받는 원본(fnlttXbrl → 종류 xbrl, document.xml → 종류 doc): 판본 = 접수번호(바뀌지 않음). zip(PK) 만 저장(014 "파일 없음"은 저장 안 함)
 *  - 정기공시 목록(list.json)은 캐시하지 않는다 — 회사마다 실행당 1회(정기공시 전체, 최근 9년, 쪽 단위)만 받고 스크립트의 여러 목록 조회(사업연도별·
 *    반기/분기별·증분 판정)는 그 결과를 걸러 돌려준다. 그래서 디스크에 원문이 다 있으면 종목당 DART 요청 = 목록 1건
 * DART_CACHE_DIR 가 없으면 디스크 캐시 없이 받는다(목록 한 번 받기는 그대로).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const IDLE_MS = 90 * 864e5;
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const RE_PERIODIC = /(사업|반기|분기)보고서\s*\((\d{4})\.(\d{2})\)/;
const DETAIL = { A001: /사업보고서/, A002: /반기보고서/, A003: /분기보고서/ };

/**
 * @param {{ key: string, root: string|null, maxGb?: number, take: () => void, check: (head: string) => void }} o
 *   take/check = 하루 요청 상한(dart-quota.mjs) — 실제로 네트워크에 나갈 때만 부른다
 */
export function makeDartDisk({ key, root, maxGb = 2, take, check }) {
  const stats = { hit: 0, miss: 0, write: 0, deleted: 0, requests: 0, listPages: 0 };
  const B = "https://opendart.fss.or.kr/api";
  let cleaned = null;

  async function net(url) {
    take();
    stats.requests++;
    const r = await fetch(url);
    const buf = new Uint8Array(await r.arrayBuffer());
    check(new TextDecoder("utf-8").decode(buf.slice(0, 400)));
    return { ok: r.ok, status: r.status, buf };
  }
  async function cleanup() {
    const files = [];
    const walk = async (d) => {
      let names;
      try { names = await readdir(d); } catch (e) { if (e?.code === "ENOENT") return; throw e; }
      for (const n of names) {
        const p = path.join(d, n);
        const s = await stat(p);
        if (s.isDirectory()) await walk(p);
        else files.push({ p, size: s.size, t: s.mtimeMs });
      }
    };
    await walk(root);
    const now = Date.now();
    let total = 0;
    const keep = [];
    for (const f of files) {
      if (now - f.t > IDLE_MS) { await rm(f.p, { force: true }); stats.deleted++; } else { keep.push(f); total += f.size; }
    }
    keep.sort((a, b) => a.t - b.t);
    for (const f of keep) {
      if (total <= maxGb * 1024 ** 3) break;
      await rm(f.p, { force: true });
      total -= f.size;
      stats.deleted++;
    }
  }
  // 정리 실패는 받은 자료와 무관 — 기록만
  const ensureCleaned = () => (cleaned ??= cleanup().catch((e) => console.log(`    [dart-cache] 정리 실패: ${e.message}`)));
  async function readVer(dir, file) {
    const f = path.join(dir, file);
    try {
      const b = await readFile(f);
      const now = new Date();
      await utimes(f, now, now);
      return b;
    } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
  }
  async function writeVer(dir, file, data) {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, file), data);
      stats.write++;
      for (const n of await readdir(dir)) if (n !== file) { await rm(path.join(dir, n), { force: true }); stats.deleted++; }
    } catch (e) { console.log(`    [dart-cache] 쓰기 실패 ${dir}: ${e.message}`); } // 디스크 쓰기 실패는 받은 자료에 영향 없음(다음에 다시 받는다)
  }

  // ── 정기공시 목록 — 회사마다 실행당 1회 ──
  const lists = new Map();
  function periodic(corp) {
    if (!lists.has(corp)) lists.set(corp, (async () => {
      const cy = new Date().getFullYear();
      const end = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
      const rows = [];
      for (let page = 1; page <= 10; page++) {
        const r = await net(`${B}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${cy - 8}0101&end_de=${end}&pblntf_ty=A&page_count=100&page_no=${page}`);
        stats.listPages++;
        const j = JSON.parse(new TextDecoder("utf-8").decode(r.buf));
        if (j.status === "013") break;
        if (j.status !== "000") throw new Error(`DART 정기공시 목록 조회 실패 — 상태 ${j.status} ${j.message ?? ""} (${corp})`);
        rows.push(...(j.list ?? []));
        if (page >= Number(j.total_page ?? 1)) break;
      }
      const parsed = rows.map((r) => ({ r, m: RE_PERIODIC.exec(r.report_nm ?? "") })).filter((x) => x.m);
      const months = parsed.filter((x) => x.m[1] === "사업").map((x) => Number(x.m[3]));
      const freq = (v) => months.filter((x) => x === v).length;
      const fyMonth = months.length ? [...months].sort((a, b) => freq(b) - freq(a))[0] : 12;
      const latest = new Map();
      for (const { r, m } of parsed) {
        const code = m[1] === "사업" ? "11011" : { 3: "11013", 6: "11012", 9: "11014" }[Number(m[3])];
        if (!code) continue;
        const k = `${m[2]}|${code}`;
        if (!latest.has(k) || latest.get(k) < r.rcept_no) latest.set(k, r.rcept_no);
      }
      return { rows, fyMonth, latest };
    })());
    const p = lists.get(corp);
    p.catch(() => lists.delete(corp)); // 실패한 목록은 남기지 않는다(호출자에게는 그대로 던짐)
    return p;
  }
  /** list.json 조회를 정기공시 목록에서 걸러 같은 모양으로 — bgn_de·end_de(접수일)·pblntf_detail_ty(A001 사업·A002 반기·A003 분기) */
  async function listFiltered(u) {
    const corp = u.searchParams.get("corp_code");
    const { rows } = await periodic(corp);
    const bgn = u.searchParams.get("bgn_de") ?? "00000000", end = u.searchParams.get("end_de") ?? "99999999";
    const det = DETAIL[u.searchParams.get("pblntf_detail_ty") ?? ""] ?? null;
    const list = rows.filter((r) => r.rcept_dt >= bgn && r.rcept_dt <= end && (!det || det.test(r.report_nm ?? "")));
    return list.length ? { status: "000", list, total_page: 1 } : { status: "013", message: "조회된 데이타가 없습니다." };
  }

  /** dfetch 대체 — 응답을 Response 로(호출부 코드는 그대로) */
  async function get(url) {
    const u = new URL(url);
    const ep = u.pathname.split("/").pop();
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (ep === "list.json") return json(await listFiltered(u));
    if (root) await ensureCleaned();
    if (root && (ep === "fnlttXbrl.xml" || ep === "document.xml")) {
      const rcept = u.searchParams.get("rcept_no");
      const ns = ep === "document.xml" ? "doc" : "xbrl";
      const dir = path.join(root, ns, safe(createHash("sha1").update(rcept).digest("hex").slice(0, 2) + "_" + rcept));
      const hit = await readVer(dir, `${safe(rcept)}.bin`);
      if (hit) { stats.hit++; return new Response(hit, { status: 200 }); }
      stats.miss++;
      const r = await net(url);
      if (r.ok && r.buf.length >= 100 && r.buf[0] === 0x50 && r.buf[1] === 0x4b) await writeVer(dir, `${safe(rcept)}.bin`, Buffer.from(r.buf));
      return new Response(r.buf, { status: r.status });
    }
    if (root && ep === "fnlttSinglAcntAll.json") {
      const corp = u.searchParams.get("corp_code"), year = u.searchParams.get("bsns_year"), reprt = u.searchParams.get("reprt_code"), fs = u.searchParams.get("fs_div");
      const L = await periodic(corp);
      if (L.fyMonth === 12) {
        const ver = L.latest.get(`${year}|${reprt}`) ?? "none";
        const dir = path.join(root, "fnltt", safe(`${corp}_${year}_${reprt}_${fs}`));
        const hit = await readVer(dir, `${safe(ver)}.json`);
        if (hit) { stats.hit++; return new Response(hit, { status: 200, headers: { "content-type": "application/json" } }); }
        stats.miss++;
        const r = await net(url);
        let j = null;
        try { j = JSON.parse(new TextDecoder("utf-8").decode(r.buf)); } catch { j = null; } // silent-ok: 깨진 JSON 은 저장하지 않고 그대로 돌려준다(호출부가 실패로 처리)
        if (r.ok && j && (j.status === "000" || j.status === "013")) await writeVer(dir, `${safe(ver)}.json`, JSON.stringify(j));
        return new Response(r.buf, { status: r.status, headers: { "content-type": "application/json" } });
      }
    }
    const r = await net(url);
    return new Response(r.buf, { status: r.status });
  }

  return { get, periodic, stats };
}
