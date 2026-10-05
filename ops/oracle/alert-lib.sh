# 오라클 1·2호기 점검 공용 알림 함수(2026-10-05, 상호 감시 — healthcheck.sh·healthcheck-peer.sh 가 source 한다).
# 항목마다 상태 파일을 두고 "정상 → 문제" 로 바뀔 때만 알림을 열고, "문제 → 정상" 이면 닫는다:
#   - GitHub 이슈(라벨 ops-alert, 제목 "[ops-alert][N호기] 항목키: 내용")
#   - 텔레그램 봇 메시지
# 부르는 쪽이 먼저 정할 것: STATE_DIR, ALERT_TAG(예: 1호기), ALERT_SOURCE(예: healthcheck.sh), HOST, DOMAIN,
#   OPS_TG_BOT_TOKEN·OPS_TG_CHAT_ID·OPS_GH_TOKEN·OPS_GH_REPO(alert.env)
GH_REPO="${OPS_GH_REPO:-post0318/5}"

tg() {
  [ -n "${OPS_TG_BOT_TOKEN:-}" ] && [ -n "${OPS_TG_CHAT_ID:-}" ] || return 0
  curl -fsS -m 15 -o /dev/null "https://api.telegram.org/bot${OPS_TG_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${OPS_TG_CHAT_ID}" --data-urlencode "text=$1" || true
}

gh_api() { # method path [json]
  [ -n "${OPS_GH_TOKEN:-}" ] || return 1
  local extra=()
  [ -n "${3:-}" ] && extra=(-H "Content-Type: application/json" -d "$3")
  curl -fsS -m 20 -X "$1" "https://api.github.com/repos/${GH_REPO}$2" \
    -H "Authorization: Bearer ${OPS_GH_TOKEN}" -H "Accept: application/vnd.github+json" "${extra[@]}"
}

json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

open_alert() { # key message
  local key="$1" msg="$2" num
  tg "🚨 [${ALERT_TAG} ${HOST}] ${key}: ${msg}"
  num=$(gh_api POST /issues "{\"title\":$(json_str "[ops-alert][${ALERT_TAG}] ${key}: ${msg}"),\"labels\":[\"ops-alert\"],\"body\":$(json_str "${ALERT_TAG} 점검(${ALERT_SOURCE})이 $(date -Is) 에 감지했습니다.

- 항목: ${key}
- 내용: ${msg}
- 서버: ${ALERT_TAG} ${HOST} (${DOMAIN})

정상으로 돌아오면 이 이슈는 자동으로 닫힙니다.")}" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["number"])' 2>/dev/null)
  echo "${num:-0}" > "$STATE_DIR/$key"
}

close_alert() { # key
  local key="$1" num
  num=$(cat "$STATE_DIR/$key" 2>/dev/null || echo 0)
  tg "✅ [${ALERT_TAG} ${HOST}] ${key}: 정상으로 돌아왔습니다"
  if [ "${num:-0}" != "0" ]; then
    gh_api POST "/issues/${num}/comments" "{\"body\":$(json_str "$(date -Is) 정상 복귀 확인 — 자동으로 닫습니다.")}" >/dev/null 2>&1
    gh_api PATCH "/issues/${num}" '{"state":"closed"}' >/dev/null 2>&1
  fi
  rm -f "$STATE_DIR/$key"
}

check() { # key ok(0/1) message
  local key="$1" ok="$2" msg="$3"
  if [ "$ok" = 0 ]; then
    [ -f "$STATE_DIR/$key" ] || open_alert "$key" "$msg"
  else
    [ -f "$STATE_DIR/$key" ] && close_alert "$key"
  fi
  return 0
}

# 상대 서버 감시용 — 연속 2회(20분) 실패해야 알림을 연다(일시적인 네트워크 오류 거르기). 복구는 1회 성공으로 닫는다.
check2() { # key ok(0/1) message
  local key="$1" ok="$2" msg="$3" f="$STATE_DIR/.fail-$1" n
  if [ "$ok" = 0 ]; then
    n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$f"
    [ "$n" -ge 2 ] && check "$key" 0 "$msg (연속 ${n}회)"
  else
    rm -f "$f"
    check "$key" 1 "$msg"
  fi
  return 0
}

run_test() { # healthcheck.sh --test — 텔레그램 메시지 + GitHub 이슈를 열었다 바로 닫는다(알림 경로 확인용)
  open_alert test "알림 시험 발송입니다(조치 불필요)"
  sleep 2
  close_alert test
  echo "시험 발송 완료(텔레그램 2건 + GitHub 이슈 열고 닫음)"
}
