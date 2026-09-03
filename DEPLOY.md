# 배포 (Vercel)

Vercel CLI는 설치·로그인(post0318) 완료 상태. 아래는 사용자가 직접 실행해야 하는 단계
(자동 승인 정책이 `vercel link` / `vercel deploy` / `git push` 를 막음).

## 1. 데이터베이스 — Turso (libSQL 클라우드)

로컬은 `file:./data/app.db` SQLite. Vercel 서버리스는 파일 쓰기 불가 →
**Turso** 로 전환 (코드 변경 없음, 환경변수만).

```bash
# Turso CLI 설치 (한 번)
curl -sSfL https://get.tur.so/install.sh | bash    # 또는 Windows: irm https://get.tur.so/install.ps1 | iex

turso auth signup            # 또는 turso auth login
turso db create market-research
turso db show market-research --url          # → DATABASE_URL (libsql://...)
turso db tokens create market-research       # → DATABASE_AUTH_TOKEN
```

스키마 적용 (로컬에서 원격 Turso 대상):

```bash
DATABASE_URL="libsql://..." DATABASE_AUTH_TOKEN="..." npx drizzle-kit migrate
```

> Turso 없이 배포해도 **거시경제·종목분석·지수·F&G 는 정상 동작**.
> `유니버스 관리`·`유니버스 통합 뷰` 두 화면만 DB 필요 → 그 화면에서 에러 표시.

## 2. Vercel 프로젝트 연결

```bash
cd C:/Users/infomax/5
vercel link            # 대화형: post0318 스코프 선택, 프로젝트명 입력(예: market-research)
```

## 3. 환경변수 등록

```bash
vercel env add DATABASE_URL production          # libsql://... (Turso)
vercel env add DATABASE_AUTH_TOKEN production    # Turso 토큰
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
