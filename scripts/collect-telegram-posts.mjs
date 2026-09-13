/**
 * 텔레그램 채널 게시물 — 로컬 수집기(개인 계정 세션 사용).
 *
 * ⚠️ scripts/telegram-login.mjs 로 만든 세션(.env.local 의 TELEGRAM_SESSION)은
 *    계정 전체 권한이다. 이 스크립트는 로컬에서만 실행하고, 배포 앱(Vercel)에는
 *    이 세션이 절대 올라가지 않는다 — 여기서 읽은 결과만 /api/cron/telegram-posts
 *    로 POST해서 DB에 적재하고, 배포 앱은 그 DB를 조회만 한다(다른 리서치
 *    수집기와 동일 원칙).
 *
 * 대상 채널은 src/lib/influencers/influencers.md 의 `telegram:` 줄에서
 * 읽는다(예: `telegram: https://t.me/insidertracking`) — 채널 목록을 여기와
 * md 파일 두 곳에 따로 관리하지 않기 위함.
 *
 * 실행: node scripts/collect-telegram-posts.mjs
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

const ENV = loadEnvLocal();
const IMPORT_URL = (
  ENV.TELEGRAM_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/telegram-posts"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const LIMIT_PER_CHANNEL = 10;

function parseTelegramChannels(mdText) {
  const blocks = mdText.split(/^##[ \t]+/m).slice(1);
  const out = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const name = lines[0].trim();
    for (const line of lines.slice(1)) {
      const m = line.match(/^\s*telegram\s*:\s*(\S+)/i);
      if (m) out.push({ name, url: m[1] });
    }
  }
  return out;
}

function usernameFromTelegramUrl(url) {
  const m = url.match(/t\.me\/([\w.]+)/i);
  return m ? m[1] : null;
}

async function postItems(channelUsername, channelTitle, items) {
  const headers = { "content-type": "application/json" };
  if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
  const res = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ channelUsername, channelTitle, items }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST 실패 (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const apiId = Number(ENV.TELEGRAM_API_ID);
  const apiHash = ENV.TELEGRAM_API_HASH;
  const sessionString = ENV.TELEGRAM_SESSION;
  if (!apiId || !apiHash || !sessionString) {
    console.error(
      "TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION 이 .env.local 에 없습니다. 먼저 node scripts/telegram-login.mjs 를 실행하세요.",
    );
    process.exit(1);
  }

  const mdText = readFileSync(new URL("../src/lib/influencers/influencers.md", import.meta.url), "utf8");
  const channels = parseTelegramChannels(mdText);
  if (channels.length === 0) {
    console.log("influencers.md 에 telegram: 항목이 없습니다.");
    return;
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.connect();

  for (const ch of channels) {
    const username = usernameFromTelegramUrl(ch.url);
    if (!username) {
      console.log(`[skip] ${ch.name}: telegram URL에서 username을 못 찾음 (${ch.url})`);
      continue;
    }
    try {
      const entity = await client.getEntity(username);
      const messages = await client.getMessages(entity, { limit: LIMIT_PER_CHANNEL });
      const items = messages
        .filter((m) => m.message && m.message.trim())
        .map((m) => ({
          messageId: String(m.id),
          text: m.message.slice(0, 500),
          publishedAt: new Date(m.date * 1000).toISOString(),
        }));
      if (items.length === 0) {
        console.log(`[${ch.name}] 게시물 없음`);
        continue;
      }
      const result = await postItems(username, entity.title ?? ch.name, items);
      console.log(`[${ch.name}] @${username} — ${items.length}건 전송, 결과:`, result);
    } catch (err) {
      console.error(`[${ch.name}] 실패:`, err.message ?? err);
    }
  }

  await client.disconnect();
  // client.disconnect() 직후 process.exit() 을 호출하면(setImmediate로 한 틱
  // 미뤄도) gramjs 의 웹소켓 네이티브 애드온(bufferutil/utf-8-validate) 핸들
  // 정리가 안 끝난 상태에서 강제 종료돼 네이티브 assertion 크래시가 남(Windows
  // 실측, 2026-09). process.exit() 을 안 부르고 exitCode 만 지정해 이벤트
  // 루프가 자연 종료되게 둔다 — 혹시 남는 타이머가 있을 때를 대비해 5초
  // 하드 타임아웃만 안전망으로 둔다(unref로 정상 종료를 막지 않음).
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 5000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
