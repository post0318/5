#!/usr/bin/env bash
# 2호기 검증 결과 가져오기(2026-10-06, 오너 승인 — pull 방식: 2호기에는 운영 비밀값을 주지 않는다).
# 1호기가 전용 키(/opt/macro/ops/verifypull_ed25519)로 2호기 /var/lib/macro-verify/latest.json 을 읽는다. 2호기 macrobak 계정의
# authorized_keys 가 이 키를 `cat /var/lib/macro-verify/latest.json` 강제 명령으로만 허용한다(읽기 전용).
# 크기·JSON·필수 필드를 검사한 뒤 운영 앱의 기존 수신 라우트(/api/cron/verify-results, 서버 내부 + CRON_SECRET)로 넣는다 — DB 를 직접 쓰지 않는다.
# 같은 generatedAt 은 다시 넣지 않는다(새로 나온 결과만). results 는 종목별 "마지막 결과"라 예전 것이 섞인다 — 운영에 더 새 결과가
# 있으면 라우트가 건너뛴다(older). 관리자 화면(/admin/verify)이 그 결과·시각·판본을 보인다.
# systemd 타이머(macro-verify-pull.timer, 매일 08:30 KST) + 수동: sudo systemctl start macro-verify-pull
# 성공하면 /var/lib/macro-health/.verify-pull-ok 갱신, 결과 생성 시각은 .verify-pull-generated — healthcheck.sh 가 감시.
set -euo pipefail
OPS=/opt/macro/ops
PEER_HOST="${OPS_PEER_HOST:-140.83.48.57}"
STATE=/var/lib/macro-health
MAX_BYTES=$((20 * 1024 * 1024))
SECRET=$(grep -E "^CRON_SECRET=" /opt/macro/app.env | cut -d= -f2-)
[ -n "$SECRET" ] || { echo "CRON_SECRET 없음(/opt/macro/app.env)" >&2; exit 1; }

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
if [ -n "${VERIFY_PULL_FILE:-}" ]; then   # 형식 시험용: 로컬 파일을 대신 읽는다(DB 반영은 VERIFY_PULL_DRYRUN=1 로 막을 것)
  head -c $((MAX_BYTES + 1)) "$VERIFY_PULL_FILE" > "$W/latest.json"
else
  timeout 120 ssh -i "$OPS/verifypull_ed25519" -o BatchMode=yes -o ConnectTimeout=15 \
    -o UserKnownHostsFile="$OPS/peer_known_hosts" -o StrictHostKeyChecking=yes \
    "macrobak@${PEER_HOST}" 2>"$W/ssh.err" | head -c $((MAX_BYTES + 1)) > "$W/latest.json" \
    || { echo "2호기에서 읽기 실패: $(head -c 300 "$W/ssh.err")" >&2; exit 1; }
fi
size=$(stat -c %s "$W/latest.json")
[ "$size" -gt 0 ] && [ "$size" -le "$MAX_BYTES" ] || { echo "크기 이상: ${size}바이트" >&2; exit 1; }

# 검사 + 200건씩 나눈 POST 본문 만들기. 출력: generatedAt commit 건수
read -r GEN COMMIT N < <(python3 - "$W" <<'PY'
import json, sys, os, re
from datetime import datetime
w = sys.argv[1]
d = json.load(open(os.path.join(w, "latest.json"), encoding="utf-8"))
assert isinstance(d, dict), "최상위가 객체가 아님"
gen = d.get("generatedAt"); commit = d.get("commit"); results = d.get("results")
assert isinstance(gen, str) and datetime.fromisoformat(gen.replace("Z", "+00:00")).tzinfo, "generatedAt(시간대 있는 ISO 시각) 없음"
assert isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{7,40}(-dirty)?", commit), "commit(검증 코드 커밋, 커밋 안 된 변경이 있으면 -dirty) 없음"
assert isinstance(results, list) and 0 < len(results) <= 5000, "results 배열(1~5,000건) 아님"
for i, r in enumerate(results):
    assert isinstance(r, dict), f"results[{i}] 객체 아님"
    for k in ("market", "symbol", "runAt"):
        assert isinstance(r.get(k), str) and r[k], f"results[{i}].{k} 없음"
    assert isinstance(r.get("counts"), dict), f"results[{i}].counts 없음"
    for k in ("fails", "unverifiable", "external", "errors"):
        assert isinstance(r.get(k, []), list), f"results[{i}].{k} 배열 아님"
    r.setdefault("commit", commit)
    r.setdefault("base", "2호기 verify-dev")
for j in range(0, len(results), 200):
    json.dump({"results": results[j:j + 200]}, open(os.path.join(w, f"chunk-{j // 200:04d}.json"), "w", encoding="utf-8"), ensure_ascii=False)
print(gen, commit, len(results))
PY
) || { echo "형식 검사 실패" >&2; exit 1; }
echo "검사 통과: 생성 ${GEN} · 판본 ${COMMIT:0:7} · ${N}종목"

if [ "${VERIFY_PULL_DRYRUN:-0}" = 1 ]; then echo "(시험 — 반영 안 함)"; exit 0; fi
if [ "$(cat "$STATE/.verify-pull-generated" 2>/dev/null)" = "$GEN" ]; then
  echo "이미 반영한 결과(생성 ${GEN}) — 건너뜀"; touch "$STATE/.verify-pull-ok"; exit 0
fi

saved=0; older=0
for f in "$W"/chunk-*.json; do
  code=$(curl -s -o "$W/resp.json" -w "%{http_code}" -m 120 -X POST -H "Authorization: Bearer ${SECRET}" \
    -H "content-type: application/json" --data-binary "@$f" http://127.0.0.1:8080/api/cron/verify-results)
  [ "$code" = 200 ] || { echo "반영 실패 HTTP ${code}: $(head -c 300 "$W/resp.json")" >&2; exit 1; }
  read -r s rj ol < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("saved",0), d.get("rejected",0), d.get("older",-1))' "$W/resp.json")
  [ "$rj" = 0 ] || { echo "수신 라우트가 ${rj}건 거부: $(head -c 300 "$W/resp.json")" >&2; exit 1; }
  [ "$ol" -ge 0 ] || { echo "운영 앱이 runAt 비교(older)를 모르는 판본 — 배포 후 다시" >&2; exit 1; }
  saved=$((saved + s)); older=$((older + ol))
done
[ $((saved + older)) = "$N" ] || { echo "반영 건수 불일치: 반영 ${saved} + 운영이 더 새것 ${older} ≠ ${N}" >&2; exit 1; }
echo "$GEN" > "$STATE/.verify-pull-generated"
touch "$STATE/.verify-pull-ok"
echo "반영 완료 ${saved}종목(운영 쪽이 더 새 결과라 건너뜀 ${older})"
