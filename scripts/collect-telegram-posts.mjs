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
  ENV.TELEGRAM_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/telegram-posts"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
// 한 번에 받아 오는 최대 건수. 아래 이어받기가 이 값을 넘어가는 공백도
// 페이지를 넘겨가며 채우므로, 이건 "한 요청당" 상한일 뿐이다.
const LIMIT_PER_CHANNEL = 50;
// 이어받기 안전장치 — 채널당 이만큼 받으면 멈춘다(첫 실행이거나 커서가
// 아주 오래됐을 때 무한정 거슬러 올라가지 않게). 보관이 90일이라 넉넉하다.
const MAX_CATCHUP_PER_CHANNEL = 500;

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

/**
 * 채널별로 이미 받아 둔 마지막 글 번호를 서버에서 받아 온다. 실패하면 빈
 * 객체 — 그 경우 예전처럼 최신 LIMIT_PER_CHANNEL 건만 가져간다(수집이 아예
 * 멈추는 것보다 낫다).
 */
async function fetchCursors() {
  const headers = {};
  if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
  try {
    const res = await fetch(IMPORT_URL, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body.cursors ?? {};
  } catch (err) {
    console.log("커서 조회 실패 — 최신분만 받습니다:", err.message ?? err);
    return {};
  }
}

/**
 * `minId` 뒤의 글을 페이지를 넘겨가며 전부 받는다. gramjs 의 `getMessages` 는
 * 최신부터 내려주므로, 가장 오래된 글 번호를 `maxId` 로 넘겨 더 과거로
 * 내려가며 `minId` 에 닿을 때까지 반복한다.
 *
 * `minId` 가 없으면(첫 수집) 최신 한 페이지만 받는다 — 채널 전체를 처음부터
 * 긁지 않기 위해서다.
 */
async function fetchSince(client, entity, minId) {
  const all = [];
  let maxId = 0; // 0 = 제한 없음(최신부터)
  for (let page = 0; page < Math.ceil(MAX_CATCHUP_PER_CHANNEL / LIMIT_PER_CHANNEL); page++) {
    const opts = { limit: LIMIT_PER_CHANNEL };
    if (maxId) opts.maxId = maxId;
    if (minId) opts.minId = minId;
    const batch = await client.getMessages(entity, opts);
    if (batch.length === 0) break;
    all.push(...batch);
    if (!minId) break; // 첫 수집 — 최신 한 페이지로 충분
    if (batch.length < LIMIT_PER_CHANNEL) break; // 공백을 다 채웠다
    maxId = Math.min(...batch.map((m) => m.id));
    if (maxId <= minId + 1) break;
  }
  return all;
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

  // 채널별 마지막 글 번호 — 이 뒤부터만 이어받는다
  const cursors = await fetchCursors();
  const seen = Object.entries(cursors)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  console.log(seen ? `커서: ${seen}` : "커서 없음 — 최신분만 받습니다");

  for (const ch of channels) {
    const username = usernameFromTelegramUrl(ch.url);
    if (!username) {
      console.log(`[skip] ${ch.name}: telegram URL에서 username을 못 찾음 (${ch.url})`);
      continue;
    }
    try {
      const entity = await client.getEntity(username);
      const minId = cursors[username] ?? 0;
      const messages = await fetchSince(client, entity, minId);
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
      console.log(
        `[${ch.name}] @${username} — ${items.length}건 전송` +
          (minId ? ` (글 ${minId} 이후 이어받기)` : " (첫 수집)"),
        "결과:",
        result,
      );
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
