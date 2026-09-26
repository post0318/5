import { timingSafeEqual } from "node:crypto";
import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { AUDIT_VERDICTS, verifyResultsCol, type AuditRow, type VerifyResultDoc } from "@/lib/db/verify-results";
import { isMarketId } from "@/lib/markets/types";
import { listUniverseDistinct } from "@/lib/universe/repo";

export const maxDuration = 60;

/**
 * 재무 검증 결과 수신·미검증 목록 — 검증 스크립트(GitHub Actions) 전용. 다른 수집 라우트와 같이
 * CRON_SECRET(로컬 수동 실행은 x-app-token: APP_PASSWORD)으로 검증한다.
 *
 *  POST { results: VerifyResultDoc[] }  → 종목별 최신 결과로 교체(CRON_SECRET 만, 스키마대로 재구성)
 *  GET  ?missing=1&market=us            → 유니버스(전 계정 합집합) 중 검증 결과가 없는 종목
 */
const eq = (a: string | null, b: string) => {
  if (a == null) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/** 쓰기는 CRON_SECRET 만(관리자 화면이 믿는 결과라 공유 토큰으로 덮어쓰지 못하게), 읽기는 로컬 수동 실행용 APP_PASSWORD 도 */
function authorized(req: Request, write: boolean): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (secret && eq(req.headers.get("authorization"), `Bearer ${secret}`)) return true;
  return !write && !!appPw && eq(req.headers.get("x-app-token"), appPw);
}

const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/;
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = <T>(v: unknown, f: (x: Record<string, unknown>) => T, max = 2000): T[] =>
  Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === "object").map((x) => f(x as Record<string, unknown>)) : [];
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** 감사표 한 줄 — 판정 값이 목록 밖이면 버린다 */
const auditRow = (x: Record<string, unknown>): AuditRow | null => {
  const verdict = AUDIT_VERDICTS.find((v) => v === x.verdict);
  if (!verdict) return null;
  return {
    metric: str(x.metric, 40),
    period: str(x.period, 20),
    basis: str(x.basis, 80),
    app: numOrNull(x.app),
    sec: numOrNull(x.sec),
    yahoo: numOrNull(x.yahoo),
    sa: numOrNull(x.sa),
    infomax: numOrNull(x.infomax),
    verdict,
    note: str(x.note, 300),
    closed: x.closed === true,
  };
};
const issue = (x: Record<string, unknown>) => ({ layer: str(x.layer, 4), name: str(x.name, 200), col: str(x.col, 20), note: str(x.note, 1000) || undefined });

/** 받은 결과를 스키마대로 다시 만든다 — _id·알 수 없는 필드는 버린다 */
function sanitize(r: Record<string, unknown>): Omit<VerifyResultDoc, "_id"> | null {
  const market = r.market, symbol = str(r.symbol, 12).toUpperCase();
  if (typeof market !== "string" || !isMarketId(market) || !SYMBOL_RE.test(symbol)) return null;
  const c = (r.counts ?? {}) as Record<string, unknown>;
  return {
    market,
    symbol,
    runAt: str(r.runAt, 40),
    base: str(r.base, 200),
    commit: str(r.commit, 64) || null,
    counts: { fail: num(c.fail), unverifiable: num(c.unverifiable), pass: num(c.pass), extAllMatch: num(c.extAllMatch), extMismatch: num(c.extMismatch), otherReview: num(c.otherReview) },
    fails: arr(r.fails, issue),
    unverifiable: arr(r.unverifiable, issue),
    external: arr(r.external, (x) => ({
      item: str(x.item, 200),
      ours: typeof x.ours === "number" && Number.isFinite(x.ours) ? x.ours : null,
      sources: x.sources && typeof x.sources === "object"
        ? Object.fromEntries(Object.entries(x.sources as Record<string, unknown>).slice(0, 10).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).map(([k, v]) => [k.slice(0, 40), v as number]))
        : undefined,
      matched: Array.isArray(x.matched) ? x.matched.slice(0, 10).map((m) => str(m, 40)) : undefined,
      verdict: str(x.verdict, 2000) || undefined,
      note: str(x.note, 1000) || undefined,
    })),
    errors: Array.isArray(r.errors) ? r.errors.slice(0, 100).map((e) => str(e, 500)) : [],
    ...(Array.isArray(r.audit) ? { audit: arr(r.audit, auditRow, 100).filter((x): x is AuditRow => x != null) } : {}),
  };
}

export async function POST(req: Request) {
  try {
    if (!authorized(req, true)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const body = (await req.json()) as { results?: unknown };
    if (!Array.isArray(body.results) || body.results.length > 1000) return Response.json({ error: "results 배열(1,000건 이하) 필요" }, { status: 400 });
    const col = await verifyResultsCol();
    let saved = 0, rejected = 0;
    for (const raw of body.results) {
      const r = raw && typeof raw === "object" ? sanitize(raw as Record<string, unknown>) : null;
      if (!r) { rejected++; continue; }
      const _id = `${r.market}:${r.symbol}`;
      await col.replaceOne({ _id }, r, { upsert: true }); // 필터의 _id 가 새 문서 _id 가 된다
      saved++;
    }
    return ok({ saved, rejected });
  } catch (err) {
    return jsonError(err);
  }
}

export async function GET(req: Request) {
  try {
    if (!authorized(req, false)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const m = new URL(req.url).searchParams.get("market");
    const market = m && isMarketId(m) ? m : undefined;
    const universe = await listUniverseDistinct({ market, activeOnly: true });
    const col = await verifyResultsCol();
    const done = new Set((await col.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
    const missing = universe.filter((u) => !done.has(`${u.market}:${u.symbol}`)).map((u) => ({ market: u.market, symbol: u.symbol }));
    return ok({ count: missing.length, items: missing }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}
