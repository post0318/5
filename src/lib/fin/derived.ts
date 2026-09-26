import "server-only";
import type { UsReader } from "./read";
import type { AssembledIs, DerivedInput, MetricSeries, StmtLine } from "./types";

/**
 * 파생값 입력 마무리(architecture.md §2.1) — 조립·지표 계산이 끝난 뒤 한 번.
 *  1. 참조 압축: `f:`(SEC 사실) 입력이 저장 칸(단일 공시 열의 입력 없는 칸)과 같은 사실이면 `c:{열키}|{줄id}` 로 바꾼다 —
 *     Q4 = FY 칸 − 9개월 사실처럼, 화면에 있는 칸은 칸으로 가리킨다(같은 accn·개념·기간 ±3일·같은 값일 때만).
 *  2. 자기 검사: 입력을 부호대로 더해(환율 곱) 값이 재현되는지 — `f:` 는 원천에서 되읽고(reader.readRef), `c:` 는 그 칸 값(칸이
 *     파생이면 그 칸 입력으로 재귀 검사), 시장 데이터는 기록된 값. 부동소수 잡음 밖 차이·참조 해석 실패는 오류로 돌려준다
 *     (index.ts 가 issues.der·경고로 노출 — 조용히 통과시키지 않는다).
 *  3. 계산 시각(calculatedAt) 기록.
 */

const DAY = 864e5;
const nearDay = (a: string | null | undefined, b: string | null | undefined) =>
  a != null && b != null && Math.abs(Date.parse(a) - Date.parse(b)) <= 3 * DAY;
/** 부동소수 잡음 한도 — 항 절댓값 합 × (항 수 + 1) × 8ε */
const noise = (abs: number, n: number) => Number.EPSILON * 8 * (n + 1) * Math.max(abs, 1);

/** 지표 이름(자기 검사 메시지용) */
const METRIC_NAME: Record<MetricSeries["metric"], string> = { revenue: "매출", cogs: "매출원가", gp: "매출총이익", opinc: "영업이익", opex: "영업비용" };

export async function finalizeDerived(reader: UsReader, cols: AssembledIs[], series: MetricSeries[], at: string): Promise<Map<string, string[]>> {
  const byKey = new Map(cols.map((a) => [a.col.key, a] as const));
  const refVal = new Map<string, Promise<number | null>>();
  const readRef = (ref: string) => {
    let p = refVal.get(ref);
    if (!p) refVal.set(ref, (p = reader.readRef(ref)));
    return p;
  };

  // 1. 참조 압축 — 입력 없는 저장 칸 색인(단일 공시 열)
  const plain = new Map<string, { a: AssembledIs; l: StmtLine }[]>();
  for (const a of cols) {
    const src = a.col.src;
    if (Array.isArray(src) || !src.accn) continue;
    for (const l of a.lines) {
      if (l.v == null || l.inputs || l.id.startsWith("syn:")) continue;
      const k = `${src.accn}|${l.id}`;
      plain.set(k, [...(plain.get(k) ?? []), { a, l }]);
    }
  }
  const compact = async (ins: DerivedInput[]): Promise<DerivedInput[]> => {
    const out: DerivedInput[] = [];
    for (const i of ins) {
      const m = /^f:([^|]+)\|([^|]+)\|([^|]*)\|([^|]+)$/.exec(i.ref); // 차원 값은 칸이 아니다
      const hit = m ? plain.get(`${m[1]}|${m[2]}`)?.find(({ a }) => nearDay(a.col.start, m[3]) && nearDay(a.col.end, m[4])) : undefined;
      if (hit && (await readRef(i.ref)) === hit.l.v) out.push({ ...i, ref: `c:${hit.a.col.key}|${hit.l.id}` });
      else out.push(i);
    }
    return out;
  };
  const done = new Map<DerivedInput[], DerivedInput[]>();
  const compactOnce = async (ins: DerivedInput[]) => {
    let c = done.get(ins);
    if (!c) done.set(ins, (c = await compact(ins)));
    return c;
  };
  for (const a of cols) for (const l of a.lines) if (l.inputs) l.inputs = await compactOnce(l.inputs);
  for (const ser of series) for (const mv of Object.values(ser.values)) if (mv.inputs) mv.inputs = await compactOnce(mv.inputs);

  // 2. 자기 검사
  const errs = new Map<string, string[]>();
  const err = (col: string, msg: string) => errs.set(col, [...(errs.get(col) ?? []), msg]);
  const evalInputs = async (ins: DerivedInput[], col: string, depth: number): Promise<{ sum: number; abs: number } | null> => {
    let sum = 0, abs = 0;
    for (const i of ins) {
      let val: number | null = null;
      if (i.ref.startsWith("f:")) val = await readRef(i.ref);
      else if (i.ref.startsWith("c:")) {
        const [ck, ...rest] = i.ref.slice(2).split("|");
        const line = byKey.get(ck)?.lines.find((l) => l.id === rest.join("|"));
        val = line?.v ?? null;
        if (line?.inputs && val != null) {
          if (depth > 4) { err(col, `${i.ref}: 재귀 깊이 초과`); return null; }
          const sub = await evalInputs(line.inputs, col, depth + 1);
          if (sub && Math.abs(sub.sum - val) > noise(sub.abs, line.inputs.length)) err(col, `${i.ref}: 칸 ${val} ≠ 입력 합 ${sub.sum}`);
        }
      } else if (i.v != null) val = i.v;
      if (val == null) { err(col, `${i.ref}: 참조 해석 실패`); return null; }
      const t = i.op * val * (i.x ? i.x.v : 1);
      sum += t;
      abs += Math.abs(t);
    }
    return { sum, abs };
  };
  for (const ser of series)
    for (const mv of Object.values(ser.values)) {
      if (!mv.inputs || mv.v == null) continue;
      mv.calculatedAt = at;
      const r = await evalInputs(mv.inputs, mv.col, 0);
      if (r && Math.abs(r.sum - mv.v) > noise(r.abs, mv.inputs.length)) err(mv.col, `${METRIC_NAME[ser.metric]} ${mv.v} ≠ 입력 합 ${r.sum}(차 ${mv.v - r.sum})`);
    }
  return errs;
}
