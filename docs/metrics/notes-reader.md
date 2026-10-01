# 주석 판독기 (`scripts/reference/notes.mjs`)

외부 소스와의 차이를 분해할 때 "공시 없음"이라고 결론 내리기 전에, 아래 네 층을 **순서대로 모두** 확인하고
무엇을 몇 건 봤는지 기록한다(오너 지시 2026-09-29, "주석 포함해서 쪼개라").

| 층 | 원천 | 함수 |
|---|---|---|
| ① 본표 줄 | 10-K·10-Q 계산 구조(`_cal.xml`)의 손익·현금흐름·재무상태표 역할(Detail·Table·Parenth 제외) | `faceConcepts` |
| ② 상세 사실 | 인스턴스(`*_htm.xml`)의 모든 수치 사실 — 차원(손익계산서 위치·부문·자산 분류 등) 포함 | `instanceFacts` |
| ③ 주석 표 | `…TextBlock` 사실의 HTML 표. 단위("in millions/thousands/billions")를 읽어 환산, `(x)` = 음수, `—` = 0 | `noteTables`, `parseTables` |
| ④ 주석·MD&A 문장 | TextBlock 과 본문 문장의 `$` 금액("was $600 million") | `noteSentences`, `noteMentions` |

## API

```js
import * as N from "./scripts/reference/notes.mjs";
const cik = await N.cikOf("ISRG");
const fs = await N.filings(cik);                 // [{accn, form, filed, report, doc}] 10-K·10-Q·20-F·40-F
const { facts, blocks } = await N.instanceFacts(cik, accn);
const r = await N.findAmount(cik, [accn], 614.7e6, { tolerance: 0, pairs: true, period: { end: "2025-12-31", days: 7 } });
// r.checked = [{layer, filing, n}]  ← 확인한 층·건수(증거로 기록)
// r.hits    = [{layer, filing, where, label, value, period}]
```

- 일치 판정: 각 값의 **자기 표시 반올림**(XBRL decimals, 표 셀 소수 × 단위, 문장의 단위) + `tolerance`.
- `pairs: true` — ②·③에서 두 값의 합·차도 찾는다(표는 같은 표·같은 열 안에서만).
- CLI: `node scripts/reference/notes.mjs <TICKER> <form>:<기말> <금액> [--pairs]` — 결과가 없으면 "네 층 모두 확인 — 일치 없음"과 층별 건수.
- SEC 요청: UA `global-market-research (personal use) contact@example.com`, 초당 2건 이하, 429 면 65초 대기.
  디스크 캐시는 앱과 공유(`.cache/sec-archives` 영구, `.cache/sec-api` 12시간).

## 결과 읽는 법 — 일치 ≠ 설명

금액이 같다는 것은 **후보**일 뿐이다. 특히 `pairs` 는 표 하나에 수십 개 행이 있으면 우연 일치가 많다
(GLW 2024 영업이익 차 191 → 주석 표 두 줄 합 95건). 채택하려면 같은 항목이 **모든 연도**에서 차이와
정확히 맞아야 한다. 예: GLW 엔화 부채 환산이익(`glw:TranslationGainLossOnJapaneseYenDenominatedDebt`)은
2021 차 181 ↔ 180 으로 맞지만 2022(차 400 ↔ 191)·2023(301 ↔ 100)·2024(191 ↔ 104)·2025(45 ↔ −52)는
맞지 않아 설명이 아니다.

## 알려진 한계

- **이미지로만 된 표**(스캔·그림 삽입 표)는 텍스트가 없어 읽지 못한다.
- 본문 HTML 중 TextBlock 으로 태깅되지 않은 부분(MD&A 의 일부 표)은 ④ 문장으로만 잡히고 ③ 표로는 안 잡힌다.
- 문장 분리는 마침표·세미콜론 기준이라 긴 문단은 한 문장으로 붙는다 — 대신 금액 앞뒤 문맥(`ctx`, 앞 220자·뒤 80자)을 보관한다.
- 병합 셀(colspan)·다단 헤더는 열 이름을 첫 헤더 행으로만 붙인다(`[열N]` 은 헤더를 못 찾은 열).
- 20-F·40-F 는 IFRS 개념명 그대로다(us-gaap 매핑 없음).
- `filings()` 는 제출 목록 `recent` 만 본다 — 아주 오래된 10-K 는 없을 수 있다.
