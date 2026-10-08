# 배포

## 0. 서버 구성 (2026-10-03 오너 결정)

Vercel Hobby 가 Active CPU 한도 초과로 정지된 뒤 오라클 1호기를 메인으로 쓴다(2026-10-05 기준 — 구글 Cloud Run 종료, Vercel 은 정지 해제 후 재연동 예정). 모두 같은 MongoDB 를 쓴다. 오라클 두 대 합계 3코어·20GB(무료 한도 4코어·24GB 이내, 0원).

| 서버 | 역할 | 주소 | 배포 |
|---|---|---|---|
| **오라클 1호기** (오사카 ARM A1 2코어·12GB, 161.33.9.115) | **운영(1순위 주소)** — 화면 + 무거운 자동 작업 | https://macro-insights.duckdns.org | `deploy-oracle.yml`: master 푸시(앱 파일) → 서버가 해당 커밋을 받아 직접 빌드(ARM)·재시작 |
| **오라클 2호기 `macro-verify`** (1코어·8GB·스왑 4GB, 140.83.48.57) | **검증 + IPO 운영(격리)** — `kr/verification` 브랜치 개발 서버(`verify-dev`, localhost:3000, 외부 비공개) + IPO 앱(`ipo@prod` :8000·`ipo@dev` :8001, Caddy 443·8443, ipo-auto.duckdns.org, 사무실·개발 PC IP 만 허용) | 없음(macro) | 수동(`cd ~/5 && git pull`) — 2026-10-04 생성. 운영과 IP·CPU 분리(DART·SEC 요청 제한이 운영에 번지지 않게). 환경변수 `~/5/.env.local`(운영 app.env + `KR_DA_COLLECTION=kr_da_staging`). SSH 키 `~/.ssh/oracle_verify` |
| ~~구글 Cloud Run~~ (`brave-smile-508510-g5`, asia-northeast1) | **종료(2026-10-05 오너 결정)** — 서비스 삭제·배포 워크플로 비활성. 이미지(208MB)는 무료 범위라 보존 | — | `deploy-cloudrun.yml`(비활성) |
| Vercel | **2순위 주소**. Hobby 한도 초과로 정지(402) 중 — 다음 달 사용량 초기화 때 풀리면 재연동 예정 | https://macroresearch.vercel.app | Git 연동(`vercel.json` ignoreCommand만, crons 는 2026-10-03 제거) |

- **자동 작업이 부르는 주소는 저장소 변수 `APP_URL` 하나**(지금 오라클). 워크플로는 `${{ vars.APP_URL }}`, 수집 스크립트는
  `scripts/lib/app-url.mjs`(`APP_URL` 환경변수, 없으면 오라클 도메인). 메인을 바꿀 때는 이 변수만 고친다.
- 오라클 서버: Docker 컨테이너 `macro`(127.0.0.1:8080, 재시작 자동) 앞에 Caddy(HTTPS 자동 발급). 환경변수는
  `/opt/macro/app.env`(600, **서버가 원본 — 배포는 코드만**, 아래 「운영 비밀값」). 최초 설치 `ops/oracle/setup.sh`, 점검 `ops/oracle/healthcheck.sh`.
  디스크 캐시: SEC `/opt/macro/sec-cache`(앱 `/tmp/.cache`), DART `/opt/macro/dart-cache`(앱·배치 `DART_CACHE_DIR=/dart-cache`, 판본 = 보고서 최신
  접수번호, 90일 미사용·`DART_CACHE_MAX_GB`(기본 2) 정리 — `src/lib/markets/kr/dart-cache.ts`). 배포·배치(`run-ts.sh`)가 같은 폴더를 쓴다.
  배포 키는 비밀값 `ORACLE_SSH_KEY`, 주소는 변수 `ORACLE_HOST`·`ORACLE_DOMAIN`. 도메인은 DuckDNS(IP 가 바뀌면 duckdns.org 에서 갱신).

### 운영 비밀값·GitHub 권한 (2026-10-06 오너 승인 — "GitHub 는 지금 방식(A) 유지 + 비밀값 서버 이전·배포 키 제한·Actions 버전 고정")

GitHub 계정·저장소·Actions 가 뚫려도 운영 비밀값과 1호기 관리자 권한이 넘어가지 않게 한다.

- **비밀값 원본 = 1호기 파일**(모두 ubuntu 600, 설정 백업에 포함): `/opt/macro/app.env`(앱 컨테이너 — DB 주소·DART·KRX·Clerk·Gemini 등 전부),
  `/opt/macro/jobs.local.env`(배치 전용 — `TELEGRAM_*`), `/opt/macro/jobs.env`(**만들어지는 파일 — 손으로 고치지 않는다**: 배포·동기화 때
  `ops/oracle/build-jobs-env.sh` 가 app.env(앱 전용 `APP_COMMIT_SHA`·`SEC_CACHE_DIR`·`DART_CACHE_DIR` 제외) + jobs.local.env 로 다시 만든다).
  배포 워크플로는 app.env 를 쓰지 않는다. 빌드에 필요한 공개 키 `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` 도 서버 app.env 에서 읽는다.
- **배포 흐름**: master 푸시 → `deploy-oracle.yml` 이 `ssh ubuntu@1호기 "deploy <커밋>"`(앱 파일 변경) / `oracle-sync-jobs.yml` 이
  `"sync-jobs <커밋>"`(scripts·ops 변경). 배포 키는 1호기 `~ubuntu/.ssh/authorized_keys` 에서
  `command="/opt/macro/ops/deploy-entry.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding` 로 묶여 있다 — `deploy|sync-jobs <40자 커밋>`
  외에는 거부(셸·scp·sftp·포트 포워딩 불가), **커밋은 GitHub master 에 들어간 것만**(포크·다른 브랜치 거부). 수락하면 그 커밋의
  `ops/oracle/deploy-app.sh`(빌드·재시작·post-deploy) 또는 `post-deploy.sh` 를 실행. 기록은 `sudo journalctl -t macro-deploy-entry`.
  `deploy-entry.sh` 는 배포가 자동으로 바꾸지 않는다 — 고치면 `sudo install -m 755 -o root ops/oracle/deploy-entry.sh /opt/macro/ops/`.
  한계: 저장소 master 에 쓸 수 있는 사람은 그 커밋의 스크립트·Dockerfile 로 서버에서 코드를 돌릴 수 있다(방식 A 의 본질). 막는 것은
  "배포 키만 새어 나간 경우"와 "GitHub 비밀값 열람"이다.
- **키 교체(서버에서 직접)** — 개발 PC 에서 `ssh macro-prod`:
  1. `nano /opt/macro/app.env`(배치 전용 값은 `/opt/macro/jobs.local.env`) — 값은 화면에 띄우지 말고 그 줄만 고친다.
  2. 앱 재기동(같은 커밋, 빌드 캐시라 1~2분, 그동안 10~20초 끊김): `bash /opt/macro/src/ops/oracle/deploy-app.sh "$(git -C /opt/macro/src rev-parse HEAD)"`
     — 끝에 post-deploy 가 jobs.env 를 다시 만들고 텔레그램 수신기를 재시작한다. jobs.local.env 만 바꿨으면
     `bash /opt/macro/ops/build-jobs-env.sh && sudo systemctl restart macro-telegram-listener` 로 충분.
  3. 설정 백업 즉시 반영: `sudo systemctl start macro-config-backup.service`(평소엔 매일 05:40).
  4. 2호기 `~/5/.env.local` 도 같은 값을 쓰면 거기서도 고친다(2호기는 수동).
- **GitHub 에 남긴 비밀값**: `ORACLE_SSH_KEY`(위 배포 키 — 제한됨), `CRON_SECRET`(수동 비상용 수집기 워크플로가 `/api/cron/*` 에 보냄),
  `TELEGRAM_API_ID`·`TELEGRAM_API_HASH`·`TELEGRAM_SESSION`(수동 비상용 `telegram-posts.yml`, 비활성 — 쓰지 않을 거면 지워도 된다).
  상태 점검이 이슈를 여는 `OPS_GH_TOKEN`(Issues 전용)은 1호기 `ops/alert.env` 에 있다. **운영 앱 키(DB 주소·DART·KRX·Clerk·Gemini·네이버·
  유튜브 등 22개)는 2026-10-06 GitHub 에서 지웠다** — 그 값을 쓰던 `fin-build.yml`·`ttm-build.yml`(오라클 타이머로 대체)·`deploy-cloudrun.yml`
  (종료)은 비활성.
- **Actions 버전 고정**: 모든 워크플로의 외부 action 은 커밋 SHA 로 고정(주석에 원래 태그). 올릴 때는 새 태그의 커밋 SHA 로 바꾼다
  (`gh api repos/<owner>/<repo>/git/ref/tags/<태그>` — annotated tag 면 한 번 더 `git/tags/<sha>`).

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
| `macro-br-ntnf` | 타이머 | 매일 07:10 | 브라질 국채 NTN-F ~10년 중간값(ANBIMA 지표 > 재무부 CSV (매수+매도)/2, 새 날짜만 `br_ntnf_daily`, 최신값이 평일 3일 넘게 멈추면 실패 → job 알림) |
| `fin-analyst-forecasts` | 타이머 | 매일 10:20 | StockAnalysis 애널리스트 투자의견 |
| `weekly-report` | 타이머 | 월 06:00 | 주간 리포트 초안 |
| `news-stock-news` | 타이머 | 10분마다 | 유니버스 종목뉴스(신선도 지난 종목만) |

- 확인: `ssh -i ~/.ssh/oracle_macro ubuntu@161.33.9.115 'systemctl list-timers --no-pager'`, 로그 `sudo journalctl -u <이름>`.
- 실행기(저장소 `ops/oracle/`, 배포·동기화 때 `/opt/macro/ops/` 로 설치): `call-cron.sh`(앱 `/api/cron/*` 서버 안 호출, POST 가능),
  `run-script.sh`(수집 스크립트 — 작업 폴더 `/opt/macro/jobs`), `run-research.sh`(국내 리서치 회차별 범위), `run-ts.sh`(앱 계산 코드 배치).
  타이머 정의는 `ops/oracle/install-schedules.sh`(다시 돌려도 같은 결과). 수집기·ops 만 바뀐 푸시는 `oracle-sync-jobs.yml` 이 작업 폴더만 맞춘다.
- 사무실 PC 작업 스케줄러 `macro-research-bnk`(BNK — 해외 IP 차단, 한국 IP 필요).

### 상호 감시 (2026-10-05 오너 지시 — "상태점검은 상호 감시해야 한다")

두 호기가 10분마다 자기 자신과 상대를 점검한다. 알림은 같은 텔레그램 봇 + GitHub 이슈(라벨 `ops-alert`, 제목 `[ops-alert][N호기] 항목: 내용`).
상태가 바뀔 때만 알리고(정상→문제 = 이슈 열기, 문제→정상 = 이슈 닫기), 상대 서버 항목은 **연속 2회(20분) 실패**해야 연다. 알림 함수는
`ops/oracle/alert-lib.sh` 공용.

| 실행 위치 | 스크립트·타이머 | 점검 |
|---|---|---|
| 1호기 | `healthcheck.sh` · `macro-health.timer`(root, `/opt/macro/ops/`, 설정 `alert.env`) | 자체(컨테이너·앱·재시작·HTTPS·인증서·디스크·메모리·재부팅·예약 작업·텔레그램 수신기·한국 재무) + **2호기**: SSH 포트(`peer-ssh`), 하트비트 30분 초과·읽기 실패(`peer-heartbeat`) |
| 2호기 | `healthcheck-peer.sh` · `macro-peer-health.timer`(root, `/opt/macro-health/`, 설정 `alert.env` — `OPS_TG_*`·`OPS_GH_*` 만) | **1호기**: 운영 `/api/auth/me` 200(`op-https`), 한국 재무 `/api/markets/kr/005930/financials?period=annual` 200(`op-dart-kr`), 인증서 14일(`op-cert-expiry`), SSH 포트(`op-ssh`) + 자체: `verify-dev`·`ipo@prod`·`ipo@dev`(`svc-*`), 검증 DB 복사(`db-sync` — `macro-db-check`, 1회 실패로 알림), 디스크 80%·메모리 10%·재부팅 필요, 끝나면 하트비트 기록 |

- **하트비트**: 2호기 점검이 끝까지 돌면 `/var/lib/macro-health/heartbeat`(644)에 `초 ISO시각 열린알림목록` 한 줄을 쓴다. 1호기가 전용 키
  `/opt/macro/ops/peer_ed25519`(root 600, 호스트 키 `peer_known_hosts`)로 읽는다. 2호기 `authorized_keys` 에는 이 키를
  `from="161.33.9.115",command="cat /var/lib/macro-health/heartbeat",restrict` 로만 등록 — 어떤 명령을 보내도 그 파일 출력뿐이고 포워딩·터미널
  불가(설치 때 확인). **2호기 → 1호기 SSH 권한은 없다**(2호기는 격리 서버, 1호기 감시는 공개 주소·포트 응답만).
- 설치: 1호기 `sudo bash /opt/macro/jobs/ops/oracle/install-health.sh`(키가 없으면 만들고 공개키를 출력). 이후 `post-deploy.sh` 가 배포·동기화마다
  `alert-lib.sh`·`healthcheck.sh` 를 다시 설치한다. 2호기는 master 작업 폴더가 없어 개발 PC 에서 올린다:
  `scp -i ~/.ssh/oracle_verify ops/oracle/{alert-lib.sh,healthcheck-peer.sh,install-health-peer.sh} ubuntu@140.83.48.57:/tmp/hc/` →
  `ssh … 'sudo bash /tmp/hc/install-health-peer.sh "<1호기 peer_ed25519.pub>"'`. **2호기 스크립트를 고치면 이 절차로 다시 올려야 한다**(자동 동기화 없음).
- 시험: 양쪽 `--test`(텔레그램 + 이슈 열고 닫기). 실패 흉내 — 2호기 `sudo HC_PEER_IP=192.0.2.1 /opt/macro-health/healthcheck-peer.sh` 2회,
  1호기 `sudo HC_PEER_HOST=192.0.2.1 /opt/macro/ops/healthcheck.sh` 2회 → 알림, 그냥 1회 → 복구(2026-10-05 양쪽 확인).
- 한계: 두 대가 같은 리전(오사카)·같은 계정이라 리전 장애·계정 정지는 둘 다 못 알린다. 2호기 IPO 앱의 HTTPS 응답은 접속 IP 제한 때문에 보지 않고
  서비스 active 만 본다.

### 설정 백업 (2026-10-05 오너 지시 — "설정 백업 보관소도 2호기에 추가한다")

1호기에만 있고 GitHub 에 없는 설정을 매일 묶어 **1호기에서 암호화(age)** 한 뒤 2호기에 보관한다. 2호기에는 암호문만 있다.

- 담는 것: `/opt/macro/app.env`·`jobs.local.env`(텔레그램 세션)·`jobs.env`(운영 비밀값 원본 — GitHub 에는 없다), `/opt/macro/ops` 전체(alert.env·감시 키·measure 스크립트 등, 복호화 키만 제외),
  `/etc/caddy/Caddyfile`, `/etc/iptables`, `/etc/systemd/system` 의 프로젝트 유닛(`macro-*`·`news-*`·`research-*`·`fin-*`·`weekly-*`·`measure-*`),
  유닛 사용 여부·타이머 목록·crontab(`meta/`), 원본 해시 `MANIFEST.sha256`. 캐시(sec-cache·research-cache·npm-cache)와 저장소 사본(jobs·src)은 뺀다.
- 1호기: `ops/oracle/config-backup.sh` · `macro-config-backup.timer`(매일 05:40 KST, root). 설치 `sudo bash /opt/macro/jobs/ops/oracle/install-config-backup.sh`
  (age 설치, 키는 없을 때만 생성). 암호화 공개키 `/opt/macro/ops/config-backup.pub`. **복호화 키는 1호기 `/opt/macro/ops/config-backup.key`(root 600)와
  개발 PC `C:\Users\post0\.ssh\macro-config-backup.key`(본인만 읽기) 두 곳에만 있다** — 2호기에는 없다. 전송 키 `/opt/macro/ops/backup_ed25519`.
- 2호기: 전용 계정 `macrobak`(비밀번호 잠금)의 `authorized_keys` 에 1호기 전송 키를 `from="161.33.9.115",command="/usr/local/bin/macro-config-receive",restrict`
  로만 등록 — 표준입력을 `/var/backups/macro-config/macro-config-YYYYMMDD-HHMMSS.age`(700/600)로 저장만 한다(age 헤더·100MB 상한 검사, 저장본 해시를
  돌려줘 1호기가 대조). 보관: 최근 7일 매일 + 일요일 것 4주. 설치는 개발 PC 에서
  `scp -i ~/.ssh/oracle_verify ops/oracle/{macro-config-receive,install-config-receive.sh} ubuntu@140.83.48.57:/tmp/hc/` →
  `ssh … 'sudo bash /tmp/hc/install-config-receive.sh "<1호기 backup_ed25519.pub>"'`. 2호기 → 1호기 접속 권한은 없다.
- 감시: 성공하면 `/var/lib/macro-health/.config-backup-ok` 갱신, 1호기 `healthcheck.sh` 의 `config-backup` 항목이 26시간 넘으면 알림
  (실패한 회차는 예약 작업 항목 `job-macro-config-backup` 으로도 알림).
- 복원 시험(2026-10-05): 개발 PC 키로 2호기 최신본을 받아 임시 폴더에서 복호화 → 1호기 원본 126개 파일 해시 전부 일치 → 임시 폴더 삭제.

**1호기 재구축 시 복원 순서** (1호기가 통째로 사라진 경우, 개발 PC 에서)
1. 새 서버를 만들고 `ops/oracle/setup.sh` 로 기본 설치(DuckDNS 를 새 IP 로 갱신, 저장소 변수 `ORACLE_HOST` 도).
2. 2호기에서 최신 백업 받기: `ssh -i ~/.ssh/oracle_verify ubuntu@140.83.48.57 'sudo sh -c "cat \$(ls -1t /var/backups/macro-config/*.age | head -1)"' > latest.age`
3. 개발 PC 에서 복호화·확인: `age -d -i ~/.ssh/macro-config-backup.key -o latest.tgz latest.age` → `tar -xzf latest.tgz -C restore/` →
   `cd restore && sha256sum -c MANIFEST.sha256`(age 는 https://github.com/FiloSottile/age/releases).
4. 새 서버 제자리로: `opt/macro/{app.env,jobs.local.env,jobs.env}`(ubuntu 600), `opt/macro/ops/`(alert.env 600·키들), `etc/caddy/Caddyfile`, `etc/iptables/`,
   `etc/systemd/system/` 유닛 → `sudo systemctl daemon-reload` → `meta/unit-files.txt` 에서 enabled 인 타이머를 `enable --now`.
   복호화 키 `config-backup.key` 는 백업에 없으므로 개발 PC 키를 `/opt/macro/ops/config-backup.key`(root 600)로 다시 올린다.
5. 배포 키 입구 설치: `sudo install -m 755 -o root ops/oracle/deploy-entry.sh /opt/macro/ops/` + `~ubuntu/.ssh/authorized_keys` 의 github-actions-deploy 줄에
   위 「운영 비밀값」의 `command=…` 제한을 붙인다. 그다음 master 를 한 번 배포(`deploy-oracle.yml` 수동 실행) → 앱 컨테이너·작업 폴더(`/opt/macro/jobs`)·실행기 설치.
6. IP 가 바뀌었으면 2호기 `authorized_keys`(ubuntu 하트비트 줄·macrobak 줄)의 `from=` 과 2호기 점검의 1호기 IP(`HC_PEER_IP` 기본값)를 고친다.
   `peer_known_hosts`·전송 키는 백업에서 복원되므로 그대로 쓴다. 끝으로 양쪽 `--test`.

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
- 세션(`TELEGRAM_SESSION`) 원본은 오라클 `/opt/macro/jobs.local.env`(600)다(jobs.env 는 배포 때 다시 만들어진다). 세션을 새로 만들면(`scripts/telegram-login.mjs`) jobs.local.env 를 고치고 위 「키 교체」 절차대로(비상용 GitHub 비밀값을 남겨 뒀다면 그것도).
