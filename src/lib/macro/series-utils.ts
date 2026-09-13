import "server-only";

/**
 * Fear & Greed(미국/한국) 산출에 공통으로 쓰는 시계열 유틸.
 * 두 구현이 각자 동일한 함수를 복붙해 두면 한쪽만 결측 대응판으로 고치고
 * 다른 쪽은 안 고치는 drift 가 생기기 쉬워(2026-09, McClellan 결측 전파 버그가
 * 실제로 그렇게 발생) 한 곳으로 모음.
 */

/** 이동평균(단순). i < p-1 이거나 창에 null 있으면 null */
export function smaSeries(arr: (number | null)[], p: number): (number | null)[] {
  return arr.map((_, i) => {
    if (i < p - 1) return null;
    let s = 0;
    for (let k = i - p + 1; k <= i; k++) {
      const v = arr[k];
      if (v == null) return null;
      s += v;
    }
    return s / p;
  });
}

/**
 * smaSeries 를 결측(휴장일 등)에 견고하게 — 값이 있는 날짜만 추려서 이동평균을
 * 계산한 뒤 원래 위치로 되돌린다. 그냥 smaSeries 를 쓰면 창(window) 안에 결측이
 * 하루만 있어도 그 뒤 p거래일 전체가 null 로 전파되는 버그가 있음
 * (모멘텀 125일선·VKOSPI/VIX 50일선에서 실제로 발생했던 문제).
 */
export function smaSeriesSkipNulls(arr: (number | null)[], p: number): (number | null)[] {
  const idx: number[] = [];
  const vals: number[] = [];
  arr.forEach((v, i) => {
    if (v != null) {
      idx.push(i);
      vals.push(v);
    }
  });
  const ma = smaSeries(vals, p);
  const out: (number | null)[] = new Array(arr.length).fill(null);
  idx.forEach((origI, k) => {
    out[origI] = ma[k];
  });
  return out;
}

/**
 * 이동 합계(rolling sum) — 결측(거래 없는 날 등)은 건너뛰고 값 있는 날짜만으로
 * 누적. smaSeriesSkipNulls 와 동일한 결측-견고 패턴.
 */
export function rollingSumSkipNulls(arr: (number | null)[], p: number): (number | null)[] {
  const idx: number[] = [];
  const vals: number[] = [];
  arr.forEach((v, i) => {
    if (v != null) {
      idx.push(i);
      vals.push(v);
    }
  });
  const sums: (number | null)[] = vals.map((_, i) => {
    if (i < p - 1) return null;
    let s = 0;
    for (let k = i - p + 1; k <= i; k++) s += vals[k];
    return s;
  });
  const out: (number | null)[] = new Array(arr.length).fill(null);
  idx.forEach((origI, k) => {
    out[origI] = sums[k];
  });
  return out;
}

/** 지수이동평균 (alpha 지정). null 은 이전값 유지, 시드 전엔 null */
export function emaSeries(arr: (number | null)[], alpha: number): (number | null)[] {
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (const v of arr) {
    if (v == null) {
      out.push(prev);
      continue;
    }
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}
