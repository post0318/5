/**
 * 검증기 디스크 캐시(한국 — DART·KRX, 오너 제안 2026-10-05 "SEC 처럼 DART 도 디스크 캐시를 쓰면?").
 *
 * 배치: <root>/<ns>/<요청 열쇠>/<판본>.json — 요청 하나에 판본 파일 하나만 남긴다.
 *  - 판본 = DART 는 그 보고서의 최신 접수번호(rcept_no, 정정 공시가 나오면 바뀐다), KRX 는 날짜(지난 날짜는 불변).
 *  - 새 판본을 쓰면 같은 요청의 옛 판본 파일은 즉시 지운다.
 *  - 읽을 때 파일 시각을 갱신(touch) — "오래 안 쓴 것" 판정 기준.
 *  - 실행 시작 때 1회 정리: 90일 넘게 안 쓴 파일 삭제, 전체 상한(기본 5GB) 넘으면 오래 안 쓴 것부터 삭제(오너 질문 "용량부족은?").
 * 조회 실패는 캐시하지 않는다(호출부가 오류로 처리 — 종료코드 1).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, utimesSync, rmdirSync } from "node:fs";
import { join } from "node:path";

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);

export function makeDiskCache(root, { maxBytes = 5 * 1024 ** 3, maxIdleDays = 90 } = {}) {
  const st = { hit: 0, miss: 0, write: 0, deletedOld: 0, deletedIdle: 0, deletedCap: 0 };
  const dirOf = (ns, key) => join(root, safe(ns), safe(key));
  function walk(d, out) {
    if (!existsSync(d)) return out;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p, out);
      else out.push({ p, size: s.size, t: s.mtimeMs });
    }
    return out;
  }
  return {
    /** 판본이 같은 파일이 있으면 내용(JSON), 없으면 undefined */
    get(ns, key, ver) {
      const f = join(dirOf(ns, key), `${safe(ver)}.json`);
      if (!existsSync(f)) { st.miss++; return undefined; }
      const now = new Date();
      utimesSync(f, now, now);
      st.hit++;
      return JSON.parse(readFileSync(f, "utf8"));
    },
    put(ns, key, ver, data) {
      const d = dirOf(ns, key);
      mkdirSync(d, { recursive: true });
      const name = `${safe(ver)}.json`;
      for (const n of readdirSync(d)) if (n !== name) { unlinkSync(join(d, n)); st.deletedOld++; }
      writeFileSync(join(d, name), JSON.stringify(data));
      st.write++;
    },
    /** 실행 시작 때 1회 */
    cleanup() {
      const files = walk(root, []);
      const cutoff = Date.now() - maxIdleDays * 864e5;
      let keep = [];
      for (const f of files) {
        if (f.t < cutoff) { unlinkSync(f.p); st.deletedIdle++; } else keep.push(f);
      }
      let total = keep.reduce((a, f) => a + f.size, 0);
      if (total > maxBytes) {
        keep.sort((a, b) => a.t - b.t);
        while (total > maxBytes && keep.length) {
          const f = keep.shift();
          unlinkSync(f.p);
          total -= f.size;
          st.deletedCap++;
        }
      }
      // 빈 요청 폴더 정리
      const prune = (d) => {
        if (!existsSync(d)) return;
        for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { prune(p); if (!readdirSync(p).length) rmdirSync(p); } }
      };
      prune(root);
    },
    summary() {
      const files = walk(root, []);
      const bytes = files.reduce((a, f) => a + f.size, 0);
      return { ...st, files: files.length, bytes };
    },
  };
}
