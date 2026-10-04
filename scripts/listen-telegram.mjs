/**
 * 텔레그램 채널 상주 수신기 — 새 글이 올라오는 즉시 받아 /api/cron/telegram-posts 로 보낸다(2026-10-03 오너 지시 "즉시 적용").
 *
 * 예전엔 GitHub Actions 가 매시간 접속 → 받기 → 끊기를 반복했는데, GitHub 예약 누락(실행률 21%)으로 몇 시간씩 비었고
 * cron-job.org 재기동 + 5시간 30분 반복 루프 같은 우회책이 필요했다. 오라클 서버에서 연결을 계속 열어 두면 텔레그램이
 * 새 메시지를 바로 밀어준다(일반 텔레그램 앱이 켜져 있는 것과 같은 방식이라 접속을 반복하는 것보다 차단 위험이 낮다).
 *
 * - 시작할 때: 채널별 커서 뒤의 글을 이어받는다(꺼져 있던 동안 놓친 글 보충) — collect-telegram-posts.mjs 와 같은 함수.
 * - 실행 중: NewMessage 이벤트로 새 글을 바로 보낸다.
 * - 안전망: 30분마다 이어받기를 한 번 더 돈다(이벤트를 놓쳤을 때 대비 — 같은 연결로 하므로 재접속 없음).
 * ⚠️ 같은 세션(TELEGRAM_SESSION)을 다른 곳(GitHub 수집기 등)과 동시에 쓰면 세션이 끊길 수 있다 — 이 수신기를 켜면 다른 수집은 끈다.
 *
 * 실행: node scripts/listen-telegram.mjs (오라클: systemd 서비스 macro-telegram-listener)
 */
import { readFileSync } from "node:fs";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import {
  fetchCursors,
  fetchSince,
  parseTelegramChannels,
  postItems,
  usernameFromTelegramUrl,
} from "./collect-telegram-posts.mjs";

// 2분마다 이어받기 — 텔레그램이 이 접속에 새 글 알림을 아예 보내지 않는다(2026-10-04 실측: getState 를 불러도 9시간 동안 이벤트 0건,
// 다른 대화 이벤트도 0건 — 큰 공개 채널은 서버가 알림을 생략하고, gramjs 는 채널 차이 보충(getChannelDifference)을 하지 않는다).
// 같은 연결에서 채널 2곳 최근 글만 묻는 가벼운 요청이라 재접속 반복과 달리 차단 위험이 낮다. 알림이 오면 그쪽이 먼저 보낸다.
const CATCHUP_EVERY_MS = 2 * 60_000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const toItem = (m) => ({
  messageId: String(m.id),
  text: m.message.slice(0, 500),
  publishedAt: new Date(m.date * 1000).toISOString(),
});

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const session = process.env.TELEGRAM_SESSION;
  if (!apiId || !apiHash || !session) throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION 필요");

  const md = readFileSync(new URL("../src/lib/influencers/influencers.md", import.meta.url), "utf8");
  const channels = parseTelegramChannels(md)
    .map((c) => ({ ...c, username: usernameFromTelegramUrl(c.url) }))
    .filter((c) => c.username);
  if (!channels.length) throw new Error("influencers.md 에 telegram: 항목이 없습니다");

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 10, autoReconnect: true });
  await client.connect();
  // 어느 계정으로 붙었는지(채널 가입 여부 확인용 — 아이디·이름 일부만) + 새 소식 받기 요청. 텔레그램 서버는 접속한 프로그램이
  // updates.getState 를 한 번 불러야 새 글 알림을 보내기 시작한다(휴대폰 앱은 자동) — 접속만 하면 연결은 살아도 알림이 0건이었다(2026-10-04).
  const me = await client.getMe();
  log(`계정 id …${String(me?.id ?? "").slice(-4)} · ${me?.username ? "@" + me.username.slice(0, 3) + "…" : "(아이디 없음)"}`);
  await client.invoke(new Api.updates.GetState());

  // 채널 엔티티·제목
  const byId = new Map();
  for (const ch of channels) {
    const entity = await client.getEntity(ch.username);
    ch.entity = entity;
    ch.title = entity.title ?? ch.name;
    byId.set(String(entity.id), ch);
  }
  log(`연결됨 — 채널 ${channels.map((c) => "@" + c.username).join(", ")}`);

  const catchUp = async (why) => {
    const cursors = await fetchCursors();
    for (const ch of channels) {
      try {
        const minId = cursors[ch.username] ?? 0;
        const items = (await fetchSince(client, ch.entity, minId)).filter((m) => m.message?.trim()).map(toItem);
        if (items.length) {
          const r = await postItems(ch.username, ch.title, items);
          log(`[이어받기:${why}] @${ch.username} ${items.length}건`, JSON.stringify(r));
        }
      } catch (e) {
        log(`[이어받기:${why}] @${ch.username} 실패:`, e?.message ?? e);
      }
    }
  };

  await catchUp("시작");

  // 채널 번호 맞추기 — event.chatId 는 채널이면 "-100<id>" 형태라 entity.id 와 그대로는 안 맞는다(2026-10-04 실측: 5시간 동안 즉시 수신 0건,
  // 전부 30분 이어받기로만 들어옴). peerId.channelId(원래 번호)를 먼저 쓰고, 없으면 -100 접두어를 뗀다.
  const chanKey = (event, m) => {
    const raw = String(m?.peerId?.channelId ?? event.chatId ?? "");
    return raw.replace(/^-100/, "").replace(/^-/, "");
  };
  // 이벤트가 오기는 하는지 진단용 — 1시간마다 받은 이벤트 수(우리 채널 / 그 밖)를 남긴다
  let evOurs = 0, evOther = 0;
  setInterval(() => {
    log(`[진단] 지난 1시간 새 글 이벤트: 우리 채널 ${evOurs}건 · 그 밖 ${evOther}건`);
    evOurs = 0;
    evOther = 0;
  }, 3600_000);

  client.addEventHandler(async (event) => {
    const m = event.message;
    const ch = byId.get(chanKey(event, m));
    if (ch) evOurs++;
    else evOther++;
    if (!ch || !m?.message?.trim()) return;
    try {
      const r = await postItems(ch.username, ch.title, [toItem(m)]);
      log(`[즉시] @${ch.username} 글 ${m.id}`, JSON.stringify(r));
    } catch (e) {
      log(`[즉시] @${ch.username} 글 ${m.id} 전송 실패(다음 이어받기에서 보충):`, e?.message ?? e);
    }
  }, new NewMessage({})); // 채널 필터는 위 byId 로 직접 건다(gramjs 의 chats 옵션에 엔티티 객체를 넘기면 해석 실패로 죽는다 — 실측)

  setInterval(() => catchUp("2분").catch((e) => log("정기 이어받기 실패", e?.message ?? e)), CATCHUP_EVERY_MS);

  // 정상 종료(systemd stop) 때 연결을 닫는다
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      log(`${sig} — 종료`);
      await client.disconnect().catch(() => {});
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error(new Date().toISOString(), "수신기 실패:", e);
  process.exit(1); // systemd 가 다시 띄운다
});
