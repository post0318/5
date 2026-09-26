# 독립 기준 (scripts/reference)

미국 종목 손익계산서 숫자의 **독립 기준**. SEC 원문 공시(10-K / 10-Q / 20-F 본문 HTML)에서 사람이 읽는
손익계산서 표를 **인쇄된 그대로** 옮겨 적는다. XBRL facts·companyfacts 는 쓰지 않는다.

추출은 **코드 파서 우선 + LLM 보조**다(오너 결정 2026-09-26, 비용 절감). 결정적 HTML 표 파서가 먼저 읽고,
LLM 은 파서가 못 읽은 공시와 교차 확인 표본에만 부른다. 두 추출기 모두 같은 검증기를 통과해야 저장된다.
앱(`src/lib/**`)과 검증기(`scripts/verify-financials.mjs`)를 나중에 **둘 다** 이 기준과 대조한다.

## 청정실 규칙 (반드시 지킬 것)

1. 이 모듈은 앱·검증기 코드를 **import 하지도, 읽고 베끼지도 않는다**. 둘이 공유하는 맹점을 물려받지 않기 위해서다.
   (앱의 Gemini 클라이언트 `src/lib/weekly/gemini.ts` 도 쓰지 않고 `adapters/gemini.mjs` 를 따로 둔다.)
2. `data/us/*.json` 은 **앱 결과에 맞추려고 고치지 않는다**. 바꾸는 방법은 재추출뿐이다. 재추출 결과에는
   인용(공시번호·문서 URL·표 제목·행·열)과 모델·지시문 해시가 함께 남는다.
3. 개념 매핑("매출", "매출원가")·계산·재분류를 하지 않는다. 행 제목은 표에 인쇄된 글자 그대로다.
   어떤 행이 "매출"인지 정하는 건 이 기준을 소비하는 쪽의 일이다.
4. 같은 (공시번호, 행, 열)에 다른 값이 나오면 **덮어쓰지 않고 둘 다 남겨** `conflict: true` 와 `conflicts[]` 로 표시한다.
5. MongoDB 에 쓰지 않는다. 개발 서버에 의존하지 않는다.

## 구조

```
scripts/reference/
 ├─ extract.mjs          CLI — 원문 조회 → 표 위치 → 파서(→ 필요 시 LLM) → 검증 → 저장
 ├─ lib/
 │   ├─ sec.mjs          SEC 조회(초당 1회 이하, SEC_USER_AGENT, 429 → 65초 대기) + .cache 저장
 │   ├─ locate.mjs       원문 HTML 에서 손익계산서 표 창(window) 자르기(거친 휴리스틱)
 │   ├─ parse.mjs        결정적 HTML 표 파서(모델 없음) — LLM 과 같은 출력 형식
 │   ├─ prompt.mjs       공통 지시문·출력 스키마·지시문 해시(PROMPT_HASH)
 │   ├─ validate.mjs     결정적 검증기(스키마, 원문 숫자 존재, 부호, 배수, 열 제목 → 기간)
 │   └─ store.mjs        data/us/{SYM}.json 병합(충돌 보존)
 ├─ adapters/            모델마다 파일 하나 — 모델별 특이점은 여기 안에만
 │   ├─ types.mjs        인터페이스(JSDoc)
 │   ├─ gemini.mjs       Gemini REST(구조화 출력, temperature 0)
 │   └─ openai.mjs       스텁(아직 호출 없음)
 ├─ data/us/{SYM}.json   결과(git 추적)
 └─ .cache/              SEC 원문·모델 원응답(gitignore)
```

`.mjs` 로 쓴 이유: 저장소 `tsconfig.json` 이 `**/*.ts` 를 포함해 `.ts` 확장자 import 를 쓰면
`npm run build`/`typecheck` 가 깨진다. Node 24 로 바로 실행된다.

## 실행

```bash
node scripts/reference/extract.mjs --symbols=AAPL,MRVL            # 최신 10-K(또는 20-F) 1개 + 최신 10-Q 4개
node scripts/reference/extract.mjs --symbols=AAPL --10q=1         # 10-Q 1개만
node scripts/reference/extract.mjs --symbols=MRVL --include=0001835632-22-000016   # 특정 공시 추가
node scripts/reference/extract.mjs --symbols=AAPL --dry           # 표 위치·파서 결과만(저장·모델 호출 없음, 비용 0)
node scripts/reference/extract.mjs --symbols=AAPL --force         # 이미 뽑은 공시도 재추출(다르면 충돌로 남음)
node scripts/reference/extract.mjs --symbols=AAPL --llm=never     # 파서만(비용 0)
node scripts/reference/extract.mjs --symbols=AAPL --llm=always    # 모든 공시를 LLM 으로도 교차 확인
node scripts/reference/extract.mjs --symbols=AAPL --offline       # SEC 요청 없이 .cache 만 사용
```

환경변수(`.env.local` 에서 자동으로 읽음): `SEC_USER_AGENT`, `GEMINI_API_KEY`,
`REF_GEMINI_MODEL`(기본 `gemini-3.8-flash`), `REF_BUDGET_USD`(실행당 상한, 기본 1.0),
`REF_LLM_SAMPLE`(교차 확인 표본 간격, 기본 10 = 약 10건 중 1건, 0 = 표본 없음).

같은 공시를 같은 추출기·같은 해시(파서는 `parse.mjs` 소스 해시, LLM 은 지시문·스키마 해시)로 이미 뽑았으면
건너뛴다(비용 0). 파서나 지시문을 고치면 해시가 바뀌어 다시 뽑히고, 결과가 다르면 충돌로 드러난다.

## 추출 흐름 — 파서 우선, LLM 보조

1. **결정적 파서**(`lib/parse.mjs`, 비용 0): `locate` 가 자른 표를 colspan 기준 격자로 놓고 읽는다.
   - 열 머리글: 첫 데이터 행 위 머리글 행들. 맨 아래 머리글 행의 칸이 열 구간을 정하고, 위 행의 겹치는 칸 글자를
     위→아래로 잇는다("Three Months Ended" + "June 27, 2026").
   - 숫자: 열 구간 안 칸 글자를 이어 읽는다 — 따로 떨어진 `# 독립 기준 (scripts/reference)

미국 종목 손익계산서 숫자의 **독립 기준**. SEC 원문 공시(10-K / 10-Q / 20-F 본문 HTML)에서 사람이 읽는
손익계산서 표를 **인쇄된 그대로** 옮겨 적는다. XBRL facts·companyfacts 는 쓰지 않는다.

추출은 **코드 파서 우선 + LLM 보조**다(오너 결정 2026-09-26, 비용 절감). 결정적 HTML 표 파서가 먼저 읽고,
LLM 은 파서가 못 읽은 공시와 교차 확인 표본에만 부른다. 두 추출기 모두 같은 검증기를 통과해야 저장된다.
앱(`src/lib/**`)과 검증기(`scripts/verify-financials.mjs`)를 나중에 **둘 다** 이 기준과 대조한다.

## 청정실 규칙 (반드시 지킬 것)

1. 이 모듈은 앱·검증기 코드를 **import 하지도, 읽고 베끼지도 않는다**. 둘이 공유하는 맹점을 물려받지 않기 위해서다.
   (앱의 Gemini 클라이언트 `src/lib/weekly/gemini.ts` 도 쓰지 않고 `adapters/gemini.mjs` 를 따로 둔다.)
2. `data/us/*.json` 은 **앱 결과에 맞추려고 고치지 않는다**. 바꾸는 방법은 재추출뿐이다. 재추출 결과에는
   인용(공시번호·문서 URL·표 제목·행·열)과 모델·지시문 해시가 함께 남는다.
3. 개념 매핑("매출", "매출원가")·계산·재분류를 하지 않는다. 행 제목은 표에 인쇄된 글자 그대로다.
   어떤 행이 "매출"인지 정하는 건 이 기준을 소비하는 쪽의 일이다.
4. 같은 (공시번호, 행, 열)에 다른 값이 나오면 **덮어쓰지 않고 둘 다 남겨** `conflict: true` 와 `conflicts[]` 로 표시한다.
5. MongoDB 에 쓰지 않는다. 개발 서버에 의존하지 않는다.

## 구조

```
scripts/reference/
 ├─ extract.mjs          CLI — 원문 조회 → 표 위치 → 파서(→ 필요 시 LLM) → 검증 → 저장
 ├─ lib/
 │   ├─ sec.mjs          SEC 조회(초당 1회 이하, SEC_USER_AGENT, 429 → 65초 대기) + .cache 저장
 │   ├─ locate.mjs       원문 HTML 에서 손익계산서 표 창(window) 자르기(거친 휴리스틱)
 │   ├─ parse.mjs        결정적 HTML 표 파서(모델 없음) — LLM 과 같은 출력 형식
 │   ├─ prompt.mjs       공통 지시문·출력 스키마·지시문 해시(PROMPT_HASH)
 │   ├─ validate.mjs     결정적 검증기(스키마, 원문 숫자 존재, 부호, 배수, 열 제목 → 기간)
 │   └─ store.mjs        data/us/{SYM}.json 병합(충돌 보존)
 ├─ adapters/            모델마다 파일 하나 — 모델별 특이점은 여기 안에만
 │   ├─ types.mjs        인터페이스(JSDoc)
 │   ├─ gemini.mjs       Gemini REST(구조화 출력, temperature 0)
 │   └─ openai.mjs       스텁(아직 호출 없음)
 ├─ data/us/{SYM}.json   결과(git 추적)
 └─ .cache/              SEC 원문·모델 원응답(gitignore)
```

`.mjs` 로 쓴 이유: 저장소 `tsconfig.json` 이 `**/*.ts` 를 포함해 `.ts` 확장자 import 를 쓰면
`npm run build`/`typecheck` 가 깨진다. Node 24 로 바로 실행된다.

## 실행

```bash
node scripts/reference/extract.mjs --symbols=AAPL,MRVL            # 최신 10-K(또는 20-F) 1개 + 최신 10-Q 4개
node scripts/reference/extract.mjs --symbols=AAPL --10q=1         # 10-Q 1개만
node scripts/reference/extract.mjs --symbols=MRVL --include=0001835632-22-000016   # 특정 공시 추가
node scripts/reference/extract.mjs --symbols=AAPL --dry           # 표 위치·파서 결과만(저장·모델 호출 없음, 비용 0)
node scripts/reference/extract.mjs --symbols=AAPL --force         # 이미 뽑은 공시도 재추출(다르면 충돌로 남음)
node scripts/reference/extract.mjs --symbols=AAPL --llm=never     # 파서만(비용 0)
node scripts/reference/extract.mjs --symbols=AAPL --llm=always    # 모든 공시를 LLM 으로도 교차 확인
node scripts/reference/extract.mjs --symbols=AAPL --offline       # SEC 요청 없이 .cache 만 사용
```

환경변수(`.env.local` 에서 자동으로 읽음): `SEC_USER_AGENT`, `GEMINI_API_KEY`,
·`(`·`)`·`%` 칸, 각주 표시("(1)", "*"), 대시(값 없음).
   - 행 제목: 첫 칸(줄바꿈은 공백). 숫자 없는 행이 ":" 로 끝나지 않고 다음 행이 소문자로 시작하면 줄바꿈된 제목으로 잇는다.
   - 구역 제목: 숫자 없는 제목 행. "Total …" 행에서 끝나고, 빈 행은 뒤에 "Total …" 이 이어지지 않으면 구역을 끝낸다.
   - 단위: 창의 "(In thousands/millions/billions …)" 문구. 주당 금액 1, 주식 수는 문구에 주식 수 배수가 따로 있으면 그것.
   - 조금이라도 확신이 없으면(열 구간 밖 숫자 등) 실패로 돌려 LLM 에 넘긴다.
2. **LLM**(`--adapter`, 기본 gemini)은 다음 경우에만 부른다(`--llm=auto`, 기본):
   - (a) 파서가 표를 못 읽었거나, 검증에서 칸이 하나라도 거부됐거나, 열 기간을 못 읽은 공시
   - (b) 교차 확인 표본 — `sha256(공시번호)` 앞 8자리 % `REF_LLM_SAMPLE` == 0 (결정적: 같은 공시는 늘 같은 판정, 실측 비율 10.2%)
3. 파서·LLM 값이 같으면 먼저 저장된 값의 `confirmedBy` 에 다른 추출 id 가 붙는다. 다르면 **둘 다 저장하고 conflict**
   (한쪽을 조용히 채택하지 않는다). 한쪽에만 있는 칸은 그대로 추가된다(예: 다른 쪽이 검증에서 거부된 칸).
4. 값마다 `by` 에 추출기("parser" / "gemini")가 남는다.

### 파서 시험 — 기존 Gemini 추출과 전 칸 대조 (2026-09-26, SEC 요청 없이 캐시만)

| 공시 | 파서 통과 | Gemini 저장 | 일치(재확인) | 충돌 | 파서만 |
|---|---|---|---|---|---|
| AAPL 10-K 0000320193-25-000079 | 57 | 57 | 57 | 0 | 0 |
| AAPL 10-Q 0000320193-26-000020 | 76 | 76 | 76 | 0 | 0 |
| MRVL 10-K 0001835632-26-000011 | 54 | 54 | 54 | 0 | 0 |
| MRVL 10-Q 0001835632-26-000025 | 72 | 71 | 71 | 0 | 1 |
| MRVL 10-K 0001835632-22-000016 | 63 | 63 | 63 | 0 | 0 |

키(구역·행 제목·열 제목)·`printed`·부호·`value`·`scale`·`unit` 이 321칸 전부 같았고 소계 표시도 같았다.
"파서만" 1칸은 MRVL 10-Q "Total operating expenses / Six Months Ended August 1, 2026" = "1,917.3" — Gemini 가
number 를 1 로 잘못 내 검증에서 거부됐던 칸이다(원문 확인: 1,917.3).

여러 종목은 **순차 실행**한다(SEC 초당 1회 제한). SEC 원문은 한 번 받으면 캐시에서 다시 쓴다.

## 검증(결정적 코드, 모델 판단 아님)

| 검사 | 실패 시 |
|---|---|
| 응답이 스키마와 일치 | 그 추출 전체를 저장 안 함(`status: "schema_error"`) |
| 인쇄된 숫자 문자열이 원문 창 평문에 독립 토큰으로 있음(환각 차단) | 그 칸 거부 |
| `negative` 가 원문 괄호·마이너스 출현과 맞음 | 그 칸 거부 |
| `number` 가 `printed` 를 그대로 옮긴 값 | 그 칸 거부(실측: MRVL 10-Q 한 칸에서 1917.3 → 1 을 잡아냄) |
| 금액 칸 `scale` = 단위 문구("In thousands/millions/billions")에서 직접 읽은 배수, 주당 금액은 1 | 그 칸 거부 |
| 열 제목 → 기간 말일·기간 길이 파싱, 날짜가 원문 창에 있음 | 경고 |
| 표 제목·단위 문구·행 제목이 원문 창에 있음 | 경고 |

거부된 칸은 `extractions[id].rejected` 에 사유와 함께 남는다(값 목록에는 안 들어감).

## 저장 형식 (`data/us/{SYM}.json`)

형식 2(`"format": 2`, 압축). 공시(추출)별 메타는 `extractions` 에 **한 번만** 두고 값은 그 id 를 참조한다.

- `extractions{id}` — 추출 1회당 1건: 공시번호·양식·제출일·기준일·**문서 URL·표 제목·단위 문구·어댑터·모델·버전·
  시각·지시문 버전/해시**·토큰/비용·검증 결과(`validation.columns` = 열 제목별 번호·기간 말일·기간 길이)·거부 칸.
  id = `공시번호@어댑터@추출시각`.
- `values[]` — 칸 하나당 한 줄:

  | 필드 | 뜻 |
  |---|---|
  | `x` | extractionId — `extractions[x]` 에서 인용(공시번호·URL·표 제목·단위 문구)과 추출 정보(모델·버전·시각·해시)를 찾는다 |
  | `by` | 이 값을 처음 저장한 추출기 — `"parser"` 또는 `"gemini"` 등 어댑터 이름 |
  | `row` | 표 안 행 순서(0부터) |
  | `sec` | 구역 제목(예: "Earnings per share:"), 없으면 생략 |
  | `label` | 행 제목(인쇄 그대로) |
  | `occ` | 같은 구역·행 제목이 표에 두 번 이상이면 몇 번째(2부터), 아니면 생략 |
  | `col` | 열 제목(인쇄 그대로) — 기간은 `extractions[x].validation.columns` 에서 |
  | `printed` | 인쇄된 숫자 문자열(괄호·`$` 제외), 대시면 대시 그대로 |
  | `neg` | 괄호·마이너스 음수일 때만 `true` |
  | `value` | 배수 적용 값 — 금액은 달러 정수, 주식 수는 정수, 주당 금액은 정밀도 보존용 소수 문자열, 대시는 `null` |
  | `scale` / `unit` | 배수 / `currency`·`per_share`·`shares`·`percent`·`other` |
  | `sub` | 소계 행일 때만 `true`(모델은 괘선, 파서는 제목 글자로 판단 — 키·값 비교에는 안 쓰임) |
  | `confirmedBy` | 같은 값을 다시 확인한 추출 id 목록(있을 때만) — id 에 추출기 이름이 들어 있다(`…@parser@…`) |
  | `conflict` | 같은 키에 다른 값이 있을 때만 `true` |

  키(충돌 판정) = `공시번호|구역|행 제목(#occ)|열 제목`. 소비하는 쪽은 `lib/store.mjs` 의 `expandValue(store, v)` 로
  인용·기간이 붙은 전체 레코드를 얻는다(`keyOf` 로 키).
- `conflicts[]` — 같은 키에 다른 값이 나온 경우 `{ key, extractionIds[] }`.

형식 1(값마다 URL·표 제목·모델 등을 반복)에서 2 로 옮길 때 재추출 없이 변환했고, 옛 레코드의 모든 필드가
`expandValue` 로 그대로 복원되는지 대조해 불일치 0 을 확인했다(2026-09-26, AAPL 133값 133,563→34,923바이트,
MRVL 188값 180,326→49,268바이트).

## 어댑터 추가 (예: openai)

1. `adapters/openai.mjs` 스텁을 구현한다. 인터페이스(`adapters/types.mjs`):
   `extract({ html, instructions, schema }) → Promise<{ json, model, version, usage: { inputTokens, outputTokens, costUsd } }>`
   와 호출 전 예산 검사용 `estimateCostUsd(input)`.
2. 공통 스키마는 표준 JSON Schema 부분집합(`type`·`properties`·`required`·`items`·`enum`, `type: ["number","null"]`)이다.
   모델 방언(OpenAI strict 모드는 모든 속성 required + `additionalProperties:false` 등)은 어댑터 안에서 변환한다.
3. 단가·폴백·재시도도 어댑터 안에. 공통 파이프라인(`extract.mjs`)은 건드리지 않고 `ADAPTERS` 표에 이름만 있으면 된다.
4. `--adapter=openai` 로 실행하면 같은 공시에 대해 두 모델 결과가 나란히 쌓이고, 값이 다르면 충돌로 드러난다
   (모델 간 교차 확인).

## 비용

Gemini 3.x Flash 프로모션 단가(2026-12-31 까지): 입력 $0.75 / 출력 $3.75 (1M 토큰당, thinking 토큰은 출력으로 과금).
2027-01-01 부터 두 배($1.50 / $7.50) — `adapters/gemini.mjs` 의 `PRICE_IN`/`PRICE_OUT` 을 그때 고친다.

실측(2026-09-26, gemini-3.8-flash): 표 창 4.5~5.8KB → 입력 약 2.4~2.9천 토큰, 출력 6.8~10.8천 토큰,
**LLM 호출당 $0.027~0.043(평균 $0.034)**. 비용 대부분이 출력(칸마다 JSON)이다. 파서는 0.
`REF_BUDGET_USD` 를 넘길 것으로 추정되면 호출 전에 멈춘다.

추정표 — 공시당 LLM 비용 $0.034, 종목당 공시 5건(10-K 1 + 10-Q 4), 파서 실패율 f:

| 방식 | 공시당 LLM 호출 비율 | 100종목(500공시) | 500종목(2,500공시) |
|---|---|---|---|
| LLM 전용(종전) | 100% | $17.0 | $85.0 |
| 파서 + 실패 시만 LLM(`REF_LLM_SAMPLE=0`), f=10% | 10% | $1.7 | $8.5 |
| 파서 + 표본 10% + 실패 시(기본), f=0% | 10% | $1.7 | $8.5 |
| 파서 + 표본 10% + 실패 시(기본), f=10% | 19% | $3.2 | $16.2 |
| 파서 + 표본 10% + 실패 시(기본), f=20% | 28% | $4.8 | $23.8 |
| 파서 전용(`--llm=never`) | 0% | $0 | $0 |

기본 모드의 호출 비율 = 표본 10% + 표본 밖 공시 중 파서 실패(0.9 × f). AAPL·MRVL 5건 실측 f = 0%
(20-F·Exhibit 13 형 공시·특이한 표 모양에서는 더 높을 수 있다 — 전체 샘플에서 확인 필요).
