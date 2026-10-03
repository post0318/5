# 배포

## 0. 서버 구성 (2026-10-03 오너 결정)

Vercel Hobby 가 Active CPU 한도 초과로 정지된 뒤 세 곳에 같은 커밋을 배포한다. 세 곳 모두 같은 MongoDB 를 쓴다.

| 서버 | 역할 | 주소 | 배포 |
|---|---|---|---|
| **오라클** (오사카 ARM A1 2코어·12GB, 161.33.9.115) | **메인** — 화면 + 무거운 자동 작업 | https://macro-insights.duckdns.org | `deploy-oracle.yml`: master 푸시(앱 파일) → 서버가 해당 커밋을 받아 직접 빌드(ARM)·재시작 |
| 구글 Cloud Run (`brave-smile-508510-g5`, asia-northeast1) | 보조 — 화면 | https://macroresearch-2x722d45qa-an.a.run.app | `deploy-cloudrun.yml` |
| Vercel | 보조 — 화면 | https://macroresearch.vercel.app | Git 연동(`vercel.json` ignoreCommand) |

- **자동 작업이 부르는 주소는 저장소 변수 `APP_URL` 하나**(지금 오라클). 워크플로는 `${{ vars.APP_URL }}`, 수집 스크립트는
  `scripts/lib/app-url.mjs`(`APP_URL` 환경변수, 없으면 오라클 도메인). 메인을 바꿀 때는 이 변수만 고친다.
- 오라클 서버: Docker 컨테이너 `macro`(127.0.0.1:8080, 재시작 자동) 앞에 Caddy(HTTPS 자동 발급). 환경변수는
  `/opt/macro/app.env`(600, 배포 때 GitHub 비밀값으로 다시 씀). 최초 설치 `ops/oracle/setup.sh`, 점검 `ops/oracle/healthcheck.sh`.
  배포 키는 비밀값 `ORACLE_SSH_KEY`, 주소는 변수 `ORACLE_HOST`·`ORACLE_DOMAIN`. 도메인은 DuckDNS(IP 가 바뀌면 duckdns.org 에서 갱신).

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
2. **Network Access** → `0.0.0.0/0` 추가 (Vercel IP는 동적)
3. **Database Access** → 사용자 생성, 접속 문자열 복사
   `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?appName=Cluster0`
4. `MONGODB_URI` 환경변수로 등록 (§3)

인덱스(시장+심볼 유니크)는 앱이 첫 요청 때 자동 생성.

> MongoDB 없이 배포해도 **거시경제·종목분석·지수·F&G 는 정상 동작**.
> `유니버스 관리`·`유니버스 통합 뷰` 두 화면만 DB 필요.

## 2. Vercel 프로젝트 연결

```bash
cd C:/Users/infomax/5
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
- Next.js 16 자동 감지 — `vercel.json` 불필요.

## 6. 텔레그램 수집 트리거 (외부 크론)

텔레그램 게시물 수집만 다른 수집기와 트리거 방식이 다르다. GitHub 의
`schedule` 이벤트는 이 저장소에서 실행률이 21%(20시간 동안 기대 29회 중
6회, 2026-09 실측)에 그친다. 분 값을 정각에서 비껴도 개선되지 않았다 —
지연이 아니라 예약 자체가 누락된다. 다른 수집기(하루 1회)는 몇 시간 지연이
무의미해 그대로 `schedule` 을 쓰지만, 이 채널만 분 단위 신선도가 의미 있다.

그래서 **두 겹으로 막는다**.

1. 워크플로가 한 번 뜨면 그 안에서 **5시간 30분 동안 15분 간격으로 반복
   수집**한다(`.github/workflows/telegram-posts.yml` 의 collect 스텝).
   한 번만 떠도 그 시간만큼 신선도가 유지된다.
2. **외부 크론이 2시간마다 `workflow_dispatch` 를 호출**해 그 루프를 다시
   띄운다. `workflow_dispatch` 는 즉시 실행된다(실측).

2번이 필요한 이유는 1번만으로는 구멍이 나기 때문이다 — 실측(2026-09-16~17,
30시간)에서 `schedule` 실행 간격에 7시간 5분·5시간 34분짜리 공백이 있었고,
둘 다 루프가 버티는 5시간 30분을 넘는다.

**크론 간격을 15분처럼 짧게 두면 안 된다.** 워크플로에 `cancel-in-progress:
true` 가 걸려 있어 새 실행이 돌던 루프를 끊는다. 짧게 부르면 루프가 매번
끊기고 준비 작업(checkout·npm ci)만 반복하며 실행 이력이 취소로 찬다.

### 6-1. GitHub 세분화 토큰 발급

github.com/settings/personal-access-tokens 에서 Fine-grained token 생성.

- Repository access: **Only select repositories → `post0318/5`**
- Permissions: **Actions → Read and write** 하나만. 다른 권한은 주지 않는다.
- 만료일은 1년 등으로 두고 달력에 갱신일을 적어둔다(만료되면 조용히 멈춘다).

이 권한만으로는 워크플로 파일을 수정하거나 Secrets 를 읽을 수 없다. 최악의
경우에도 이 저장소의 워크플로를 실행·취소하는 것까지만 가능하다.

### 6-2. 외부 크론 등록

cron-job.org (무료, 1분 단위) 기준.

- URL: `https://api.github.com/repos/post0318/5/actions/workflows/telegram-posts.yml/dispatches`
- Method: **POST**
- Body: `{"ref":"master"}`
- Schedule: **2시간마다**(위 설명 참고 — 더 짧게 두면 루프가 끊긴다)
- Headers — **이름과 값을 별도 칸에 나눠 넣는다**. 이름 칸에 콜론을 넣거나
  `Authorization: Bearer ...` 를 한 줄로 붙여 넣으면 헤더가 저장되지 않는다.

| 이름                   | 값                            |
| ---------------------- | ----------------------------- |
| `Authorization`        | `Bearer ` + 토큰 (한 칸 띄움) |
| `Accept`               | `application/vnd.github+json` |
| `X-GitHub-Api-Version` | `2022-11-28`                  |
| `Content-Type`         | `application/json`            |

성공 시 응답은 **204 No Content** 이고 본문이 없다. cron-job.org 가 빈 응답을
실패로 표시하면 "성공으로 볼 상태코드"에 204 를 넣는다.

**401 이 나올 때**(실측으로 두 번 겪음, 2026-09-17):

- 값 칸에서 `Bearer ` 를 빠뜨리고 토큰만 넣은 경우. 가장 흔하다.
- 헤더 행 자체가 저장되지 않은 경우. cron-job.org 는 자기 문구로
  "Unauthorized: the endpoint requires authentication..." 를 보여주는데,
  이는 GitHub 의 401 본문("Bad credentials")이 아니라 **헤더가 아예 안 실렸다**는
  신호다.

토큰 자체가 멀쩡한지 가르려면 `gh` 가 아니라(그건 자기 로그인을 쓴다) 발급한
토큰으로 직접 호출해 본다. **명령에 토큰을 그대로 넣으면 터미널 기록에 남으니
확인 후 폐기·재발급할 것**(실측으로 한 번 노출됨).

### 6-3. 주의

- 워크플로에 `concurrency` 가 걸려 있어 외부 크론과 백업 스케줄이 겹쳐도
  동시에 두 번 돌지 않는다.
- 토큰을 외부 사이트에 두는 것이 꺼려지면, Vercel 라우트를 하나 두고 토큰은
  Vercel 환경변수에 보관한 뒤 외부 크론은 그 라우트만 호출하게 바꿀 수 있다.
  외부에 나가는 비밀이 GitHub 토큰에서 이 프로젝트 전용 값으로 바뀐다.
- 텔레그램 쪽 호출량은 채널당 하루 100회 미만이라 제한에 걸릴 수준이 아니다.
  실제 위험은 빈도가 아니라 개인 계정 세션을 데이터센터 IP 에서 쓰는 것이고,
  이는 트리거 방식과 무관하게 이미 존재한다.
