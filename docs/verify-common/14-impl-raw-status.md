# 설계 ① 원자료 어댑터 — 구현 현황 (2026-10-15, 오너 승인 뒤)

설계: `10-design-raw-adapters.md`(오너 승인 2026-10-15). 코드: `scripts/verify/raw/` (브랜치 verify/common). 이 문서는 구현이 설계와 어디까지 같고 어디가 다른지, 무엇이 남았는지를 적는다.

## 1. 만든 것

| 설계 | 파일 | 내용 |
|---|---|---|
| §3.5 공유 원본 보관소 | `common/store.mjs`·`common/format.mjs` | 판본 추가만·색인 index.jsonl·저장 때 형식 검사(JSON·XML 짝·zip CRC)·읽을 때 sha256·신원 확인·격리(quarantine/)·동시 쓰기 충돌 사고·원천별 5GB 정리(복구 불가 판본 제외, cache-evictions.jsonl) |
| §3.6 요청 한도 | `common/http.mjs`·`common/fetchstore.mjs` | 원천별 간격·재시도·하루 상한(카운터 `<보관소>/quota/<원천>/YYYYMMDD.json`)·옛 사본 대체 없음(D16) |
| 원천 받기 | `us/sec.mjs`·`kr/dart.mjs`·`kr/krx.mjs`·`jp/edinet.mjs`·`common/market-global.mjs` | SEC(UA 필수 D17)·DART(접수번호 판본, 020 전체 중단, 800 점검)·KRX(지난 날짜만 저장, 휴장일 화면)·공공데이터 배당·EDINET(확정일 목록만 저장)·Yahoo(분할·종가 — U7 미결, 「같은 원천」 표시)·FRED H.10 |
| §2 출력 형식 | `common/rawfact.mjs`·`common/xbrl.mjs` | RawFact·Item·빈칸 사유 코드(§3.4)·판정 연결 표·XBRL 공통 판독·정밀도 중복 표시 |
| §4 미국 | `us/read.mjs`·`us/items.mjs`·`us/sixk.mjs`·`us/adapter.mjs` | R-US1(판본·반올림 재태깅 표시)·R-US2(companyfacts 누락 서류 → 인스턴스)·R-US3(본표 구조)·R-US4·R-US5(CapEx 줄)·R-US6(이자)·R-US7(6-K)·R-US8(원통화 그대로)·R-US9(EPS 계속·중단 모두)·R-US10(차원 보존)·R-US11(Yahoo 분할 — common/market-global) |
| §5 한국 | `kr/read.mjs`·`kr/items.mjs`·`kr/interest.mjs`·`kr/doc.mjs`·`kr/da.mjs`·`kr/xbrlfacts.mjs`·`kr/events.mjs`·`kr/market.mjs`·`kr/adapter.mjs` | R-KR1~R-KR11 전부(리스부채 주석 후보 포함) |
| §6 일본 | `jp/read.mjs`·`jp/items.mjs`·`jp/adapter.mjs`·`jp/scan-lists.mjs` | R-JP1~R-JP7·R-JP9~R-JP11, R-JP8 은 본표 줄까지 |
| §3.5 옮기는 순서 1·2 | `import-legacy.mjs` | 앱·검증기 원본 들여오기(2호기 실행: SEC 9,352·DART 1,094·EDINET 383, 거부 0) |
| §7 시험 | `test/*.test.mjs`(27)·`t2-offline.mjs`·`t4-{us,kr,jp}.mjs`·`golden.mjs`+`golden/cases.json` | T1·T2·T3·T4·T5·T6·T7 |

## 2. 설계와 다르게 한 것(이유)

1. **옮기기 = 하드링크**(설계 「rename」). 앱 코드가 아직 옛 폴더 배치를 읽어서, 옮기면 앱 캐시가 깨진다. 같은 디스크라 하드링크도 공간이 더 들지 않는다. 옛 폴더 삭제는 앱이 새 루트로 바뀐 뒤(순서 4) — 앱 브랜치 작업.
2. **형식·신원이 틀린 기존 파일은 격리하지 않고 들여오지만 않았다** — 원래 파일은 앱이 쓰고 있어 옮길 수 없다. 결과 파일에 사유를 남겼다(이번 실행 거부 0).
3. **SEC HTML 은 바이트가 받을 때마다 다르다**(끝의 봇 차단 스크립트 경로). 그 한 줄만 다르면 같은 원본으로 본다(`equivalentFor`, 사고 기록 `equivalent_bytes`).
4. **DART 보고서 응답의 신원**: 판본 = 목록의 최신 접수번호인데, 재무를 다시 싣지 않은 정정이면 행의 접수번호가 원 보고서(더 이른 번호)다 → 「판본 이하」로 확인.
5. **EDINET 목록의 신원** = 응답 `metadata.parameter.date`(ファイル日付 — 그날 정정·취하된 옛 서류도 실려 제출일로 확인하면 틀린다).
6. **신원 표지가 없는 파일**(일반 HTML 첨부, 6-K 본문)은 형태 검사만 — 결과 `got: "no-identity-marker"`.
7. **하루 상한 카운터 위치** = 보관소 안(`quota/`) — 여러 작업트리·실행이 같은 날 합계로 센다. 옛 한국 검증기 카운터(`reports/.dart-quota`)와는 따로다(옛 검증기를 거두면 하나).

## 3. 남은 것

| 항목 | 상태 |
|---|---|
| R-JP8 金融費用 주석 구성요소(본표에 支払利息 줄이 없는 IFRS 회사)·CF 조정만·줄 없음 판정·D28 영업비용 안 금융사업 이자 표시 | 빈칸 `parse_failed`(not_implemented)로 남김 — 검증불가로 셈 |
| R-JP6 본표에 리스 줄이 없는 IFRS 회사의 리스부채(재무활동 부채 변동표 산술 판정) | `lease_on_face=false` 표시만 |
| 일본 배당성향 분자(D21 当事業年度に係る剰余金の配当) | 미구현 |
| U7(D7) 미국·일본 시세·분할 원천 | 측정 뒤 결정 — Yahoo 로 시작, 「같은 원천」 표시 |
| R-KR1 12월이 아닌 결산 회사의 bsns_year 규칙 | 조사 필요(표시 `nonDecFy`) |
| T1 골든셋을 원본 조각으로 git 에 | 지금은 기대값만 git, 원본은 보관소(2호기) |
| 독립 감사 | 다음 |
| 앱 쪽 보관소 전환(C3·C4·C20) | 앱 브랜치별 별도 작업 |
