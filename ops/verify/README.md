# 2호기 검증 DB · DB 백업

오너 결정(2026-10-05): 운영 DB = MongoDB Atlas(M0), 검증·백업 = 2호기(`ssh macro-verify`) 로컬 MongoDB 8.0.
"DB 백업은 구성하고 앱 백업은 하지 않는다" — 앱은 저장소(git)가 원본이라 따로 백업하지 않는다.

## 구성

| 항목 | 위치 |
|---|---|
| 매일 복사 + 백업 | `macro-db-sync.timer`(05:30 KST) → `/usr/local/bin/macro-db-sync`(= `db-sync.sh`) |
| 점검 | `macro-db-check` (종료코드 0/1, `sudo` 로 실행하면 백업 파일을 직접 `gzip -t`) |
| 접속 정보(root 600) | `/etc/macro-db/sync-src.env`(운영 읽기), `sync-dst.env`(2호기 sync), `admin.env`(2호기 root), `app.uri`(verify-dev) |
| 백업 파일(root 700) | `/var/backups/macro-db/` |
| 마지막 결과 | `/var/lib/macro-db/last-sync.json` |
| 설치·재설치 | `sudo bash ops/verify/install-db.sh` |

백업 파일은 `mongodump --archive --gzip` 형식(파일 전체가 gzip). 보관:

- 매일본 `market_research-YYYYMMDD-HHMM.archive.gz` — 7일
- 주간본 `weekly-…` — 일요일(KST) 성공분, 최신 4개
- 월간본 `monthly-…` — 매월 1일(KST) 성공분, 최신 3개

주간·월간본은 매일본의 하드링크라 같은 날짜면 공간을 더 쓰지 않는다. 1개 약 8MB(2026-10 기준) → 최대 14개 약 110MB.
보호 컬렉션(`kr_da_staging`·`verify_results`·`*_staging` — 2호기 검증 전용)은 덤프에 들어가지 않는다 = 이 백업에도 없다.

## 복원 시험 · 2호기로 복원

시험(본 DB 를 건드리지 않음, 2026-10-05 실측: 29컬렉션·43,505건·인덱스 47·불일치 0):

```bash
sudo -s
. /etc/macro-db/admin.env
f=$(ls -1t /var/backups/macro-db/market_research-*.archive.gz | head -1)   # 또는 weekly-/monthly- 파일
gzip -t "$f"
mongorestore --uri="$MONGO_ADMIN_URI" --gzip --archive="$f" \
  --nsInclude='market_research.*' --nsFrom='market_research.*' --nsTo='restore_test.*'
mongosh "$MONGO_ADMIN_URI" --quiet --eval 'const d=db.getSiblingDB("restore_test"); d.getCollectionNames().forEach(n=>print(n, d[n].countDocuments()))'
mongosh "$MONGO_ADMIN_URI" --quiet --eval 'db.getSiblingDB("restore_test").dropDatabase()'
```

2호기 본 DB 를 특정 백업 시점으로 되돌리려면 위 명령에서 `--nsFrom/--nsTo` 를 빼고 `--drop` 을 붙인다
(그 백업에 있는 컬렉션만 교체, 보호 컬렉션은 백업에 없으니 그대로). 다음 05:30 복사가 다시 운영 최신으로 덮는다 —
옛 시점을 유지하려면 그동안 `sudo systemctl stop macro-db-sync.timer`.

## 운영 Atlas 로 되돌리기 (운영 DB 가 깨졌을 때 — 실행 전 오너 승인 필수)

- **누가**: 오너가 승인하고 실행(또는 오너가 지시한 작업자가 오너 입회하에). 자동화하지 않는다.
- **어떤 계정으로**: 2호기의 매일 복사 계정(`sync-src.env`)은 쓰지 않는다 — 복사 경로는 읽기 전용으로 두어야 한다.
  Atlas 콘솔에서 `market_research` readWrite 임시 DB 사용자를 만들고, 복원 후 바로 삭제한다.
- **무엇을 덮어쓰나**: `--drop` 을 주면 백업에 들어 있는 컬렉션(보호 컬렉션 제외 전부)을 백업 시점 내용으로 **통째로 교체**한다.
  백업 이후 운영에 새로 쌓인 문서(리서치 수집·뉴스·텔레그램·주간 리포트 편집 등)는 사라진다. 백업에 없는 컬렉션은 그대로.
  가능하면 망가진 컬렉션만 `--nsInclude='market_research.<컬렉션>'` 으로 좁힌다.
- **순서**
  1. 복원 직전 운영 상태를 따로 덤프(현재 상태 보존 — 되돌림의 되돌림용).
  2. 운영 쓰기 작업 정지: 오라클 수집·배치 타이머, 1호기 앱(또는 점검 시간에 수행).
  3. 위 "복원 시험"으로 쓸 백업 파일이 온전한지 2호기에서 먼저 확인.
  4. `mongorestore --uri='<임시 readWrite 사용자 운영 주소>' --gzip --archive="$f" --nsInclude='market_research.<대상>' --drop`
  5. 컬렉션별 문서 수 대조, 앱 주요 화면 확인, 타이머·앱 재개, 임시 사용자 삭제.
- Atlas M0 용량 512MB — 복원 전 `node scripts/db/size.mjs` 로 여유 확인.
