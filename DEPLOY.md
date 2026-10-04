# 배포

## 0. 서버 구성 (2026-10-03 오너 결정)

Vercel Hobby 가 Active CPU 한도 초과로 정지된 뒤 세 곳에 같은 커밋을 배포한다. 세 곳 모두 같은 MongoDB 를 쓴다.

| 서버 | 역할 | 주소 | 배포 |
|---|---|---|---|
| **오라클** (오사카 ARM A1 2코어·12GB, 161.33.9.115) | **메인** — 화면 + 무거운 자동 작업 | https://macro-insights.duckdns.org | `deploy-oracle.yml`: master 푸시(앱 파일) → 서버가 해당 커밋을 받아 직접 빌드(ARM)·재시작 |
| 구글 Cloud Run (`brave-smile-508510-g5`, asia-northeast1) | 보조 — 화면 | https://macroresearch-2x722d45qa-an.a.run.app | `deploy-cloudrun.yml` |
| Vercel | 보조 — 화면. **Hobby 한도 초과로 정지(402) 중** — 다음 달 사용량 초기화 때 풀림 | https://macroresearch.vercel.app | Git 연동(`vercel.json` ignoreCommand만, crons 는 2026-10-03 제거) |

- **자동 작업이 부르는 주소는 저장소 변수 `APP_URL` 하나**(지금 오라클). 워크플로는 `${{ vars.APP_URL }}`, 수집 스크립트는
  `scripts/lib/app-url.mjs`(`APP_URL` 환경변수, 없으면 오라클 도메인). 메인을 바꿀 때는 이 변수만 고친다.
- 오라클 서버: Docker 컨테이너 `macro`(127.0.0.1:8080, 재시작 자동) 앞에 Caddy(HTTPS 자동 발급). 환경변수는
  `/opt/macro/app.env`(600, 배포 때 GitHub 비밀값으로 다시 씀). 최초 설치 `ops/oracle/setup.sh`, 점검 `ops/oracle/healthcheck.sh`.
  배포 키는 비밀값 `ORACLE_SSH_KEY`, 주소는 변수 `ORACLE_HOST`·`ORACLE_DOMAIN`. 도메인은 DuckDNS(IP 가 바뀌면 duckdns.org 에서 갱신).

### 오라클에서 도는 것 (상세·빈도는 docs/data-collection.md)

| 이름 | 종류 | 시각(KST) | 하는 일 |
|---|---|---|---|
| `macro-kr-fg` | 타이머 | 매일 06:30 | 한국 공포·탐욕 원자료 + 코스피·코스닥 일봉(전 영업일분) |
| `macro-foreign-fut` | 타이머 | 매일 06:31 | 다음 금융 외국인 선물 순매수 |
| `fin-fin-build` | 타이머 | 매일 06:10 | 재무 조립(새 공시·엔진판 변경 종목만) |
| `fin-ttm-build` | 타이머 | 매일 06:50 + 배포 직후 | TTM 스냅샷(무효인 것만) |
| `fin-us-class-facts` | 타이머 | 1·4·7·10월 5일 15:00 | 미국 복수 클래스 주식수 |
| `news-youtube-subscribe` | 타이머 | 매일 05:00 | 유튜브 새 영상 알림 구독 연장 + 최신 10개 동기화 |
| `macro-telegram-listener` | 상주 | 상시 | 텔레그램 채널 새 글 즉시 수신 |
| `research-*`(국내 20) | 타이머 | 08·10·12·14·16·18시(분은 수집기마다 다름) | 국내 증권사 리서치 — 08시만 넓게, 나머지 최근 1일 |
| `research-*`(해외 IB 10) | 타이머 | 매일 08:05~08:52 | 해외 IB·운용사 인사이트 |
| `macro-fedwatch-snapshot` | 타이머 | 매일 06:00 | Fed 금리 확률 일별 스냅샷(Kalshi) |
| `fin-analyst-forecasts` | 타이머 | 매일 10:20 | StockAnalysis 애널리스트 투자의견 |
| `weekly-report` | 타이머 | 월 06:00 | 주간 리포트 초안 |
| `news-stock-news` | 타이머 | 10분마다 | 유니버스 종목뉴스(신선도 지난 종목만) |

- 확인: `ssh -i ~/.ssh/oracle_macro ubuntu@161.33.9.115 'systemctl list-timers --no-pager'`, 로그 `sudo journalctl -u <이름>`.
- 실행기(저장소 `ops/oracle/`, 배포·동기화 때 `/opt/macro/ops/` 로 설치): `call-cron.sh`(앱 `/api/cron/*` 서버 안 호출, POST 가능),
  `run-script.sh`(수집 스크립트 — 작업 폴더 `/opt/macro/jobs`), `run-research.sh`(국내 리서치 회차별 범위), `run-ts.sh`(앱 계산 코드 배치).
  타이머 정의는 `ops/oracle/install-schedules.sh`(다시 돌려도 같은 결과). 수집기·ops 만 바뀐 푸시는 `oracle-sync-jobs.yml` 이 작업 폴더만 맞춘다.
- 사무실 PC 작업 스케줄러 `macro-research-bnk`(BNK — 해외 IP 차단, 한국 IP 필요).

### 과금 통제 (오너 지시 — 크레딧을 넘는 실제 지출 0)

- **오라클**(종량제 계정): 할당량 정책 `free-only`(A1 4코어·24GB·디스크 200GB 외 생성 차단) + 1달러 예산 알림.
  서버 CPU 는 고정 크기라 사용량과 무관하게 0원. 정책 밖 서비스(로드밸런서·오브젝트 스토리지·백업 등)는 만들지 않는다.
  ⚠️ 할당량 이름은 `standard-a1-core-count`·`standard-a1-core-regional-count` 둘 다(메모리도 둘 다) 열어야 A1 을 만들 수 있다.
- **구글**(결제 계정 원화, 월 10달러 크레딧): 예산 `guard-net`(크레딧 차감 후 0원, 알림) · `guard-gemini`(Gemini 총액
  13,000원 **지출 상한**) · `guard-cloudrun`(Cloud Run 총액 1,000원 **지출 상한**). 이미지 저장소는 최근 2개만 보관.
  지출 상한은 크레딧 차감 **전** 총액 기준·서비스 하나당 하나만 가능(구글 제약, 미리보기). Cloud Run 을 0원으로 두면
  무료 범위 안에서도 차단된다(2026-10-03 실측 — 결제 비활성화 500). 앱 내부 Gemini 예산 `WEEKLY_MONTHLY_BUDGET_USD` 기본 10.

---

Vercel CLI는 설치·로그인(post0318) 완료 상태. 아래는 사용자가 직접 실행해야 하는 단계
(자동 승인 정책이 `vercel link` / `vercel deploy` / `git push` 를 막음).

## 1. 데이터베이스 — MongoDB Atlas

유니버스 저장소는 MongoDB `universe_items` 컬렉션.

1. cloud.mongodb.com 에서 무료 M0 클러스터 생성
2. **Network Access** → `0.0.0.0/0` 추가 (Cloud Run·Vercel·GitHub 실행 서버 IP 가 고정이 아님)
3. **Database Access** → 사용자 생성, 접속 문자열 복사
   `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?appName=Cluster0`
4. `MONGODB_URI` 환경변수로 등록 (§3)

인덱스(시장+심볼 유니크)는 앱이 첫 요청 때 자동 생성.

> MongoDB 없이 배포해도 **거시경제·종목분석·지수·F&G 는 정상 동작**.
> `유니버스 관리`·`유니버스 통합 뷰` 두 화면만 DB 필요.

## 2. Vercel 프로젝트 연결

```bash
cd C:/Users/post0/5
vercel link            # 대화형: post0318 스코프 선택, 프로젝트명 입력(예: market-research)
```

## 3. 환경변수 등록

```bash
vercel env add MONGODB_URI production   # mongodb+srv://...
vercel env add DART_API_KEY production           # .env.local 값 그대로
vercel env add EDINET_API_KEY production
vercel env add KRX_API_KEY production
vercel env add JQUANTS_API_KEY production
vercel env add SEC_USER_AGENT production         # "market-research (personal) post0318@gmail.com"
```

Preview 환경에도 필요하면 `production` 대신 `preview` 반복, 또는 `vercel env add <KEY>` (환경 3개 선택).

## 4. 배포

```bash
vercel                 # 프리뷰 배포 (고유 URL)
vercel --prod          # 프로덕션 배포
```

## 4-1. 배포 도메인

- **2026-10-03 부터 메인은 오라클**(§0) — 수집 스크립트 전송 URL 도 `APP_URL`(오라클)로 옮겼다. 아래는 Vercel 기록.
- Vercel 프로덕션은 `https://macroresearch.vercel.app` 이다(2026-09-24). 예전 도메인 `5-topaz-five.vercel.app` 은 더
  이상 프로덕션이 아니며 Vercel 인증(배포 보호)에 막혀 있다 — 그쪽으로 요청하면
  앱에 닿기 전에 401/302(SSO) 가 난다. 로컬 체크아웃이 오래됐거나 `.env.local` 에
  옛 `*_IMPORT_URL` 이 남아 있으면 수집기가 "Protected deployment" 로 실패한다
  (2026-09-24~27 로컬 재실행 도구 실측). 감사 때 이걸 "프로덕션 전체 차단"으로
  오판한 적이 있으니(2026-09-28), 먼저 어느 도메인을 부르는지 확인할 것.

## 5. 확인

```bash
vercel ls
vercel logs <배포URL> --level error --since 1h
```

## 주의

- `.env.local` 은 gitignore·미배포. 키는 위 `vercel env` 로만 주입.
- J-Quants·CNN F&G 는 일부 클라우드 IP를 차단할 수 있음. 배포 후 `/macro`,
  일본 종목 조회로 실제 동작 확인.
- Next.js 16 자동 감지. `vercel.json` 은 `ignoreCommand`(앱 파일이 안 바뀐 푸시는 배포 생략)와 `wip/*` 배포 끔만 둔다(crons 는 2026-10-03 오라클로 이전).

## 6. 텔레그램 수집 (2026-10-03 — 오라클 상주 수신기로 이전)

예전엔 GitHub 예약(실행률 21%)을 보완하려고 cron-job.org 가 2시간마다 `telegram-posts.yml` 을 `workflow_dispatch` 로 다시 띄웠다.
지금은 오라클 `macro-telegram-listener` 가 연결을 유지하며 새 글을 즉시 받는다. **같은 세션을 두 곳에서 동시에 쓰면 끊기므로**:

- cron-job.org 의 텔레그램 재기동 작업은 **끈다**(그때 발급한 GitHub 세분화 토큰도 폐기).
- `telegram-posts.yml` 은 수동 비상용 — 수신기를 멈춘 뒤에만 실행한다(`sudo systemctl stop macro-telegram-listener`).
- 세션(`TELEGRAM_SESSION`)은 오라클 `/opt/macro/jobs.env`(600)에 있다. 세션을 새로 만들면(`scripts/telegram-login.mjs`) 여기와 GitHub 비밀값을 함께 바꾼다.
