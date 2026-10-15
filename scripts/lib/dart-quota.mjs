/**
 * DART 하루 요청 상한(2026-10-05 사고 — 검증 서버의 전체 검증·적재 점검이 운영과 같은 DART 키의 하루 한도(20,000)를 다 써 운영 한국 재무가 멈췄다).
 *
 *  - 도구마다 하루 상한(기본: 검증기 3,000 · 적재 2,000, 환경변수 DART_DAILY_CAP_VERIFY · DART_DAILY_CAP_POPULATE)을 두고, 날짜(KST)별 파일
 *    `reports/.dart-quota/YYYYMMDD.json`({ 도구: 건수 })에 요청마다 남긴다. 여러 번 실행해도 그날 합계로 센다.
 *  - 상한에 닿으면 그 자리에서 멈춘다(DartStopError) — 호출부는 남은 종목을 "상한 도달 — 검증불가/미처리"로 끝낸다(조용히 건너뛰지 않음).
 *  - 응답이 020(사용한도 초과)이면 그 자리에서 전체 중단 — 이후 요청은 모두 같은 오류로 즉시 실패(재시도 없음).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export class DartStopError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "DartStopError";
    this.kind = kind; // "cap" | "020"
  }
}

const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");

/** tool = "verify" | "populate", cap = 하루 상한, dir = 카운터 폴더(URL 또는 경로) */
export function makeDartQuota({ tool, cap, dir }) {
  const root = dir instanceof URL ? dir : new URL(String(dir).replace(/\/?$/, "/"), "file://");
  let stopped = null;
  const fileOf = () => new URL(`${kstDay()}.json`, root);
  const read = () => {
    try { return JSON.parse(readFileSync(fileOf(), "utf8")); }
    catch (e) { if (e?.code === "ENOENT") return {}; throw e; }
  };
  const state = () => ({ tool, cap, day: kstDay(), count: read()[tool] ?? 0, stopped });
  return {
    state,
    get stopped() { return stopped; },
    /** 요청 한 건 전 — 상한이면 던진다(그날 파일 기준). 넘지 않았으면 1 올려 파일에 남긴다 */
    take() {
      if (stopped) throw stopped;
      const c = read();
      const n = c[tool] ?? 0;
      if (n >= cap) {
        stopped = new DartStopError("cap", `DART 하루 요청 상한 도달(${tool} ${n}/${cap}건, ${kstDay()} KST) — 남은 요청 중단`);
        throw stopped;
      }
      c[tool] = n + 1;
      if (!existsSync(root)) mkdirSync(root, { recursive: true });
      writeFileSync(fileOf(), JSON.stringify(c));
    },
    /** 응답 본문 앞부분 검사 — 020(사용한도 초과)이면 전체 중단 */
    check(headText) {
      if (/<status>020<\/status>|"status"\s*:\s*"020"/.test(headText)) {
        stopped = new DartStopError("020", "DART 응답 020(사용한도 초과) — 그 자리에서 전체 중단(같은 키를 쓰는 운영에도 영향)");
        throw stopped;
      }
    },
  };
}
