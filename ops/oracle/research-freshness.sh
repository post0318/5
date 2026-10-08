#!/usr/bin/env bash
# 출처별 데이터 신선도 점검(하루 1회, macro-research-freshness 타이머 — 2026-10-06 전수조사 구멍 #5).
# scripts/db/research-freshness.mjs 를 작업 폴더 컨테이너로 돌려(읽기 전용) 결과를 /var/lib/macro-health/research-freshness.json 에 남긴다.
# 10분마다 도는 healthcheck.sh 는 이 파일만 읽어 오래된 출처를 묶음 알림 한 건으로 연다(DB 는 하루 한 번만 읽는다).
#   - /opt/macro/ops/freshness-ignore.txt: 원래 드물거나 의도적으로 멈춘 출처 이름(한 줄에 하나) — 오래됨 목록에서 뺀다(오너 결정 시)
#   - /var/lib/macro-health/.freshness-known.json: 지금까지 본 출처와 마지막 날. 보존기간이 지나 DB 에서 통째로 사라진 출처도
#     "DB 에서 사라짐"으로 계속 잡는다(지우려면 이 파일에서 그 이름을 빼거나 ignore 에 넣는다)
set -uo pipefail
S=/var/lib/macro-health
mkdir -p "$S"
OUT=$(mktemp)
if ! /opt/macro/ops/run-script.sh db/research-freshness.mjs --json > "$OUT"; then
  echo "신선도 점검 실행 실패"; rm -f "$OUT"; exit 1
fi
python3 - "$OUT" "$S/.freshness-known.json" /opt/macro/ops/freshness-ignore.txt "$S/research-freshness.json" <<'PY' || { rm -f "$OUT"; exit 1; }
import json, os, sys
out, known_path, ignore_path, dest = sys.argv[1:5]
lines = [l for l in open(out, encoding="utf-8").read().splitlines() if l.startswith("{")]
r = json.loads(lines[-1])
try:
    known = json.load(open(known_path, encoding="utf-8"))
except Exception:
    known = {}
try:
    ignore = {l.strip() for l in open(ignore_path, encoding="utf-8") if l.strip() and not l.startswith("#")}
except Exception:
    ignore = set()
seen = {x["source"] for x in r["results"]}
for name, last in known.items():
    if name not in seen:
        r["results"].append({"kind": "research", "source": name, "last": last, "ageBd": None, "thresholdBd": None, "stale": True, "gone": True})
for x in r["results"]:
    if x.get("last"):
        known[x["source"]] = x["last"]
    x["ignored"] = x["source"] in ignore
r["stale"] = sum(1 for x in r["results"] if x["stale"] and not x["ignored"])
json.dump(known, open(known_path + ".tmp", "w", encoding="utf-8"), ensure_ascii=False)
os.replace(known_path + ".tmp", known_path)
json.dump(r, open(dest + ".tmp", "w", encoding="utf-8"), ensure_ascii=False)
os.replace(dest + ".tmp", dest)
print(f"신선도 점검 {r['today']}: {r['checked']}개 중 오래됨 {r['stale']}개")
for x in r["results"]:
    if x["stale"] and not x["ignored"]:
        print(f"  - {x['source']} 마지막 {x.get('last')} " + ("DB 에서 사라짐(보존기간 지남)" if x.get("gone") else f"경과 {x.get('ageBd')}영업일 기준 {x.get('thresholdBd')}"))
PY
rm -f "$OUT"
