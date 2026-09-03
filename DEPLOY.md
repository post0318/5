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
