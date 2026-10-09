#!/usr/bin/env bash
# GitHub 예약에서 옮겨 온 수집 작업의 systemd 타이머를 만든다(2026-10-04). 다시 돌려도 같은 결과(덮어씀).
# 빈도·근거는 docs/data-collection.md. 시각은 전부 KST. 분은 GitHub 시절 값을 그대로 써 사이트·작업끼리 겹치지 않게 했다.
# 사용: sudo bash install-schedules.sh
set -euo pipefail
U=/etc/systemd/system
unit() { # unit <이름> <설명> <실행> <OnCalendar 줄들(\n 구분)>
  local name="$1" desc="$2" exec="$3" cal="$4"
  printf '[Unit]\nDescription=%s\nAfter=docker.service\n[Service]\nType=oneshot\nExecStart=%s\nNice=10\nTimeoutStartSec=50min\n' "$desc" "$exec" > "$U/$name.service"
  { printf '[Unit]\nDescription=%s 예약\n[Timer]\n' "$desc"; printf '%b' "$cal" | while read -r c; do [ -n "$c" ] && echo "OnCalendar=$c Asia/Seoul"; done; printf 'Persistent=true\n[Install]\nWantedBy=timers.target\n'; } > "$U/$name.timer"
  echo "$name"
}
six() { local m="$1" out=""; for h in 08 10 12 14 16 18; do out+="*-*-* $h:$m:00\n"; done; printf '%s' "$out"; }

# ① 국내 리서치 — 하루 6회(첫 회 넓게, 나머지 최근 1일)
while read -r name min; do
  [ -z "$name" ] && continue
  unit "research-$name" "리서치(국내): $name" "/opt/macro/ops/run-research.sh collect-$name.mjs" "$(six "$min")"
done <<'LIST'
shinhan-research 00
daol-research 06
sangsangin-research 02
sangsangin-industry-research 04
hana-research 10
nh-research 12
ibk-research 14
kiwoom-research 16
mirae-research 18
hanwha-research 20
samsung-research 22
yuanta-research 24
kb-research 26
daishin-research 28
im-research 30
meritz-research 35
kyobo-research 40
kis-research 45
hankyung-research 50
globalmonitor-research 55
ds-research 57
LIST

# ① 해외 IB·운용사 — 하루 1회
while read -r name hm; do
  [ -z "$name" ] && continue
  unit "research-$name" "리서치(해외 IB): $name" "/opt/macro/ops/run-script.sh collect-$name.mjs" "*-*-* $hm:00\n"
done <<'LIST'
blackrock-research 08:05
goldman-research 08:10
jpmorgan-research 08:15
morganstanley-research 08:20
pimco-research 08:25
bnpparibas-research 08:30
citigroup-research 08:35
boa-research 08:40
hsbc-research 08:45
dbresearch 08:52
LIST

# ① 일본 현지 리서치 — FISCO 企業調査レポート 하루 1회(2026-10-10 오너 승인, 메타·PDF 링크만). 목록 한 장 1요청.
#   일본 장 마감 뒤(18:40 KST = 같은 시각 JST) — 그날 공개분까지 받는다. 수집기 기본 범위 3일.
unit research-fisco-research "리서치(일본): fisco-research" "/opt/macro/ops/run-script.sh collect-fisco-research.mjs" "*-*-* 18:40:00\n"
#   Shared Research — 약관 위험 예외(오너 결정 2026-10-10, CLAUDE.md 예외 7건). 공개 목록 페이지 1요청, 내부 API 안 씀.
unit research-sharedresearch-research "리서치(일본): sharedresearch-research" "/opt/macro/ops/run-script.sh collect-sharedresearch-research.mjs" "*-*-* 18:45:00\n"

# ② 거시경제 — Fed 금리 확률 일별 스냅샷(06:00)
unit macro-fedwatch-snapshot "거시경제: Fed 금리 확률 일별 스냅샷(Kalshi)" "/opt/macro/ops/call-cron.sh /api/cron/fedwatch 120" "*-*-* 06:00:00\n"
# ② 거시경제 — 한국 공포·탐욕 원자료 + 코스피·코스닥 일봉(06:30, 전 영업일분). 예전엔 서버에서 손으로 만든 유닛이라 저장소에 없었다(2026-10-06 편입).
#   KRX OPEN API 가 아직 안 냈으면 앱이 200 + {ok:false, retry:true} 를 준다 → call-cron.sh 가 아래 재시도 타이머(1시간 뒤 1회)를 건다.
#   재시도 서비스는 CRON_RETRY_TIMER 없이 돌아 또 실패하면 그대로 실패 → healthcheck(job-macro-kr-fg-retry)가 알린다. 휴장일(holiday:true)은 정상.
# 2026-10-09: 06:30 → 08:20. KRX 전 거래일 시세는 다음 날 07:55~08:00 공개(실측 이슈 #16) — 06:30·재시도 07:30 모두 빈 응답이라 매일 거짓 실패가 났다.
unit macro-kr-fg "거시경제: 한국 공포·탐욕 원자료 + 지수 일봉(전 영업일분)" "/usr/bin/env CRON_RETRY_TIMER=macro-kr-fg-retry.timer /opt/macro/ops/call-cron.sh /api/cron/kr-fg 600" "*-*-* 08:20:00\n"
cat > "$U/macro-kr-fg-retry.service" <<'EOF'
[Unit]
Description=거시경제: 한국 공포·탐욕 원자료 재시도(KRX 미공개 시 1회)
After=docker.service
[Service]
Type=oneshot
ExecStart=/opt/macro/ops/call-cron.sh /api/cron/kr-fg 600
Nice=10
TimeoutStartSec=50min
EOF
# 평소엔 꺼져 있고 call-cron.sh 가 restart 로 켠다 — 켜진 뒤 1시간에 한 번 울리고 꺼진다(RemainAfterElapsed=no: 다음 날 다시 걸 수 있게). [Install] 없음.
cat > "$U/macro-kr-fg-retry.timer" <<'EOF'
[Unit]
Description=거시경제: 한국 공포·탐욕 원자료 재시도 1시간 뒤
[Timer]
OnActiveSec=1h
RemainAfterElapsed=no
Unit=macro-kr-fg-retry.service
EOF
# ④ 종목분석 — StockAnalysis 개별 애널리스트 투자의견(하루 1회 10:20)
unit fin-analyst-forecasts "종목분석: StockAnalysis 애널리스트 투자의견" "/opt/macro/ops/run-script.sh collect-analyst-forecasts.mjs" "*-*-* 10:20:00\n"
# ③ 종목뉴스 미리 수집 — 10분마다 깨우고 종목별 신선도(한국 장중 10분·미국 장중 30분·장외 1시간)가 지난 것만 받는다(판정은 규칙, 비용 0)
unit news-stock-news "뉴스: 유니버스 종목뉴스 미리 수집" "/opt/macro/ops/call-cron.sh /api/cron/stock-news 290" "*-*-* *:00/10:00\n"
# ③ 인플루언서 네이버 블로그 새 글 — 5분마다 RSS 확인, 새 글만 DB(naver_blog_posts)에 저장(오너 2026-10-05, 오라클에서 직접 DB 쓰기 — 운영 앱 CPU 안 씀)
unit news-naver-blog "뉴스: 인플루언서 네이버 블로그 새 글 수집" "/opt/macro/ops/run-ts.sh naver-blog-poll.mts" "*-*-* *:00/5:00
"
sed -i 's/^TimeoutStartSec=.*/TimeoutStartSec=4min/' "$U/news-naver-blog.service" # 5분 주기라 멈춘 실행은 다음 회차 전에 정리
# ② 거시경제 — 브라질 국채 NTN-F ~10년 중간값(ANBIMA 지표 > 재무부 CSV (매수+매도)/2 — 4번과 같은 정의, 07:10 KST 수집, 새 날짜만 DB br_ntnf_daily). 2026-10-06 4번 저장소 의존 제거
unit macro-br-ntnf "거시경제: 브라질 국채 NTN-F 10년(ANBIMA·재무부 CSV)" "/opt/macro/ops/run-ts.sh ntnf-daily.mts" "*-*-* 07:10:00\n"
sed -i 's/^TimeoutStartSec=.*/TimeoutStartSec=15min/' "$U/macro-br-ntnf.service"
# ⑤ 주간 리포트 초안 — 월~금 08:30 에 깨우고 그 주 첫 한국 거래일에만 생성(월요일 휴장이면 화요일, 오너 2026-10-05). 08:30 = KRX 전 거래일 시세 07:55~08:00 공개 뒤(실측 #16, 오너 2026-10-09)
unit weekly-report "주간 리포트 초안 생성" "/opt/macro/ops/call-cron.sh /api/cron/weekly-report 330 '{\"force\":false,\"auto\":true}'" "Mon..Fri *-*-* 08:30:00\n"
# ④ 일본 EDINET 공시 목록·재무 보고서 색인(jp_docs) — 최근 10일만 다시 받아 확정(일본 화면은 색인이 빠진 날이 있으면 옛 표 대신 오류, 2026-10-09)
unit fin-jp-edinet-index "종목분석: 일본 EDINET 공시 색인" "/opt/macro/ops/run-ts.sh jp-edinet-index.mts --days=10 --no-samples" "*-*-* 08:30:00\n*-*-* 20:30:00\n"

# ④ 종목분석 — 새 유니버스 종목 미리 계산(오너 승인 2026-10-06): 5분마다 대기열(precompute_queue)을 보고 전 계정 처음 담긴 종목만
#    미국 재무 조립·TTM(회차당 10), 한국 감가상각 적재(fin-kr-da 설치 뒤, 회차당 5·24시간 30). 정기 배치가 돌고 있으면 쉰다. 실행기 설치는 post-deploy.sh
install -m 755 "$(dirname "$(readlink -f "$0")")/run-precompute.sh" /opt/macro/ops/run-precompute.sh
unit fin-precompute "종목분석: 새 유니버스 종목 미리 계산" "/opt/macro/ops/run-precompute.sh" "*-*-* *:02/5:00
"

systemctl daemon-reload
for t in "$U"/research-*.timer "$U"/macro-fedwatch-snapshot.timer "$U"/macro-br-ntnf.timer "$U"/macro-kr-fg.timer "$U"/fin-analyst-forecasts.timer "$U"/weekly-report.timer "$U"/news-stock-news.timer "$U"/news-naver-blog.timer "$U"/fin-jp-edinet-index.timer "$U"/fin-precompute.timer; do
  systemctl enable --now "$(basename "$t")" >/dev/null
done
systemctl list-timers --no-pager | grep -cE "research-|fedwatch-snapshot|br-ntnf|macro-kr-fg|analyst-forecasts|weekly-report|news-stock-news|news-naver-blog|jp-edinet-index|fin-precompute" | sed 's/^/타이머 수: /'
