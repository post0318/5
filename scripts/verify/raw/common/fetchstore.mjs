/**
 * 보관소 + 요청을 묶은 받기(설계 10 §3.5 1~3·8·10~12).
 *  - immutable: 판본이 고정된 원본(SEC accn·DART 접수번호·EDINET docID·KRX 지난 날짜). 보관소에 있으면 다시 묻지 않는다.
 *  - mutable: 갱신형 응답(companyfacts·submissions·목록). 판본 = 내용 sha256. ttl 안이면 보관본, 넘으면 새로 받고 내용이 같으면
 *    "확인 시각"만 남긴다. 새로 받기가 실패하면 옛 판본으로 대신하지 않는다(D16) — FetchFailed 그대로.
 * 둘 다 저장 전에 형식 검사, 읽을 때 신원 확인(신원이 틀리면 격리 후 한 번 다시 받고, 그래도 틀리면 IdentityFailed — 검증불가).
 */
import { FetchFailed } from "./http.mjs";
import { sha256, StoreError } from "./store.mjs";

export class IdentityFailed extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "IdentityFailed";
    this.code = "parse_failed"; // 판정상 검증불가(판독 실패 계열) — 사고 기록은 보관소 incidents.jsonl
    this.detail = detail;
  }
}

/**
 * @param {object} o
 * @param {ReturnType<import("./store.mjs").openStore>} o.store
 * @param {{get:Function}} o.req makeRequester 결과
 * @param {string} o.market @param {string} o.source @param {string} o.key @param {string} o.version @param {string} o.ext
 * @param {string} o.url @param {object} [o.headers]
 * @param {(buf:Buffer)=>({ok:boolean, why?:string})} o.validate
 * @param {(buf:Buffer)=>({ok:boolean, got?:any})} [o.identity]
 * @param {boolean} [o.irrecoverable]
 * @param {(buf:Buffer)=>void} [o.inspect] 저장 전 원천 상태 검사(예: DART 020 → 전체 중단). 던지면 저장하지 않는다
 */
export async function immutable(o) {
  const q = { market: o.market, source: o.source, key: o.key, version: o.version, ext: o.ext, identity: o.identity };
  const hit = o.store.get(q);
  if (hit) return { buf: hit.buf, sha256: hit.sha256, fromStore: true };
  for (let round = 0; round < 2; round++) {
    const r = await o.req.get(o.url, { headers: o.headers });
    o.inspect?.(r.buf);
    try {
      o.store.put({ ...q, buf: r.buf, validate: o.validate, irrecoverable: o.irrecoverable, meta: { url: redactUrl(o.url) } });
    } catch (e) {
      if (e instanceof StoreError && e.code === "format_rejected") throw new FetchFailed(o.source, e.message, { why: e.detail.why });
      throw e;
    }
    const got = o.store.get(q);
    if (got) return { buf: got.buf, sha256: got.sha256, fromStore: false };
  }
  throw new IdentityFailed(`신원 확인 두 번 실패 — ${o.market}/${o.source} ${o.key}@${o.version}`, { key: o.key });
}

/**
 * @param {object} o immutable 과 같고 version 대신 ttlMs
 * @param {number} o.ttlMs
 * @param {()=>Date} [o.now]
 */
export async function mutable(o) {
  const now = o.now ?? (() => new Date());
  const base = { market: o.market, source: o.source, key: o.key, ext: o.ext };
  const last = o.store.latest(base);
  if (last && now().getTime() - Date.parse(last.checkedAt) <= o.ttlMs) {
    const hit = o.store.get({ ...base, version: last.version, identity: o.identity });
    if (hit) return { buf: hit.buf, sha256: hit.sha256, version: last.version, fromStore: true, checkedAt: last.checkedAt };
  }
  for (let round = 0; round < 2; round++) {
    const r = await o.req.get(o.url, { headers: o.headers });
    o.inspect?.(r.buf);
    const v = o.validate(r.buf);
    if (!v.ok) throw new FetchFailed(o.source, `형식 검사 실패 — ${o.source} ${o.key}: ${v.why}`, { why: v.why });
    const version = `h${sha256(r.buf).slice(0, 24)}`;
    const cur = o.store.latest(base);
    if (cur && cur.version === version && o.store.get({ ...base, version })) {
      o.store.markChecked(base, version);
    } else {
      o.store.put({ ...base, version, buf: r.buf, validate: o.validate, mutable: true, meta: { url: redactUrl(o.url) } });
    }
    const got = o.store.get({ ...base, version, identity: o.identity });
    if (got) return { buf: got.buf, sha256: got.sha256, version, fromStore: false, checkedAt: now().toISOString() };
  }
  throw new IdentityFailed(`신원 확인 두 번 실패 — ${o.market}/${o.source} ${o.key}`, { key: o.key });
}

function redactUrl(u) {
  return String(u).replace(/(crtfc_key|AUTH_KEY|serviceKey|Subscription-Key|apikey)=[^&]+/gi, "$1=***");
}
