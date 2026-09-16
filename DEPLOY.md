# 배포 (Vercel)

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
6회, 최대 공백 4시간 36분, 2026-09 실측)에 그쳐 화면이 몇 시간씩 멈춰
보였다. 분 값을 정각에서 비껴도 개선되지 않았다 — 지연이 아니라 예약 자체가
누락된다. 반면 `workflow_dispatch` 는 즉시 실행된다(실측). 그래서 **외부
크론이 GitHub API 를 호출해 수동 실행시키는 방식**을 주 경로로 쓴다.
다른 수집기(하루 1회)는 몇 시간 지연이 무의미하므로 그대로 `schedule` 을 쓴다.

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
- Headers:
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <위에서 발급한 토큰>`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- Body: `{"ref":"master"}`
- Schedule: 15분마다 (원하면 낮에만 더 촘촘히)

성공 시 응답은 **204 No Content** 이고 본문이 없다. cron-job.org 가 빈 응답을
실패로 표시하면 "성공으로 볼 상태코드"에 204 를 넣는다.

로컬에서 같은 호출을 확인하려면:

```
gh api -X POST repos/post0318/5/actions/workflows/telegram-posts.yml/dispatches -f ref=master -i
```

### 6-3. 주의

- 워크플로에 `concurrency` 가 걸려 있어 외부 크론과 백업 스케줄이 겹쳐도
  동시에 두 번 돌지 않는다.
- 토큰을 외부 사이트에 두는 것이 꺼려지면, Vercel 라우트를 하나 두고 토큰은
  Vercel 환경변수에 보관한 뒤 외부 크론은 그 라우트만 호출하게 바꿀 수 있다.
  외부에 나가는 비밀이 GitHub 토큰에서 이 프로젝트 전용 값으로 바뀐다.
- 텔레그램 쪽 호출량은 채널당 하루 100회 미만이라 제한에 걸릴 수준이 아니다.
  실제 위험은 빈도가 아니라 개인 계정 세션을 데이터센터 IP 에서 쓰는 것이고,
  이는 트리거 방식과 무관하게 이미 존재한다.
