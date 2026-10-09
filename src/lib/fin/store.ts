import "server-only";
import { finChgCol, finStmtCol, finSymCol, type FinChgDoc, type FinColTuple, type FinDer, type FinDerIn, type FinExc, type FinStmtDoc, type FinSymDoc } from "../db/fin";
import { Gap, type AssembledIs, type Column, type DerivedInput, type FinAssembly, type MetricValue, type Prov } from "./types";

/**
 * 저장·조회(architecture.md §3). 조립 결과만 저장한다(SEC 원자료 저장 안 함). 이전 판본은 복사하지 않고, 바뀐 칸만
 * fin_chg 에 쓴 뒤 본문서를 교체한다.
 */

/** 엔진판 — 판독·조립 규칙이 바뀌면 올린다(fin_chg 사유 "ev") */
export const ENGINE_VERSION = 47; // 47: 현금흐름표 차입 줄 개념 추가 — MSFT 장기 조달·상환(MaturingInMoreThanThreeMonths)·단기 상환, AMD 본표 같은 줄의 10-K/10-Q 태그 차이(ProceedsFromShortTermDebt·RepaymentsOfCommercialPaper — LTM 상환 950 → 0) · 46: 현금흐름표 투자자산 처분·취득 — 본표에 회사 고유 태그 줄이 섞인 공시는 같은 성격 본표 줄 전부 합(NVDA 2027 회계연도 10-Q 지분증권 nvda: 태그 — LTM 부분값·기타 투자활동이 떠안던 것), 공시별 병합에서 합계가 대신한 구성 개념은 구성 개념 집합에서 뺌 · 45: 현금흐름표 — 잔여(기타) 줄 LTM 은 형제 줄에 최근 분기 금액이 있는데 LTM 을 못 만들면 빈칸(GEV·VRT), 합산 줄 분기·LTM 은 공시별 구성 개념이 다르면 빈칸·태그 교체면 병합(WMT·META), 주식보상 본표 회사 고유 줄(BE) · 44: 일회성비용 줄·설명은 금액이 있을 때만(AAPL 전 기간 0 숨김) · 43: 예상 순이익 = 예상 희석 EPS × 현재 주식수(칸 주석에 산식) · 42: 현금흐름 분기 4분기 열(사업연도 − 9개월)·20-F 재무상태표 분기 열 없음(화면 간 분기 열 일치) · 41: 금융 자회사 보유사 신용지표 = 연결 총차입금(EV 만 제조 부문) · 40: 20-F LTM 우선주·비지배지분(연말 0·없음) = 0(ASML LTM EV)·상장 전 시가총액·EV 사유 · 39: BE 보통주 배당 0(근거 없으면)·현금흐름표 분배 줄 이름·20-F LTM EV 구성요소 = SEC 연말 + Yahoo 분기 변동분(ASML·TSM, 오너 결정 (가)) · 38: 은행·카드사 EV 표시(AXP)·금융 부문 차입금 이중 태깅 제외(CAT)·본표에 차입금 줄 없으면 0(PLTR 2023) · 37: 금융 자회사 보유사 EV 표시(제조 부문 차입금 — 블룸버그 방식)·하이라이트 영업현금흐름·자본지출 = 현금흐름표 화면·재무상태표 주석 장기차입금(운용리스 제외) · 36: 재무분석 영업현금흐름·자본지출 = 현금흐름표 화면 값(MAR LTM 태그 교체)·IFRS 주당 배당 = 보통주 배당 근거(TSM) · 35: 자본 정정 주석 = 정정을 처음 실은 공시 · 34: 자본 정정 열(오너 결정 (다) — WDC FY2022): 자본 = 나중 정기공시 값, 자산·부채와 자본 총계 = 부채 + 자본(재무상태표 화면·재무분석 공통 equityRestatement) · 33: 재무분석 영업현금흐름·현금 개념 목록 = 화면(MRK 2021·MDLZ) · 32: 단기투자 판독 없는 기간도 화면·재무분석 같은 태그 목록(STI_TAGS, DELL 2022)·재무분석 부채 파생 비지배지분 = EV 브리지 값 · 31: 재무분석 현금비율 단기투자 판독값도 기준일로(재무상태표 화면과 같은 값) · 30: 단기 투자자산 본표 판독값을 기준일로 읽음(10-Q 비교 열 판독 — GOOG 등 2025 빈칸)·VRT 보통주 배당 근거(자본변동표 배당 = 지급액) · 29: 단기 투자자산 = 본표 유동자산 단기투자 줄 합(재무상태표 화면·재무분석 현금비율 — 매도가능 채권 총액이 유동으로 잡히던 INTC·CAT·KO) · 28: 재무분석 부채 파생 = 부채와 자본 − 비지배지분 포함 자본 − 임시자본(재무상태표 화면과 같은 정의 — KO·WMT·INTC·MRK·ORCL 부채비율) · 27: 자본 총계 = 지배주주 자본(태그 없으면 포함 자본 − 비지배지분, CAT)·현금에 중단사업 현금 포함 태그(MDLZ 2023~) · 26: 임시자본(메자닌) 줄·부채총계 파생에서 임시자본 차감(TSLA·UBER·HLT·WDC·BE·TER·AVGO)·재무상태표 한 열 = 자산총계를 실은 연간 공시 값(WDC FY2022) · 25: 부채총계 미태깅 파생 = 부채와자본 − 비지배지분 포함 자본(KO) · 24: 반올림 재게시 판정 음수 대칭(MCD 2023 현금흐름 −3,184.5 → −3,185)·표기 단위 변경 재게시 공시 단위 판정(MCD 2025 10-K) · 23: 현금흐름표 연간 값 나중 공시 우선(오너 결정 — 부호만 뒤집힌 재게시는 앞선 값, AMD 2021) · 대체 태그 병합이 같은 개념의 나중 판본을 버리던 문제 · 22: 분기 3개월 공시값이 반올림 값이면 누적 차(NVDA 배당 6,000 → 6,047) · 작은 단위 반올림 재게시 판정에 짝수 반올림·1단위 조정 포함(MRVL 2022 유동자산·유동부채) · 21: 대체 태그 병합 — 한 결산일 = 한 개념(GOOG 주식보상비용 LTM 이 손익 쪽 태그 3개월 값과 섞임)·현금흐름표 중단사업 현금흐름 줄(MRK 2021) · 20: EV 브릿지 — 한 번도 공시 안 한 개념은 없음(SPOT LTM 장기 투자증권) · 19: 일회성비용에 사업 분리 비용(SNDK·WDC) · 18: 일회성비용 반올림 재게시 → 원 공시 정밀값(MCD) · 17: 일회성비용 금액 = 줄 구성을 준 그 공시의 값(ORCL 인수 관련 비용 중복) · 16: 작은 단위 반올림 재게시 교체 하한 1억 → 단위의 100배(MRVL FY2022 법인세) · 15: 현금흐름표 감가상각 — 태그만 다른 제외 항목(HLT 계약획득원가 상각) · 14: 회사 재분류 1분기(오너 결정 2026-09-29 — 6개월 누적 − 2분기 3개월 역산·칸 주석, read/index.ts recastQ1) · 13: LTM = 최근 4개 분기 열 합(오너 결정 2026-09-28 — CL 매출 21,047 → 21,046 등 ±1) · 12: 판관비·연구개발비 지표(fin_sym.m.sga·rnd·d·n·sp, fin_stmt.r — docs/metrics/sga.md, 2026-09-28) · 5: 파생값 입력 구조(fin_sym.d, 2026-09-26) · 6: 매출원가·매출총이익·영업이익·영업비용 지표(fin_sym.m.cogs·gp·opinc·opex·d·n, 2026-09-26) · 7: 외화 환산 환율 Yahoo → 연준 H.10(TSM·ASML·SPOT 등 값 변경, 2026-09-27) · 8: 유형 D 매출원가 구성 규칙 10종목(XOM·MCD·V·ORCL·MAR·HLT·SBUX·DAL·CEG·VST 매출원가·매출총이익·영업비용 채움, 2026-09-27) · 9: 영업이익 소계 없는 본표 = 공시 계산 구조 합성(IBM·XOM)·CAT 본표 소계 그대로(fin_sym.m.opinc·opex 채움, 화면 전환, 2026-09-27) · 10: 금융 자회사 보유사 소계 없는 본표는 빈칸+사유(IBM 예외, 2026-09-27) · 11: 영업외 목록에 연금 비근무원가 추가(XOM 합성 영업이익, 2026-09-27)
/** 문서 스키마판 — 압축 형식이 바뀌면 올린다 */
export const SCHEMA_VERSION = 1;

const MAX_DICT = 4096;
const MAX_LINES = 2047;

function colTuple(c: Column): FinColTuple {
  if (Array.isArray(c.src)) return [c.key, c.start, c.end, null, c.kind === "Q" ? "QD" : c.kind, null, c.gaps];
  const p = c.src as Prov;
  return [c.key, c.start, c.end, p.accn, p.form, p.filed, c.gaps];
}

function excOf(mv: MetricValue): FinExc | null {
  if (mv.why?.k === "derived") return { d: mv.why.parts.map((p) => [p.accn, p.sign]) };
  if (mv.why?.k === "fx") return { k: "fx", r: mv.why.rate };
  if (mv.why?.k === "yahoo-q") return { k: "yq", t: mv.why.through };
  return null;
}

/**
 * 파생값 입력 → 압축 저장형(FinDer). 매출 입력이 `c:` 로 가리킨 칸이 파생이면 그 칸의 입력도 ln 에 담는다(재귀 — 저장본만으로
 * 끝까지 전개). 시장 데이터 asOf 는 표(a)로 한 번만.
 */
function toDer(a: FinAssembly, cols: Column[]): FinDer | null {
  const lines = new Map<string, DerivedInput[]>();
  for (const x of [...a.annual, ...a.quarterly]) for (const l of x.lines) if (l.inputs) lines.set(`${x.col.key}|${l.id}`, l.inputs);
  const asOf: string[] = [];
  const ai = (s: string | undefined) => {
    if (s == null) return null;
    const i = asOf.indexOf(s);
    return i >= 0 ? i : asOf.push(s) - 1;
  };
  const ln: Record<string, FinDerIn[]> = {};
  const enc = (ins: DerivedInput[]): FinDerIn[] =>
    ins.map((i) => {
      if (i.ref.startsWith("c:")) {
        const k = i.ref.slice(2);
        const sub = lines.get(k);
        if (sub && !ln[k]) {
          ln[k] = []; // 전개 중 표시(순환 참조 방지)
          ln[k] = enc(sub);
        }
      }
      const t: FinDerIn = [i.ref, i.op, i.role ?? null, i.v ?? null, ai(i.asOf), i.x?.ref ?? null, i.x?.v ?? null, ai(i.x?.asOf)];
      while (t.length > 2 && t[t.length - 1] == null) t.pop();
      return t;
    });
  let at: string | null = null;
  const series = (s: FinAssembly["metrics"][keyof FinAssembly["metrics"]]) => {
    const out: Record<string, FinDerIn[]> = {};
    for (const c of cols) {
      const mv = s.values[c.key];
      if (!mv?.inputs || mv.v == null) continue;
      out[c.key] = enc(mv.inputs);
      at ??= mv.calculatedAt ?? a.at;
    }
    return out;
  };
  // 같은 열 칸만 가리키는 입력(합성 매출총이익 = 매출 칸 − 매출원가 칸, 영업비용 = 매출총이익 − 영업이익 칸)은 열마다 모양이 같다 —
  // 열 키를 "*" 로 바꾼 틀이 같은 열끼리 틀 1개 + 열 목록으로 묶어 tp 에 둔다(용량 — 무료 DB 512MB, cogs.md §7). 매출(rev)은 기존 형식 유지
  const tp: Record<string, [FinDerIn[], string[]][]> = {};
  const templated = (name: string, out: Record<string, FinDerIn[]>) => {
    const groups = new Map<string, { t: FinDerIn[]; cols: string[] }>();
    for (const [col, ins] of Object.entries(out)) {
      const own = `c:${col}|`;
      if (!ins.every((t) => t[0].startsWith(own))) continue;
      const t = ins.map((x) => [`c:*|${x[0].slice(own.length)}`, ...x.slice(1)] as FinDerIn);
      const k = JSON.stringify(t);
      const g = groups.get(k) ?? groups.set(k, { t, cols: [] }).get(k)!;
      g.cols.push(col);
    }
    for (const g of groups.values()) {
      if (g.cols.length < 2) continue;
      for (const c of g.cols) delete out[c];
      (tp[name] ??= []).push([g.t, g.cols]);
    }
    return out;
  };
  const rev = series(a.metrics.revenue);
  const cogs = templated("cogs", series(a.metrics.cogs));
  const gp = templated("gp", series(a.metrics.gp));
  const opinc = templated("opinc", series(a.metrics.opinc));
  const opex = templated("opex", series(a.metrics.opex));
  const sga = templated("sga", series(a.metrics.sga));
  const rnd = templated("rnd", series(a.metrics.rnd));
  if (!at) return null;
  return {
    rev, ...(Object.keys(cogs).length ? { cogs } : {}), ...(Object.keys(gp).length ? { gp } : {}),
    ...(Object.keys(opinc).length ? { opinc } : {}), ...(Object.keys(opex).length ? { opex } : {}),
    ...(Object.keys(sga).length ? { sga } : {}), ...(Object.keys(rnd).length ? { rnd } : {}),
    ...(Object.keys(tp).length ? { tp } : {}),
    ...(Object.keys(ln).length ? { ln } : {}), ...(asOf.length ? { a: asOf } : {}), at,
  };
}

export function toSymDoc(a: FinAssembly): FinSymDoc {
  const seen = new Set<string>();
  const cols: Column[] = [];
  for (const x of [...a.annual, ...a.quarterly]) if (!seen.has(x.col.key)) { seen.add(x.col.key); cols.push(x.col); }
  const rev = a.metrics.revenue.values;
  const x: Record<string, FinExc> = {};
  for (const c of cols) {
    const mv = rev[c.key];
    if (!mv) continue;
    const e = excOf(mv);
    if (e) x[c.key] = e;
  }
  const der = toDer(a, cols);
  // 지표 칸 사유·주석 — 문구 → 열키 목록(같은 문구는 한 번만)
  const notes: Record<string, [string, string[]][]> = {};
  for (const [k, s] of [["cogs", a.metrics.cogs], ["gp", a.metrics.gp], ["opinc", a.metrics.opinc], ["opex", a.metrics.opex], ["sga", a.metrics.sga], ["rnd", a.metrics.rnd]] as const) {
    const by = new Map<string, string[]>();
    for (const c of cols) {
      const mv = s.values[c.key];
      const t = mv ? (mv.v == null ? mv.reason : mv.note) : undefined;
      if (t) by.set(t, [...(by.get(t) ?? []), c.key]);
    }
    if (by.size) notes[k] = [...by];
  }
  return {
    _id: `${a.profile.market}:${a.profile.symbol}`,
    ev: ENGINE_VERSION, sv: SCHEMA_VERSION, at: new Date(), la: a.latestAccn,
    p: { t: a.profile.type, fl: a.profile.filer, sic: a.profile.sic, cur: a.profile.reportingCurrency, adr: a.profile.adrRatio },
    g: a.gaps,
    c: cols.map(colTuple),
    m: {
      rev: cols.map((c) => rev[c.key]?.v ?? null),
      cogs: cols.map((c) => a.metrics.cogs.values[c.key]?.v ?? null),
      gp: cols.map((c) => a.metrics.gp.values[c.key]?.v ?? null),
      opinc: cols.map((c) => a.metrics.opinc.values[c.key]?.v ?? null),
      opex: cols.map((c) => a.metrics.opex.values[c.key]?.v ?? null),
      sga: cols.map((c) => a.metrics.sga.values[c.key]?.v ?? null),
      rnd: cols.map((c) => a.metrics.rnd.values[c.key]?.v ?? null),
    },
    x: { rev: x },
    ...(der ? { d: der } : {}),
    ...(Object.keys(notes).length ? { n: notes } : {}),
    ...subLines(a, cols),
    ...(a.issues.length ? { i: a.issues.map((q) => (q.der?.length ? [q.col, q.rev, q.other, q.unv, q.der] : [q.col, q.rev, q.other, q.unv]) as [string, string[], string[], string[], string[]?]) } : {}),
  };
}

/**
 * 판관비·연구개발비 하위 줄(docs/metrics/sga.md §4) — 열마다 지표의 하위 줄(opx.sgaSub·rndSub)의 값. 줄 id 는 열을 통틀어 처음 나온 순서,
 * 라벨은 최근 열 것. 하위 줄이 있는 열이 하나도 없으면 생략. 화면 손익계산서가 합계 아래 줄로 보인다(fin_stmt 없이 fin_sym 만으로)
 */
function subLines(a: FinAssembly, cols: Column[]): Pick<FinSymDoc, "sp"> {
  const byKey = new Map([...a.annual, ...a.quarterly].map((x) => [x.col.key, x] as const));
  const sp: NonNullable<FinSymDoc["sp"]> = {};
  for (const kind of ["sga", "rnd"] as const) {
    const ids: string[] = [];
    const label = new Map<string, string>();
    for (const c of cols) for (const id of byKey.get(c.key)?.opx?.[kind === "sga" ? "sgaSub" : "rndSub"] ?? []) {
      if (!ids.includes(id)) ids.push(id);
      label.set(id, byKey.get(c.key)!.lines.find((l) => l.id === id)?.label ?? id);
    }
    if (!ids.length) continue;
    sp[kind] = ids.map((id) => [id, label.get(id)!, cols.map((c) => {
      const x = byKey.get(c.key);
      // 그 열 지표의 하위 줄일 때만(지표를 비운 열은 하위 줄도 비움 — 합계 없이 조각만 보이지 않게)
      if (!x?.opx?.[kind === "sga" ? "sgaSub" : "rndSub"].includes(id) || a.metrics[kind].values[c.key]?.v == null) return null;
      return x.lines.find((l) => l.id === id)?.v ?? null;
    })]);
  }
  return Object.keys(sp).length ? { sp } : {};
}

export function toStmtDoc(id: string, cols: AssembledIs[], labels: Map<string, string>): FinStmtDoc {
  const dict: [string, string][] = [];
  const di = new Map<string, number>();
  const s: number[][] = [];
  const v: (number | null)[][] = [];
  for (const a of cols) {
    if (a.lines.length > MAX_LINES) throw new Error(`fin_stmt ${id} ${a.col.key}: 열당 줄 상한 초과(${a.lines.length}) — sv 를 올려야 함`);
    const row: number[] = [];
    for (const ln of a.lines) {
      let k = di.get(ln.id);
      if (k == null) {
        k = dict.length;
        if (k >= MAX_DICT) throw new Error(`fin_stmt ${id}: 줄 사전 상한 초과 — sv 를 올려야 함`);
        di.set(ln.id, k);
        dict.push([ln.id, labels.get(ln.id) ?? ln.label]);
      }
      row.push(k * 4096 + (ln.parent == null ? 0 : (ln.parent + 1) * 2) + (ln.w < 0 ? 1 : 0));
    }
    s.push(row);
    v.push(a.lines.map((l) => l.v));
  }
  // 판관비·연구개발비 줄 역할(docs/metrics/sga.md §4) — 역할 → [줄 사전 번호, 열키[]][]
  const r: NonNullable<FinStmtDoc["r"]> = {};
  for (const a of cols)
    for (const ln of a.lines) {
      if (!ln.role || !/^(sga|rnd)(.part)?$/.test(ln.role)) continue;
      const k = di.get(ln.id)!;
      const e = (r[ln.role] ??= []).find((x) => x[0] === k);
      if (e) e[1].push(a.col.key);
      else r[ln.role].push([k, [a.col.key]]);
    }
  return { _id: id, ev: ENGINE_VERSION, l: dict, c: cols.map((a) => a.col.key), s, v, ...(Object.keys(r).length ? { r } : {}) };
}

/** 압축 구조 → (줄 id, 부모 위치, 가중치) */
export function decodeStmt(doc: FinStmtDoc, colKey: string): { id: string; label: string; parent: number | null; w: 1 | -1 | 0; v: number | null }[] | null {
  const ci = doc.c.indexOf(colKey);
  if (ci < 0) return null;
  return doc.s[ci].map((n, i) => {
    const dictIdx = Math.floor(n / 4096);
    const rest = n % 4096;
    const parent = rest >> 1 ? (rest >> 1) - 1 : null;
    return { id: doc.l[dictIdx][0], label: doc.l[dictIdx][1], parent, w: parent == null ? 0 : rest & 1 ? -1 : 1, v: doc.v[ci][i] };
  });
}

function stmtCells(doc: FinStmtDoc): Map<string, number | null> {
  const out = new Map<string, number | null>();
  doc.c.forEach((ck, ci) => doc.s[ci].forEach((n, i) => out.set(`${ck}|${doc.l[Math.floor(n / 4096)][0]}`, doc.v[ci][i])));
  return out;
}

/** 저장 — 바뀐 칸만 fin_chg, 본문서 교체. 원자료 조회 실패(부분 판독)면 기존 문서를 유지하고 gaps 비트만 올린다(§5.1) */
// 비저장 모드 — 주입 시험 중 운영 DB 쓰기 차단(persist·markFailed·touchChecked 공통, 재감사 2026-09-25)
function assertPersistAllowed(): void {
  if (process.env.FIN_NO_PERSIST) throw new Error("FIN_NO_PERSIST 설정 — 비저장 모드라 fin_sym·fin_stmt·fin_chg 저장 거부(주입 시험은 검증기 쪽 가로채기 또는 --dry)");
}

export async function persist(a: FinAssembly, stmts: { annual: FinStmtDoc; quarterly: FinStmtDoc }): Promise<{ changed: number; kept: boolean }> {
  // 주입 시험·실험 실행의 운영 DB 기록 차단(재감사 2026-09-25 — 주입 시험이 fin_chg 에 12건을 남김). 이 변수가 있으면 저장을 거부한다
  assertPersistAllowed();
  const symCol = await finSymCol();
  const stmtCol = await finStmtCol();
  const chgCol = await finChgCol();
  const sym = toSymDoc(a);
  const old = await symCol.findOne({ _id: sym._id });
  if (old && a.gaps & (Gap.CF_FETCH | Gap.STALE)) {
    // 기존 문서 유지 — 정상 적재 시각(at)은 그대로 두고 실패 시각만(ft). at 을 올리면 엔진판이 다른 저장본의 사용 기한(fin/index.ts 7일)이 실패마다 늘어났다
    await symCol.updateOne({ _id: sym._id }, { $set: { g: old.g | a.gaps, ft: new Date() } });
    return { changed: 0, kept: true };
  }
  const now = new Date();
  const chg: FinChgDoc[] = [];
  const r: FinChgDoc["r"] = old && old.ev !== ENGINE_VERSION ? "ev" : "data";
  if (old)
    for (const mk of ["rev", "cogs", "gp", "opinc", "opex", "sga", "rnd"]) {
      const o = new Map(old.c.map((c, i) => [c[0], old.m[mk]?.[i] ?? null]));
      sym.c.forEach((c, i) => {
        const n = sym.m[mk]?.[i] ?? null;
        const ov = o.has(c[0]) ? o.get(c[0])! : null;
        if (ov !== n) chg.push({ k: sym._id, at: now, ev: ENGINE_VERSION, t: `m.${mk}`, c: c[0], o: ov, n, r });
      });
    }
  for (const doc of [stmts.annual, stmts.quarterly]) {
    const prev = await stmtCol.findOne({ _id: doc._id });
    if (prev) {
      const pc = stmtCells(prev), nc = stmtCells(doc);
      const tag = doc._id.split(":").slice(2).join(".");
      for (const [k, n] of nc) {
        const ov = pc.has(k) ? pc.get(k)! : null;
        if (ov !== n) { const [c, line] = k.split("|"); chg.push({ k: sym._id, at: now, ev: ENGINE_VERSION, t: `${tag}:${line}`, c, o: ov, n, r }); }
      }
    }
    await stmtCol.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }
  await symCol.replaceOne({ _id: sym._id }, sym, { upsert: true });
  if (chg.length) await chgCol.insertMany(chg);
  return { changed: chg.length, kept: false };
}

/** 조립 실패(원천 조회 불가) — 기존 문서가 있으면 gaps 만 올린다 */
export async function markFailed(id: string, gaps: number): Promise<void> {
  assertPersistAllowed();
  const symCol = await finSymCol();
  await symCol.updateOne({ _id: id }, { $bit: { g: { or: gaps } }, $set: { ft: new Date() } });
}

/** 배치 갱신 판정용 메타 — 엔진판·최신 공시 accn·적재 시각·마지막 확인 시각 */
export async function readSymMeta(ids: string[]): Promise<Map<string, Pick<FinSymDoc, "_id" | "ev" | "la" | "at" | "ck" | "ft">>> {
  const docs = await (await finSymCol()).find({ _id: { $in: ids } }, { projection: { ev: 1, la: 1, at: 1, ck: 1, ft: 1 } }).toArray();
  return new Map(docs.map((d) => [d._id, d]));
}

/** 새 정기공시 없음을 확인한 시각 — 다음 배치가 오래 확인 안 한 종목부터 보게 */
export async function touchChecked(id: string): Promise<void> {
  assertPersistAllowed();
  await (await finSymCol()).updateOne({ _id: id }, { $set: { ck: new Date() } });
}

export async function readSym(id: string): Promise<FinSymDoc | null> {
  return (await finSymCol()).findOne({ _id: id });
}
export async function readStmt(id: string): Promise<FinStmtDoc | null> {
  return (await finStmtCol()).findOne({ _id: id });
}
