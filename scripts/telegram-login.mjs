/**
 * 텔레그램 개인 계정 로그인(1회 실행) — 인플루언서 트래킹 기능의 텔레그램
 * 연동(참여 중인 채팅 읽기)을 위한 세션 생성 스크립트.
 *
 * ⚠️ 여기서 만들어지는 세션 문자열은 "읽기 전용 API 키"가 아니라 텔레그램
 *    계정 전체 권한(메시지 읽기·쓰기·채팅 참여 등)이다. 절대 채팅으로
 *    전달하거나 git에 커밋하지 말 것 — 이 스크립트가 직접 .env.local 에
 *    저장하므로 화면에 출력하지 않는다.
 *
 * 사전 준비: https://my.telegram.org 에서 발급받은 TELEGRAM_API_ID,
 * TELEGRAM_API_HASH 가 .env.local 에 있어야 한다.
 *
 * 실행: node scripts/telegram-login.mjs
 * (전화번호 → 텔레그램 앱/SMS로 오는 인증코드 → 2단계 인증 걸어뒀으면 비밀번호,
 *  순서로 터미널에서 직접 입력)
 */
import { readFileSync, readFile as readFileCb, writeFile as writeFileCb } from "node:fs";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const readFile = promisify(readFileCb);
const writeFile = promisify(writeFileCb);
const ENV_PATH = new URL("../.env.local", import.meta.url);

function loadEnvLocal() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(ENV_PATH, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
      if (m && (env[m[1]] === undefined || env[m[1]] === "")) env[m[1]] = m[2];
    }
  } catch {
    /* .env.local 없어도 됨 */
  }
  return env;
}

async function saveSessionToEnvLocal(sessionString) {
  let raw = "";
  try {
    raw = await readFile(ENV_PATH, "utf8");
  } catch {
    /* 새로 생성 */
  }
  const line = `TELEGRAM_SESSION="${sessionString}"`;
  if (/^TELEGRAM_SESSION=/m.test(raw)) {
    raw = raw.replace(/^TELEGRAM_SESSION=.*$/m, line);
  } else {
    raw = raw.replace(/\n?$/, "") + `\n${line}\n`;
  }
  await writeFile(ENV_PATH, raw, "utf8");
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function main() {
  const ENV = loadEnvLocal();
  const apiId = Number(ENV.TELEGRAM_API_ID);
  const apiHash = ENV.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    console.error("TELEGRAM_API_ID / TELEGRAM_API_HASH 가 .env.local 에 없습니다. my.telegram.org 에서 먼저 발급받으세요.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => prompt(rl, "휴대폰 번호(국가번호 포함, 예 +8210xxxxxxxx): "),
    password: () => prompt(rl, "2단계 인증 비밀번호(안 걸어놨으면 그냥 엔터): "),
    phoneCode: () => prompt(rl, "텔레그램 앱/SMS로 받은 인증코드: "),
    onError: (err) => console.error("로그인 오류:", err),
  });

  rl.close();

  const sessionString = client.session.save();
  await saveSessionToEnvLocal(sessionString);
  console.log("로그인 성공 — 세션을 .env.local 의 TELEGRAM_SESSION 에 저장했습니다.");
  console.log("(세션 문자열 자체는 출력하지 않습니다 — 계정 전체 권한이라 민감함)");

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
