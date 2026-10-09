// 1호기 배치 컨테이너(ops/oracle/run-ts.sh·run-script.sh)가 NODE_OPTIONS=--import 로 먼저 실행한다 — 외부 서비스 사용량 장부를 켠다
// (src/lib/usage/ledger.mjs). 배치 역할이라 그날 서비스 상한에 닿으면 이 프로세스의 그 서비스 요청은 UsageLimitError 로 막힌다.
// USAGE_DIR 이 없으면 아무것도 하지 않는다.
import { installUsageFetch } from "../../src/lib/usage/ledger.mjs";

if (!process.env.USAGE_ROLE) process.env.USAGE_ROLE = "batch";
installUsageFetch();
