/**
 * TS 스크립트 실행기 — `node scripts/fin/run.mjs scripts/fin/build.ts [인자…]`.
 * tsx 가 없어 이미 설치된 jiti(next 의존성)로 TS 를 바로 실행한다. `@/` 경로 별칭과 `server-only`(스크립트에서는
 * 빈 모듈)를 풀어 주고, `.env.local` 을 읽는다. SEC 원본은 `FIN_SEC_CACHE_DIR`(기본 .omc/tmp/sec-cache)에 캐시해
 * 같은 원본을 다시 받지 않는다(src/lib/fin/source/us/sec.ts).
 */
import { createJiti } from "jiti";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const envFile = resolve(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.FIN_SEC_CACHE_DIR ??= resolve(root, ".omc/tmp/sec-cache");

const target = process.argv[2];
if (!target) {
  console.error("사용법: node scripts/fin/run.mjs <스크립트.ts> [인자…]");
  process.exit(2);
}
process.argv.splice(2, 1);
const jiti = createJiti(import.meta.url, {
  alias: { "@": resolve(root, "src"), "server-only": resolve(root, "node_modules/server-only/empty.js") },
});
await jiti.import(pathToFileURL(resolve(process.cwd(), target)).href);
