/**
 * 공유 원본 보관소(설계 10 §3.5, 오너 승인 2026-10-15).
 *
 * 앱과 검증기가 같은 루트(`RAW_STORE_DIR`, 2호기 `/home/ubuntu/raw-store`)를 쓴다. 공유하는 것은 원본 바이트와 판본 색인뿐이고,
 * 판독 결과(파생)는 각자 따로 둔다.
 *
 * 배치: <루트>/<시장>/<원천>/<요청 열쇠>/<판본>.<확장자> + 같은 폴더 index.jsonl(한 줄 = 한 사건, 추가만).
 *  - 판본은 지우지 않는다(옛 판본 보관). 새 판본이 오면 색인에 superseded 사건만 남긴다.
 *  - 저장 때 형식 검사(validate)를 통과한 바이트만 저장한다. 실패는 저장하지 않고 호출부가 실패로 기억한다.
 *  - 읽을 때 sha256 = 색인 값, 그리고 호출부가 준 신원 확인(identity)을 매번 한다. 틀리면 quarantine/ 로 옮기고 사고 기록.
 *  - 쓰기는 임시 파일 → link(있으면 실패) — 동시에 두 쪽이 같은 열쇠를 받으면 먼저 끝난 쪽이 남고, 나중 쪽은 sha256 이 같으면 버린다.
 *    다르면(불변 원본인데 내용이 다름) 사고로 기록하고 두 파일 모두 quarantine/.
 *  - 정리: 원천마다 상한(기본 5GB)을 넘을 때만 오래 안 쓴 것부터. 복구 불가 판본(irrecoverable)은 정리하지 않고 용량도 따로 센다(D15).
 *    90일 미사용 삭제는 없다. 지운 것은 <루트>/cache-evictions.jsonl 에 남긴다.
 * 조회(네트워크)는 이 모듈이 하지 않는다 — 원천 어댑터가 받아서 put 한다.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const SAFE_RE = /[^A-Za-z0-9._-]/g;
/** 요청 열쇠 → 폴더 이름. 120자 넘으면 앞부분 + sha1 앞 16자리(열쇠 원문은 색인에 남는다) */
export function safeKey(key) {
  const s = String(key).replace(SAFE_RE, "_");
  if (s.length <= 120) return s;
  return `${s.slice(0, 100)}~${createHash("sha1").update(String(key)).digest("hex").slice(0, 16)}`;
}
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export class StoreError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code; // format_rejected | identity_mismatch | sha_mismatch | conflict
    this.detail = detail;
  }
}

const GB = 1024 ** 3;

/**
 * @param {object} o
 * @param {string} o.root 보관소 루트
 * @param {"app"|"verify"} o.actor 받은 쪽 표시(색인 by)
 * @param {Record<string, number>} [o.capBytes] 원천별 상한("us/sec" → 바이트). 없으면 5GB
 * @param {() => Date} [o.now]
 */
export function openStore({ root, actor, capBytes = {}, now = () => new Date() }) {
  if (!root) throw new Error("RAW_STORE_DIR 가 없다 — 공유 원본 보관소 루트를 지정해야 한다");
  if (actor !== "app" && actor !== "verify") throw new Error(`actor 는 app|verify (받음: ${actor})`);
  const stats = { hit: 0, miss: 0, put: 0, dupSame: 0, quarantined: 0, incidents: 0, evicted: 0, evictedBytes: 0 };
  const incidents = [];

  const dirOf = (market, source, key) => join(root, market, source, safeKey(key));
  const fileOf = (market, source, key, version, ext) => join(dirOf(market, source, key), `${safeKey(version)}.${ext}`);

  function readIndex(dir) {
    const f = join(dir, "index.jsonl");
    if (!existsSync(f)) return [];
    const out = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        // 색인 한 줄이 깨졌다 — 쓰다 끊긴 줄. 무시하지 않고 사고로 남긴다(파일은 그대로).
        incident("index_line_broken", { dir, line: line.slice(0, 200), error: String(e) });
      }
    }
    return out;
  }
  function appendIndex(dir, ev) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "index.jsonl"), `${JSON.stringify(ev)}\n`);
  }
  function incident(kind, detail) {
    stats.incidents++;
    const ev = { at: now().toISOString(), by: actor, kind, ...detail };
    incidents.push(ev);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "incidents.jsonl"), `${JSON.stringify(ev)}\n`);
  }
  function quarantine(path, reason, detail = {}) {
    if (!existsSync(path)) return null;
    const day = now().toISOString().slice(0, 10);
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;
    const dest = join(root, "quarantine", day, `${rel.replace(/[\\/]/g, "__")}.${randomBytes(3).toString("hex")}`);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(path, dest);
    writeFileSync(`${dest}.reason.json`, JSON.stringify({ at: now().toISOString(), by: actor, from: rel, reason, ...detail }, null, 1));
    stats.quarantined++;
    return dest;
  }

  /** 색인에서 그 판본의 저장 기록(put) — 없으면 null */
  function putRecord(idx, version) {
    for (let i = idx.length - 1; i >= 0; i--) if (idx[i].ev === "put" && idx[i].v === String(version)) return idx[i];
    return null;
  }

  /**
   * 판본 하나 읽기. 없으면 null. 있는데 sha256·신원이 틀리면 quarantine 후 null + 사고(호출부는 다시 받는다).
   * @param {{market:string, source:string, key:string, version:string, ext:string, identity?:(buf:Buffer)=>({ok:boolean, got?:any})}} q
   */
  function get(q) {
    const f = fileOf(q.market, q.source, q.key, q.version, q.ext);
    if (!existsSync(f)) {
      stats.miss++;
      return null;
    }
    const buf = readFileSync(f);
    const dir = dirOf(q.market, q.source, q.key);
    const rec = putRecord(readIndex(dir), q.version);
    const h = sha256(buf);
    if (!rec) {
      incident("no_index_record", { file: f });
      quarantine(f, "no_index_record");
      stats.miss++;
      return null;
    }
    if (rec.sha256 !== h) {
      incident("sha_mismatch", { file: f, want: rec.sha256, got: h });
      quarantine(f, "sha_mismatch", { want: rec.sha256, got: h });
      stats.miss++;
      return null;
    }
    if (q.identity) {
      const id = q.identity(buf);
      if (!id.ok) {
        incident("identity_mismatch", { file: f, key: q.key, version: q.version, got: id.got, storedBy: rec.by });
        quarantine(f, "identity_mismatch", { got: id.got, storedBy: rec.by });
        stats.miss++;
        return null;
      }
    }
    const t = now();
    utimesSync(f, t, t);
    stats.hit++;
    return { buf, sha256: h, record: rec, path: f };
  }

  /**
   * 판본 하나 저장. validate 가 실패하면 저장하지 않고 StoreError(format_rejected).
   * 같은 판본이 이미 있으면: 내용이 같으면 그대로(dupSame), 다르면 사고 + 두 파일 quarantine + StoreError(conflict).
   * @param {{market:string, source:string, key:string, version:string, ext:string, buf:Buffer, validate:(buf:Buffer)=>({ok:boolean, why?:string}),
   *          meta?:object, irrecoverable?:boolean, mutable?:boolean}} q
   */
  function put(q) {
    const v = q.validate(q.buf);
    if (!v.ok) throw new StoreError("format_rejected", `형식 검사 실패 — ${q.market}/${q.source} ${q.key}@${q.version}: ${v.why}`, { why: v.why });
    const dir = dirOf(q.market, q.source, q.key);
    mkdirSync(dir, { recursive: true });
    const f = fileOf(q.market, q.source, q.key, q.version, q.ext);
    const h = sha256(q.buf);
    const tmp = `${f}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, q.buf);
    try {
      linkSync(tmp, f);
    } catch (e) {
      if (e.code !== "EEXIST") {
        unlinkSync(tmp);
        throw e;
      }
      const haveBuf = readFileSync(f);
      const have = sha256(haveBuf);
      if (have === h || q.equivalent?.(haveBuf, q.buf)) {
        if (have !== h) incident("equivalent_bytes", { key: q.key, version: q.version, existing: have, incoming: h, note: "내용 같음(원천이 덧붙인 부분만 다름) — 먼저 저장한 것 유지" });
        unlinkSync(tmp);
        stats.dupSame++;
        if (!putRecord(readIndex(dir), q.version)) appendIndex(dir, record(q, h)); // 앞선 쪽이 색인을 쓰기 전에 끊긴 경우
        return { path: f, sha256: h, dup: true };
      }
      const qa = quarantine(f, "conflict_existing", { other: h });
      const qb = quarantine(tmp, "conflict_incoming", { other: have });
      incident("conflict", { key: q.key, version: q.version, existing: have, incoming: h, quarantined: [qa, qb] });
      throw new StoreError("conflict", `같은 판본에 다른 내용 — ${q.market}/${q.source} ${q.key}@${q.version}`, { existing: have, incoming: h });
    }
    unlinkSync(tmp);
    const idx = readIndex(dir);
    const prev = [...idx].reverse().find((r) => r.ev === "put" && r.v !== String(q.version));
    appendIndex(dir, record(q, h));
    if (prev) appendIndex(dir, { ev: "superseded", v: prev.v, by_v: String(q.version), at: now().toISOString(), by: actor });
    stats.put++;
    return { path: f, sha256: h, dup: false };
  }
  function record(q, h) {
    return {
      ev: "put", v: String(q.version), key: String(q.key), ext: q.ext, sha256: h, size: q.buf.length, at: now().toISOString(), by: actor,
      ...(q.irrecoverable ? { irrecoverable: true } : {}), ...(q.mutable ? { mutable: true } : {}), ...(q.meta ?? {}),
    };
  }

  /** 갱신형 응답의 확인 사건(내용이 같아 새 파일을 만들지 않음) */
  function markChecked(q, version) {
    appendIndex(dirOf(q.market, q.source, q.key), { ev: "checked", v: String(version), at: now().toISOString(), by: actor });
  }

  /** 그 요청의 가장 최근 판본 기록(put·checked 중 마지막 시각) — 갱신형 응답의 신선도 판단용 */
  function latest(q) {
    const idx = readIndex(dirOf(q.market, q.source, q.key));
    let last = null;
    for (const r of idx) if (r.ev === "put" || r.ev === "checked") last = r;
    if (!last) return null;
    const rec = putRecord(idx, last.v);
    return rec ? { version: last.v, checkedAt: last.at, record: rec } : null;
  }

  /** 판본 목록(저장 순서) */
  function versions(q) {
    return readIndex(dirOf(q.market, q.source, q.key)).filter((r) => r.ev === "put");
  }

  function walkFiles(d, out) {
    if (!existsSync(d)) return out;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walkFiles(p, out);
      else if (n !== "index.jsonl") out.push({ p, size: s.size, t: s.mtimeMs, dir: d, name: n });
    }
    return out;
  }

  /**
   * 원천 하나 정리(실행 시작 때 1회). 상한을 넘을 때만, 다시 받을 수 있는 판본만, 오래 안 쓴 순서로.
   * @returns {{source:string, bytes:number, irrecoverableBytes:number, evicted:number, evictedBytes:number}}
   */
  function evict(market, source) {
    const cap = capBytes[`${market}/${source}`] ?? 5 * GB;
    const files = walkFiles(join(root, market, source), []);
    const irrecoverable = new Set();
    const dirs = new Set(files.map((f) => f.dir));
    for (const d of dirs) for (const r of readIndex(d)) if (r.ev === "put" && r.irrecoverable) irrecoverable.add(join(d, `${safeKey(r.v)}.${r.ext}`));
    let bytes = 0, irr = 0;
    const cand = [];
    for (const f of files) {
      if (irrecoverable.has(f.p)) irr += f.size;
      else { bytes += f.size; cand.push(f); }
    }
    let n = 0, nb = 0;
    if (bytes > cap) {
      cand.sort((a, b) => a.t - b.t);
      for (const f of cand) {
        if (bytes <= cap) break;
        unlinkSync(f.p);
        appendIndex(f.dir, { ev: "evicted", file: f.name, size: f.size, at: now().toISOString(), by: actor });
        appendFileSync(join(root, "cache-evictions.jsonl"), `${JSON.stringify({ at: now().toISOString(), by: actor, market, source, file: f.p.slice(root.length + 1), size: f.size, lastUsed: new Date(f.t).toISOString() })}\n`);
        bytes -= f.size;
        n++;
        nb += f.size;
      }
    }
    stats.evicted += n;
    stats.evictedBytes += nb;
    return { source: `${market}/${source}`, bytes, irrecoverableBytes: irr, cap, evicted: n, evictedBytes: nb };
  }

  /**
   * 기존 보관 파일 들여오기(설계 10 §3.5 옮기는 순서 1·2). 같은 디스크라 하드링크 — 원래 파일은 그대로 두어 앱이 계속 쓴다
   * (옛 폴더는 앱·검증기가 새 루트로 한 번씩 정상 실행한 뒤 지운다 — 순서 4). 형식 검사·신원 확인을 통과한 것만.
   * @returns {{status:"imported"|"dup"|"rejected"|"conflict", why?:string, path?:string}}
   */
  function importFile(q, src) {
    const buf = readFileSync(src);
    const v = q.validate(buf);
    if (!v.ok) return { status: "rejected", why: `형식: ${v.why}` };
    if (q.identity) {
      const id = q.identity(buf);
      if (!id.ok) return { status: "rejected", why: `신원: ${JSON.stringify(id.got)?.slice(0, 120)}` };
    }
    const dir = dirOf(q.market, q.source, q.key);
    mkdirSync(dir, { recursive: true });
    const f = fileOf(q.market, q.source, q.key, q.version, q.ext);
    const h = sha256(buf);
    try {
      linkSync(src, f);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const haveBuf = readFileSync(f);
      const have = sha256(haveBuf);
      if (have === h || q.equivalent?.(haveBuf, buf)) {
        if (have !== h) incident("equivalent_bytes", { key: q.key, version: q.version, existing: have, incoming: h, src, note: "내용 같음(원천이 덧붙인 부분만 다름) — 먼저 저장한 것 유지" });
        if (!putRecord(readIndex(dir), q.version)) appendIndex(dir, record({ ...q, buf }, h));
        stats.dupSame++;
        return { status: "dup", path: f };
      }
      const qa = quarantine(f, "import_conflict_existing", { other: h, src });
      incident("import_conflict", { key: q.key, version: q.version, existing: have, incoming: h, src, quarantined: qa });
      return { status: "conflict", why: `같은 판본 다른 내용(${src})` };
    }
    const idx = readIndex(dir);
    const prev = [...idx].reverse().find((r) => r.ev === "put" && r.v !== String(q.version));
    appendIndex(dir, record({ ...q, buf, meta: { ...(q.meta ?? {}), importedFrom: src } }, h));
    if (prev && q.supersedes !== false) appendIndex(dir, { ev: "superseded", v: prev.v, by_v: String(q.version), at: now().toISOString(), by: actor });
    stats.put++;
    return { status: "imported", path: f };
  }

  return { root, actor, get, put, latest, versions, markChecked, evict, quarantine, incident, importFile, stats, incidents, dirOf, fileOf };
}
