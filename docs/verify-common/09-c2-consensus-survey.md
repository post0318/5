# C2·Q7 — 화면에 안 나가는 컨센서스 연도별 계산 조사 (2026-10-14, 코드 조사)

오너 보류 항목 C2(화면 미표시 컨센서스 BPS·PER·PBR·ROE·EV/EBITDA 삭제 여부)와 Q7(컨센서스 ROE 정의)을 결정하기 위한 코드 조사.
브랜치 `master`·`kr/app`·`jp/app`·`us/app` 을 `git show`·`git grep` 으로 읽었다(체크아웃·실행 없음). 앱 코드 변경 없음.

## 결론

- **네 브랜치 모두 다섯 값(BPS·PER·PBR·ROE·EV/EBITDA)을 화면에 표시하는 곳이 없다.** 컨센서스 패널은 rows 의 매출·EPS 만 차트로 그리고, 미국은 그 차트도 숨긴다.
- **BPS·ROE 는 읽는 코드가 하나도 없다** → 지워도 깨지는 것 없음. 패널 notes 의 「{연도} BPS: …」 문구만 사라진다. ROE 를 지우면 Q7(기말/평균 통일)은 할 일이 없어진다.
- **PER·PBR·EV/EBITDA 는 검증 스크립트만 읽는다**(`verify-financials.mjs` C층 "컨센서스 = 하이라이트" 대조, `jp-hl-check.mts`, baseline 스냅샷). 화면에 없는 값을 검증하는 것이라 지우면 이 대조도 같이 지운다.
- **지우면 줄어드는 외부 요청**: 한국 KRX 시가총액·연말 종가(재시도 포함)·D&A 조회, 미국 captive·Yahoo forward 등 EV 전용 조회. 일본은 하이라이트와 같은 계산을 공유해 절감 없음.
- **남기면 고칠 것**: 한국 BPS 분모 = 현재 주식수 / PBR 분모 = KRX 연말 시가총액(기준 불일치), ROE 미·한 기말 / 일 평균(Q7), 재무 조회 실패 대체 경로의 부호 규칙 없음·부채총계 EV·40배 필터(옛 방식).

## 필드별 (네 브랜치 공통 식)

| 필드 | 계산 위치(master 기준) | 식 | 읽는 곳 | 화면 |
|---|---|---|---|---|
| bps | `consensus.ts:481` / 일 `jp-ev.ts:569` | 미 기말 지배자본 ÷ 결산일 주식수 · 한 기말 지배자본 ÷ **현재** 주식수 · 일 지배자본 × 주가 ÷ 시총 | 없음(notes 문구만) | X |
| per | `:511` / `jp-ev.ts:565` | 연말가 ÷ EPS, EPS ≤ 0 공란 | verify-financials C층, jp-hl-check, baseline | X |
| pbr | `:512-516` / `jp-ev.ts:571` | 미 가격 ÷ BPS · 한 KRX 연말 보통주 시총 ÷ 지배자본 · 일 시총 ÷ 자본, ≤ 0 공란 | 위와 같음 | X |
| roe | `:517-519` / `jp-ev.ts:582-585` | 미·한 순이익 ÷ **기말** 지배자본 · 일 ÷ **평균** 지배자본 | 없음 | X |
| evEbitda | `:521-549` / `jp-ev.ts:578` | EV ÷ (영업이익 + D&A), EBITDA > 0 | 위와 같음 | X |

jp/app·us/app 은 줄 번호가 약 17줄 앞(예 511 → 494).

## 읽는 곳 전수

- API `src/app/api/markets/[market]/[symbol]/consensus/route.ts:18` — 응답 그대로.
- `src/components/consensus-panel.tsx` — rows 의 label·revenue·eps·isEstimate 만(`:60-65`), 미국은 차트 숨김(`:75`). notes·epsRevision·earningsSurprise 표시.
- `src/components/broker-ratings.tsx:222` — analystRatings 만.
- 유니버스(`src/lib/universe/overview.ts`)·주간 리포트(`src/lib/weekly`)·MCP(`src/app/api/mcp`)·텔레그램 스크립트 — 이 API 를 쓰지 않음.
- 스크립트: `scripts/verify-financials.mjs`(master·kr/app `:5064-5066`·`:10981-10983`, jp/app `:4667`·`:9483`, us/app `:4664-4666`·`:9480-9482`, 각 verification 브랜치와 verify/common 도 같은 대조), `scripts/run/jp-hl-check.mts:66-68`, `scripts/metrics/baseline-snapshot.mjs:138`(응답 전체 저장).

## 지워도 남는 것(C2 대상 아님)

- 패널 표시 `epsRevision.per`·`perNext`(`:632`)와 추정 행 PER = 현재가 ÷ EPS — **부호 규칙 없음**(A8 결함과 같은 건).

## 브랜치 차이

- `kr/app` = `master`. `jp/app`·`us/app` 은 한국 경로가 옛 판(`loadKrCaps`·`getKrDaDoc` 실패를 조용히 넘김, `buildKrEvResolver` 에 daDoc 미전달, KRX 실패 시 현재 주식수 근사 시총으로 EV, 경고 notes 없음). 식(BPS·PER·PBR·ROE)은 같다.
