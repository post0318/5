#!/usr/bin/env bash
# 2호기(검증 서버) 매일 한 방향 복사: 운영 Atlas → 2호기 로컬 MongoDB(market_research).
# 오너 지시 2026-10-05 — "운영은 MongoDB(Atlas), 백업·검증은 2호기 DB". 2호기는 운영 DB 에 쓰지 않는다.
#
# 규칙
#  - 운영(Atlas)에는 읽기만 한다: mongodump 와 컬렉션 목록 조회뿐(쓰기 명령 없음).
#  - 보호 컬렉션(PROTECTED + /etc/macro-db/protected-collections, 이름이 _staging 으로 끝나는 것)은 덤프에서 빼고
#    복원에서도 한 번 더 빼 덮어쓰지 않는다 — 2호기에서만 만드는 검증 전용 컬렉션.
#  - 운영에 없고 2호기에만 있는 컬렉션은 지우지 않는다(로그만).
#  - 복원은 임시 DB(market_research_sync)에 먼저 하고, 컬렉션 수가 맞을 때만 본 DB 로 바꿔 넣는다.
#    덤프·복원·대조가 하나라도 실패하면 본 DB 는 이전 복사본 그대로.
#  - 덤프 압축본 = 정식 DB 백업(오너 결정 2026-10-05 "DB 백업은 구성하고 앱 백업은 하지 않는다"). /var/backups/macro-db 에
#    매일본 market_research-* 7일 · 주간본 weekly-*(일요일 KST 성공분) 4개 · 월간본 monthly-*(매월 1일 KST 성공분) 3개.
#    주간·월간본은 매일본의 하드링크(같은 파일 — 매일본이 지워져도 남는다). 압축본은 gzip -t·1MB 이상을 확인한 뒤에만 복원한다.
#    복원 절차: ops/verify/README.md
# 접속 정보: /etc/macro-db/sync-src.env(SRC_URI, 운영 읽기), /etc/macro-db/sync-dst.env(DST_URI, 2호기 sync 사용자) — root 600.
# 결과: /var/lib/macro-db/last-sync.json (점검 명령 macro-db-check 가 읽는다).
set -euo pipefail

DB=market_research
TMP=market_research_sync
BK=/var/backups/macro-db
STATE=/var/lib/macro-db
PROTECTED=(kr_da_staging verify_results verify_state)
if [[ -f /etc/macro-db/protected-collections ]]; then
  while read -r c; do [[ -n "$c" && "$c" != \#* ]] && PROTECTED+=("$c"); done </etc/macro-db/protected-collections
fi

# shellcheck disable=SC1091
. /etc/macro-db/sync-src.env
# shellcheck disable=SC1091
. /etc/macro-db/sync-dst.env
install -d -m 700 "$BK"
install -d -m 755 "$STATE"

ts=$(date +%Y%m%d-%H%M)
archive="$BK/$DB-$ts.archive.gz"
bytes=0
status() { # $1 ok|fail $2 메시지
  printf '{"ok":%s,"at":"%s","epoch":%s,"archive":"%s","bytes":%s,"msg":"%s"}\n' \
    "$([[ $1 == ok ]] && echo true || echo false)" "$(date -Is)" "$(date +%s)" "$archive" "$bytes" "$2" >"$STATE/last-sync.json.tmp"
  mv "$STATE/last-sync.json.tmp" "$STATE/last-sync.json"
  chmod 644 "$STATE/last-sync.json"
}
trap 'status fail "중단(줄 $LINENO) — 본 DB 는 이전 복사본"' ERR

isprot() {
  local n=$1 p
  [[ $n == *_staging ]] && return 0
  for p in "${PROTECTED[@]}"; do [[ $n == "$p" ]] && return 0; done
  return 1
}

# 1) 운영 컬렉션 목록(읽기) — 보호 컬렉션·뷰 제외
mapfile -t SRC_COLLS < <(mongosh "$SRC_URI" --quiet --eval \
  "db.getSiblingDB('$DB').getCollectionInfos({type:'collection'}).map(c=>c.name).filter(n=>!n.startsWith('system.')).forEach(n=>print(n))")
COPY=(); EXCL=(); NSEX=()
for c in "${SRC_COLLS[@]}"; do
  if isprot "$c"; then EXCL+=("--excludeCollection=$c"); else COPY+=("$c"); fi
done
for p in "${PROTECTED[@]}"; do NSEX+=("--nsExclude=$DB.$p"); done
NSEX+=("--nsExclude=$DB.*_staging")
echo "운영 컬렉션 ${#SRC_COLLS[@]}개 중 복사 ${#COPY[@]}개, 보호(제외) $(( ${#SRC_COLLS[@]} - ${#COPY[@]} ))개"
[[ ${#COPY[@]} -gt 0 ]] || { status fail "운영 컬렉션 목록이 비었다"; exit 1; }

# 2) 덤프(운영 읽기)
mongodump --uri="$SRC_URI" --db="$DB" --gzip --archive="$archive.part" --readPreference=secondaryPreferred --quiet "${EXCL[@]}"
mv "$archive.part" "$archive"; chmod 600 "$archive"
bytes=$(stat -c %s "$archive")
gzip -t "$archive" || { status fail "압축본 손상(gzip -t) — 복원 안 함"; exit 1; }
(( bytes >= 1048576 )) || { status fail "압축본이 1MB 미만($bytes B) — 복원 안 함"; exit 1; }

# 3) 임시 DB 로 복원(2호기)
mongosh "$DST_URI" --quiet --eval "db.getSiblingDB('$TMP').dropDatabase()" >/dev/null
mongorestore --uri="$DST_URI" --gzip --archive="$archive" --nsInclude="$DB.*" --nsFrom="$DB.*" --nsTo="$TMP.*" \
  "${NSEX[@]}" --drop --quiet

# 4) 대조 후 본 DB 로 교체 — 덤프한 컬렉션만, 보호 컬렉션은 다시 확인해 건너뜀
want=$(printf '%s\n' "${COPY[@]}" | sort | paste -sd,)
mongosh "$DST_URI" --quiet --eval "
const want='$want'.split(',').filter(Boolean);
const prot=new Set('${PROTECTED[*]}'.split(' '));
const tmp=db.getSiblingDB('$TMP'), dst=db.getSiblingDB('$DB');
const got=tmp.getCollectionNames().filter(n=>!n.startsWith('system.')).sort();
const missing=want.filter(n=>!got.includes(n));
if (missing.length) { print('임시 DB 에 없는 컬렉션: '+missing.join(',')); quit(2); }
for (const n of got) {
  if (prot.has(n) || n.endsWith('_staging')) { print('보호 컬렉션 건너뜀: '+n); continue; }
  const r=db.adminCommand({renameCollection:'$TMP.'+n, to:'$DB.'+n, dropTarget:true});
  if (!r.ok) { print('교체 실패 '+n+': '+tojson(r)); quit(3); }
}
const only=dst.getCollectionNames().filter(n=>!n.startsWith('system.')&&!want.includes(n));
print('교체 '+got.length+'개, 2호기에만 있는 컬렉션(유지): '+(only.join(',')||'없음'));
tmp.dropDatabase();
"

# 5) 백업 보관 — 주간·월간본 지정(성공분만, KST 기준), 매일본 7일·주간본 4개·월간본 3개
base=$(basename "$archive")
[[ $(TZ=Asia/Seoul date +%u) == 7 ]] && ln -f "$archive" "$BK/weekly-$base"
[[ $(TZ=Asia/Seoul date +%d) == 01 ]] && ln -f "$archive" "$BK/monthly-$base"
find "$BK" -maxdepth 1 -name "$DB-*.archive.gz" -mtime +6 -delete
keep() { # $1 접두 $2 개수 — 최신 N개만 남김
  find "$BK" -maxdepth 1 -name "$1-$DB-*.archive.gz" -printf '%T@ %p\n' | sort -rn | tail -n +$(( $2 + 1 )) | cut -d' ' -f2- | xargs -r rm -f
}
keep weekly 4
keep monthly 3
find "$BK" -maxdepth 1 -name "*.part" -mtime +1 -delete
status ok "복사 ${#COPY[@]}개 컬렉션"
echo "완료: $archive ($(du -h "$archive" | cut -f1))"
