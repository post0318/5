/**
 * 브라질 국채 NTN-F ~10년 롤링 수익률(중간값) 일별 수집 — 1호기 타이머 `macro-br-ntnf`(매일 07:10 KST)가 run-ts.sh 로 실행한다(2026-10-06 오너 지시 —
 * 주간 리포트가 4번 프로젝트 저장소 JSON 에 기대던 것을 끊고 5번이 직접 수집). 정의·우선순위는 src/lib/weekly/ntnf.ts(4번과 같음, 2026-10-09 오너 결정).
 *   1) 재무부 CSV(약 14MB, 매일 약 10:20 UTC 에 전 영업일분 갱신)를 줄 단위로 읽어 **DB 에 없는 날짜만** 중간값(csv-mid)으로 넣는다.
 *      컬렉션이 비어 있으면 처음 한 번 4번과 같은 기간(실행일 기준 7년)을 백필한다.
 *   2) ANBIMA 일일 파일(약 4주치만 공개)을 최근 35일 평일 중 **아직 anbima 가 아닌 날짜만** 받아 넣는다(CSV 값 대체).
 *   실시간 임시값은 쓰지 않는다(확정 자료만).
 *
 * 실패(종료코드 1 → 1호기 점검 job-macro-br-ntnf 알림):
 *   - CSV 조회·형식 오류, ANBIMA 404 아닌 오류·형식 변경
 *   - 신선도: 저장된 최신 기준일 이후 브라질 영업일(주말 제외, 휴일은 모름)이 3일 넘게 지났는데 새 값이 없음
 *
 * 실행: NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/ntnf-daily.mts [옵션]
 *   --since=YYYY-MM-DD : CSV 를 그 날짜부터 다시 훑는다(없는 날짜만 넣음 — 기존 값은 안 바꿈)
 *   --dry              : 계산만 하고 DB 에 쓰지 않는다
 *   --compare[=URL]    : DB 없이 계산값(CSV 중간값 + ANBIMA)을 4번 JSON(기본 post0318/4 main 의 ntnf-yield-history.json)과
 *                        날짜별 정확 대조(4번의 live 값은 제외), 불일치 있으면 종료코드 1
 * 필요한 환경변수: MONGODB_URI(--dry·--compare 가 아니면 필수)
 */
import { isDbConfigured } from "@/lib/db";
import { brNtnfAnbimaDates, insertNewBrNtnf, latestBrNtnfDate, putAnbimaBrNtnf } from "@/lib/db/br-ntnf";
import { fetchAnbimaDay, fetchNtnfRows, ntnfTenYearPoints, type NtnfPoint } from "@/lib/weekly/ntnf";

const FOURTH_JSON = "https://raw.githubusercontent.com/post0318/4/main/src/lib/server/ntnf-yield-history.json";
const STALE_BUSINESS_DAYS = 3;
/** ANBIMA 파일은 약 4주치만 남는다 — 그보다 조금 넓게 훑는다 */
const ANBIMA_LOOKBACK_DAYS = 35;

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : "";
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** 4번과 같은 백필 시작일 — 실행 시점 7년 전 */
function sevenYearsAgo(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 7);
  return ymd(d);
}

/** latest 다음 날부터 today 전날까지의 평일 수 */
function weekdaysBetween(latest: string, today: string): number {
  let n = 0;
  const d = new Date(`${latest}T00:00:00Z`);
  for (let i = 0; i < 400; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const s = ymd(d);
    if (s >= today) break;
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

/** today 포함 이전 n일 중 평일(YYYY-MM-DD, 오래된 순) */
function recentWeekdays(today: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(ymd(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

/** 주어진 날짜들의 ANBIMA 값(없는 날 건너뜀). 404 아닌 오류는 모아서 돌려준다 */
async function fetchAnbimaDays(dates: string[]): Promise<{ points: NtnfPoint[]; errors: string[] }> {
  const points: NtnfPoint[] = [];
  const errors: string[] = [];
  for (const d of dates) {
    try {
      const p = await fetchAnbimaDay(d);
      if (p) points.push(p);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { points, errors };
}

const brToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

async function compare(points: NtnfPoint[], url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`4번 JSON 조회 실패 (HTTP ${res.status})`);
  const j = (await res.json()) as {
    asOfDate?: string;
    generatedAt?: string;
    points?: { date: string; ytm: number; maturityYear: number; src?: string; live?: boolean }[];
  };
  const live = (j.points ?? []).filter((p) => p.live);
  if (live.length) console.log(`4번 실시간 임시값(대조 제외): ${live.map((p) => `${p.date} ${p.ytm}`).join(", ")}`);
  const theirs = new Map((j.points ?? []).filter((p) => !p.live).map((p) => [p.date, p]));
  const mine = new Map(points.map((p) => [p.date, p]));
  let bad = 0;
  let same = 0;
  for (const [date, t] of theirs) {
    const m = mine.get(date);
    if (!m) {
      bad++;
      console.log(`불일치 ${date}: 4번 ${t.ytm}%(${t.maturityYear}) / 5번 없음`);
    } else if (m.ytm !== t.ytm || m.maturityYear !== t.maturityYear || (t.src === "anbima") !== (m.src === "anbima")) {
      bad++;
      console.log(`불일치 ${date}: 4번 ${t.ytm}%(${t.maturityYear}, ${t.src ?? "csv"}) / 5번 ${m.ytm}%(${m.maturityYear}, ${m.src})`);
    } else same++;
  }
  const first = [...theirs.keys()].sort()[0];
  const lastConfirmed = [...theirs.keys()].sort().at(-1) ?? "";
  const extra = points.filter((p) => !theirs.has(p.date) && first && p.date >= first && p.date <= lastConfirmed);
  for (const p of extra) {
    bad++;
    console.log(`불일치 ${p.date}: 4번 없음 / 5번 ${p.ytm}%(${p.maturityYear})`);
  }
  console.log(
    `대조: 4번 확정 ${theirs.size}일(${first} ~ ${lastConfirmed}, anbima ${[...theirs.values()].filter((p) => p.src === "anbima").length}일, 생성 ${j.generatedAt}) · 정확 일치 ${same} · 불일치 ${bad}` +
      ` · 5번만 있는 4번 기간 밖 날짜 ${points.filter((p) => !theirs.has(p.date)).length - extra.length}`,
  );
  return bad;
}

async function main() {
  const dry = arg("dry") !== undefined;
  const cmp = arg("compare");
  if (cmp === undefined && !dry && !isDbConfigured()) throw new Error("MONGODB_URI 미설정");

  const t0 = Date.now();
  const rows = await fetchNtnfRows();
  const csvLatest = rows.reduce((a, r) => (r.dataBase > a ? r.dataBase : a), "");
  console.log(`재무부 CSV: NTN-F ${rows.length}줄 · 최신 기준일 ${csvLatest} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (cmp !== undefined) {
    const merged = new Map(ntnfTenYearPoints(rows, arg("since") ?? "").map((p) => [p.date, p]));
    const an = await fetchAnbimaDays(recentWeekdays(brToday(), ANBIMA_LOOKBACK_DAYS));
    for (const p of an.points) merged.set(p.date, p);
    console.log(`ANBIMA: ${an.points.length}일 (${an.points[0]?.date} ~ ${an.points.at(-1)?.date})${an.errors.length ? ` · 오류 ${an.errors.join(" / ")}` : ""}`);
    const bad = await compare([...merged.values()].sort((a, b) => a.date.localeCompare(b.date)), cmp || FOURTH_JSON);
    if (bad) process.exitCode = 1;
    return;
  }

  const latest = dry ? null : await latestBrNtnfDate();
  let since = arg("since");
  if (!since) {
    if (latest) {
      // 최근 2주를 다시 훑되 없는 날짜만 넣는다(CSV 가 하루 늦게 앞 날짜를 채우는 경우 대비) — 기존 값은 바꾸지 않는다
      const d = new Date(`${latest}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 14);
      since = ymd(d);
    } else {
      since = sevenYearsAgo();
      console.log(`저장된 값 없음 — ${since} 부터 백필`);
    }
  }
  const points = ntnfTenYearPoints(rows, since);
  const last = points.at(-1);
  console.log(`계산: ${since} 이후 ${points.length}일 · 최신 ${last ? `${last.date} ${last.ytm}% (만기 ${last.maturityDate})` : "없음"}`);
  if (dry) return;

  const added = await insertNewBrNtnf(points);
  console.log(`CSV 중간값: 새로 넣은 날짜 ${added}건`);

  const todayBr = brToday();
  const days = recentWeekdays(todayBr, ANBIMA_LOOKBACK_DAYS);
  const have = await brNtnfAnbimaDates(days[0]);
  const want = days.filter((d) => !have.has(d));
  const an = await fetchAnbimaDays(want);
  const put = await putAnbimaBrNtnf(an.points);
  console.log(`ANBIMA: 확인 ${want.length}일 · 받은 ${an.points.length}일(${an.points.map((p) => `${p.date} ${p.ytm}`).join(", ") || "없음"}) · 저장 ${put}건`);
  if (an.errors.length) {
    console.error(`ANBIMA 오류: ${an.errors.join(" / ")}`);
    process.exitCode = 1;
  }
  const now = await latestBrNtnfDate();
  console.log(`DB 최신 ${now}`);

  const lag = now ? weekdaysBetween(now, todayBr) : Infinity;
  if (lag > STALE_BUSINESS_DAYS) {
    console.error(`신선도 경고: DB 최신 ${now}, 브라질 오늘 ${todayBr} — 그 사이 평일 ${lag}일(기준 ${STALE_BUSINESS_DAYS}일 초과). 재무부 CSV 갱신 정지 의심(CSV 최신 ${csvLatest})`);
    process.exitCode = 1;
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
