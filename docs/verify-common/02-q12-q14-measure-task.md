# Q12·Q14 실측 작업 지시 — 2호기 (2026-10-13)

지표 사전(`01-metric-dictionary-draft.md`) 결정 중 **Q12(CapEx 범위)·Q14(한국 추정치 원천)** 는 오너가 "실측·실제 비교 후 다시 정리"로
보류했다. 클라우드 세션은 SEC·Yahoo·StockAnalysis·DART·네이버 접속이 막혀 있어 이 실측을 2호기에서 한다.
**앱 코드는 고치지 않는다** — 측정·보고만. 결과를 보고 오너가 Q12·Q14 를 정한다.

## 지켜야 할 것 (CLAUDE.md 작업 규칙)

- 시작 전 `free -m` 2GB 이상, 검증기·빌드·스크립트는 `flock /tmp/macro-verify.lock` 으로 한 번에 하나, 앱 서버는 verify-dev 하나.
- **운영 DB 에 쓰지 않는다**(2호기 로컬 MongoDB·디스크만). 돈이 드는 호출 없음.
- 외부 조회는 한 번만: 받은 원자료는 디스크(`reports/q12-q14/raw/`)에 두고, 두 번째 실행 때 외부 요청 수를 재서 보고(0 에 가까워야 함).
  DART 는 검증 전용 키·하루 상한(`scripts/lib/dart-quota.mjs`)·`--concurrency=1`·요청 간격 300ms. SEC 는 기존 캐시 폴더 재사용.
- 정확 일치로 비교(허용치 없음). 정의가 다른 값으로 빈칸을 채우지 않는다. 확인 못 한 것은 "못 봄 + 사유".
- 보고는 확인한 사실로만: 검사 범위·발견·못 본 범위를 함께. 결과 파일이 생기면 바로 읽고 보고.

## Q12 — 자본지출(CapEx) 범위: 유형만 vs 유형 + 무형

이미 확인(10-13, 클라우드): `PaymentsToAcquireProductiveAssets` SEC 설명문 = "purchases of and capital improvements on property, plant and
equipment (capital expenditures), software, and other intangible assets"(ASC 230). 코드 현황 — 한국 `유형자산의 취득` 한 줄
(`dart-analysis.ts`·`dart-highlights.ts`), 일본 `有形固定資産の取得`(`jp-ev.ts`), 미국 현금흐름표 화면 「유형자산 취득」 줄 → 없으면 태그 목록.
미국 목록이 하이라이트(`edgar-highlights.ts` CAPEX_CONCEPTS)와 재무분석(`edgar-analysis.ts` CAPEX_C)에서 다르다(OtherProductiveAssets 유무).

1. **정의 원문**: us-gaap 분류체계 문서에서 `PaymentsToAcquireProductiveAssets`·`PaymentsToAcquireOtherProductiveAssets`·
   `PaymentsForCapitalImprovements`·`PaymentsToAcquirePropertyPlantAndEquipment`·`PaymentsToAcquireIntangibleAssets`·
   `PaymentsToDevelopSoftware`·`PaymentsForSoftware` 의 설명문(documentation)을 그대로 옮긴다(출처 URL·판 연도).
2. **미국 유니버스**(verify-dev `/api/cron/universe-symbols`, 미국 47종목 내외): 종목마다 FY2021~FY2025·LTM 에
   - 위 태그 각각의 존재 여부·값(companyfacts, 그 해를 담은 최신 10-K),
   - 현금흐름표 본표 계산 구조(`_cal.xml`)상 투자활동의 유형·무형·소프트웨어 취득 줄,
   - 앱 화면 값(하이라이트 CapEx·재무분석 자본지출 — verify-dev API) 과 "유형만" 값의 차이.
   집계: `ProductiveAssets` 만 쓰는 종목 수, 무형·소프트웨어가 따로 있는 종목 수와 CapEx 대비 비중, 하이라이트·재무분석 값이 갈리는 종목.
3. **한국 유니버스 30종목**: DART 연결 현금흐름표 `유형자산의 취득`·`무형자산의 취득`(ID·계정명 그대로) FY2021~FY2025·LTM, 무형/유형 비율.
   비율이 큰 종목(예: NAVER·카카오 류) 목록.
4. **사이트 관행**(대표 종목만 — 미국 3: `ProductiveAssets` 사용 1·소프트웨어 자산화 큰 1·일반 1 / 한국 3: NAVER·카카오·삼성전자):
   Yahoo(capitalExpenditure)·StockAnalysis(검증 전용 허용)·인포맥스(있으면)·FnGuide(한국, 검증용 조회 허용) 의 CapEx 를 같은 기간으로 받아
   "유형만"·"유형 + 무형" 중 어느 쪽과 **정확히** 같은지 표로. 어느 쪽과도 안 맞으면 차이 금액과 추정 원인(숫자로 성립할 때만).

## Q14 — 한국 추정치 원천: 네이버(FnGuide) vs Yahoo

코드 현황(kr/app): 하이라이트 예상 열·유니버스 = 네이버(`fetchKrNaverConsensus`, `m.stock.naver.com/api/stock/{코드}/...`),
컨센서스 화면 = Yahoo(`consensus.ts` estimates — earningsTrend 0y/+1y, targetMeanPrice), 네이버 목표주가 평균은 받고 안 씀.
`naver.ts` 주석에 "야후가 한국 종목에서 스케일 오류를 내는 항목(FnGuide 컨센서스 EPS/PER)" 이력이 있다. 네이버는 FY1 만 준다(Q6 확인).

한국 유니버스 30종목마다 두 원천을 **같은 회계연도**로 맞춰 나란히:
- 추정 매출·영업이익·EPS(FY1, Yahoo 는 FY2 도), 목표주가 평균, 투자의견, 추정 기관 수, 기준일(갱신 시각).
- 차이: 정확 일치 / 단위·스케일 차이(배수가 10^k 로 정확히 성립) / 기간 어긋남(Yahoo 0y 가 이미 다음 해로 넘어간 경우 등) / 값 차이(크기).
- 값이 없는 칸은 원천별로 "없음 + 응답 원문 근거".
- 가능하면 FnGuide 컨센서스 화면(검증용 조회 허용)과도 대조 — 네이버가 FnGuide 를 그대로 싣는지.

## 결과물

- `docs/verify-common/03-q12-q14-measure.md`: 위 표·집계·사이트 대조 결론, 검사 범위·못 본 범위, 두 번째 실행 외부 요청 수.
- 원자료·중간 결과: `reports/q12-q14/`(커밋하지 않는다).
- 커밋은 `verify/common` 에 문서만. 오너에게 Q12·Q14 선택지를 다시 올릴 때 이 결과를 근거로 쓴다.
