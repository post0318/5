/**
 * telegram-login.mjs 로 세션을 만든 뒤, 어떤 채팅을 가져올지 고르기 위해
 * 참여 중인 채팅 목록(id/종류/이름)을 출력한다.
 *
 * 실행: node scripts/telegram-list-chats.mjs
 */
import { readFileSync } from "node:fs";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

function loadEnvLocal() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
      if (m && (env[m[1]] === undefined || env[m[1]] === "")) env[m[1]] = m[2];
    }
  } catch {
    /* .env.local 없어도 됨 */
  }
  return env;
}

async function main() {
  const ENV = loadEnvLocal();
  const apiId = Number(ENV.TELEGRAM_API_ID);
  const apiHash = ENV.TELEGRAM_API_HASH;
  const sessionString = ENV.TELEGRAM_SESSION;
  if (!apiId || !apiHash || !sessionString) {
    console.error(
      "TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION 이 .env.local 에 없습니다. 먼저 node scripts/telegram-login.mjs 를 실행하세요.",
    );
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.connect();

  const dialogs = await client.getDialogs({ limit: 100 });
  console.log("id\t종류\t이름");
  for (const d of dialogs) {
    const kind = d.isChannel ? "채널" : d.isGroup ? "그룹" : "개인";
    console.log(`${d.id}\t${kind}\t${d.title ?? d.name ?? ""}`);
  }

  await client.disconnect();
  // process.exit() 을 직접 부르면 gramjs 웹소켓 네이티브 애드온 핸들 정리가
  // 안 끝난 상태에서 강제 종료돼 크래시가 남(Windows 실측, 2026-09) — exitCode만
  // 지정해 자연 종료시키고, 혹시 남는 타이머 대비 5초 하드 타임아웃만 안전망으로.
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 5000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
