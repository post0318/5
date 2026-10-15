/**
 * 실행 환경 — 프로세스 환경변수 + (있으면) 저장소 .env.local. 2호기는 ~/5/.env.local 을 공용으로 쓴다(VERIFY_ENV_FILE 로 바꿀 수 있음).
 * RAW_STORE_DIR 은 필수(공유 원본 보관소 루트).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadEnv() {
  const file = process.env.VERIFY_ENV_FILE ?? [join(process.cwd(), ".env.local"), join(homedir(), "5", ".env.local")].find((p) => existsSync(p));
  const fromFile = {};
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) fromFile[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  }
  const env = { ...fromFile, ...process.env };
  if (!env.RAW_STORE_DIR) throw new Error("RAW_STORE_DIR 를 지정하라(2호기 /home/ubuntu/raw-store)");
  return env;
}
