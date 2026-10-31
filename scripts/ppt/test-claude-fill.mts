/**
 * API 자동 채우기 가짜 응답 시험 — 실제 Anthropic 호출 없음(로컬 가짜 서버). 키 없음·월 상한·검증(지어낸 숫자·블로그 출처·목표주가 문구) 경로를 확인한다.
 * DB 는 2호기 로컬 검증 DB 의 시험 전용 컬렉션(test_ppt_*, PPT_COLLECTION_PREFIX)에만 쓰고 끝에 지운다. 운영 DB 에 쓰지 않는다.
 *
 *   NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/ppt/test-claude-fill.mts --env=~/5/.env.local
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

const TF = "https://www.trendforce.com/presscenter/news/20260801-12345.html";
const FAKE = {
  id: "msg_fake",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  stop_reason: "tool_use",
  stop_sequence: null,
  stop_details: null,
  content: [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "삼성전자 D램 점유율 2026년 2분기" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        { type: "web_search_result", url: TF, title: "TrendForce DRAM ranking 2Q26", page_age: "2026-08-01", encrypted_content: "x" },
        { type: "web_search_result", url: "https://blog.naver.com/someone/1", title: "블로그", page_age: null, encrypted_content: "x" },
      ],
    },
    {
      type: "text",
      text: "트렌드포스에 따르면 2026년 2분기 D램 매출 점유율은 삼성전자 36.0%, SK하이닉스 32.1%, 마이크론 22.4%다.",
      citations: [
        { type: "web_search_result_location", url: TF, title: "TrendForce DRAM ranking 2Q26", cited_text: "2Q26 DRAM revenue share: Samsung 36.0%, SK hynix 32.1%, Micron 22.4%", encrypted_index: "x" },
      ],
    },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "submit_ppt_fill",
      input: {
        share: {
          business: "글로벌 D램",
          asOf: "2026년 2분기",
          rows: [
            { name: "삼성전자", value: 0.36, self: true },
            { name: "SK하이닉스", value: 0.321, self: false },
            { name: "마이크론", value: 0.224, self: false },
            { name: "CXMT", value: 0.05, self: false },
          ],
          sources: [
            { org: "TrendForce", title: "DRAM ranking 2Q26", publishedAt: "2026-08-01", url: TF },
            { org: "개인 블로그", title: "D램 정리", publishedAt: "2026-08-02", url: "https://blog.naver.com/someone/1" },
          ],
        },
        points: [
          { kind: "founding", text: "1969년 설립, 메모리·스마트폰·TV 를 만드는 전자기업으로 D램 점유율 36%", sources: [{ org: "TrendForce", title: "DRAM ranking 2Q26", publishedAt: "2026-08-01", url: TF }] },
          { kind: "business", text: "HBM 매출 비중 50% 로 확대(지어낸 수치 시험)", sources: [{ org: "TrendForce", title: "DRAM ranking 2Q26", publishedAt: "2026-08-01", url: TF }] },
          { kind: "thesis", text: "목표주가 50만원, 상승 여력 큼(금지 문구 시험)", sources: [{ org: "TrendForce", title: "DRAM ranking 2Q26", publishedAt: "2026-08-01", url: TF }] },
        ],
      },
    },
  ],
  usage: { input_tokens: 40000, output_tokens: 4000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 3 } },
};

function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "통과" : "실패"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  const envFile = (arg("env") ?? "").replace(/^~(?=\/)/, homedir());
  if (envFile) process.loadEnvFile(envFile);
  process.env.PPT_COLLECTION_PREFIX = "test_"; // 시험 전용 컬렉션
  if (/mongodb\.net/.test(process.env.MONGODB_URI ?? "")) throw new Error("운영(Atlas) 주소로는 시험하지 않는다");
  delete process.env.ANTHROPIC_API_KEY;
  const seen: { body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ body: JSON.parse(raw), headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(FAKE));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { fillCompany, claudeFillConfig } = await import("@/lib/ppt/claude-fill");
  const { getCompany, pptUsageCol, pptCompanyCol } = await import("@/lib/ppt/store");
  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  const drop = async () => {
    for (const c of await db.listCollections({ name: /^test_ppt_/ }).toArray()) await db.collection(c.name).drop();
  };
  await drop();
  try {
    // 1) 키 없음 → 꺼짐, 호출 없음
    check("키 없으면 꺼짐", claudeFillConfig().enabled === false);
    const off = await fillCompany("kr", "005930", { by: "test" });
    check("키 없으면 호출 없이 disabled", off.status === "disabled" && seen.length === 0, off.note ?? "");

    // 2) 가짜 응답으로 채우기
    const client = new Anthropic({ apiKey: "fake", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const r = await fillCompany("kr", "005930", { by: "test", client });
    console.log(JSON.stringify(r, null, 1));
    const body = seen[0]?.body ?? {};
    const tools = (body.tools as { type?: string; name?: string }[]) ?? [];
    check("요청 모델 = claude-sonnet-5-5", body.model === "claude-sonnet-5-5", String(body.model));
    check("웹검색 도구 web_search_20260209", tools.some((t) => t.type === "web_search_20260209"));
    check("제출 도구", tools.some((t) => t.name === "submit_ppt_fill"));
    check("대체 모델 베타 머리글", String(seen[0]?.headers["anthropic-beta"] ?? "").includes("server-side-fallback-2026-07-01"));
    const doc = await getCompany("kr", "005930");
    const rows = doc?.share?.rows ?? [];
    check("점유율 저장", Boolean(doc?.share), JSON.stringify(rows));
    check("지어낸 비중(CXMT 5%) 뺌", !rows.some((x) => x.name === "CXMT"));
    check("기타 = 1 − 합(계산)", Math.abs((rows.find((x) => x.name === "기타")?.value ?? 0) - 0.095) < 1e-9);
    check("블로그 출처 뺌", (doc?.share?.sources ?? []).every((s) => !s.url.includes("blog.naver")));
    check("이 회사가 첫 줄", rows[0]?.name === "삼성전자");
    const lines = doc?.points?.lines ?? [];
    check("투자포인트: 근거 있는 첫 줄만 저장", lines.length === 1 && lines[0].kind === "founding", lines.map((l) => l.kind).join(","));
    check("지어낸 수치 줄 지움", r.points?.dropped.some((d) => d.kind === "business" && d.reason.includes("50%")) ?? false);
    check("목표주가 줄 지움", r.points?.dropped.some((d) => d.kind === "thesis") ?? false);
    const usage = await (await pptUsageCol()).find().toArray();
    check("비용 기록 1건", usage.length === 1, JSON.stringify(usage[0]));
    check("추정 비용 0.15달러(입력 4만×2 + 출력 4천×10 + 검색 3×0.01)", Math.abs((usage[0]?.costUsd ?? 0) - 0.15) < 1e-9, String(usage[0]?.costUsd));
    const log = await db.collection("test_ppt_company_log").countDocuments();
    check("변경 기록", log === 2, String(log));

    // 3) 같은 종목 두 번 안 함
    const again = await fillCompany("kr", "005930", { by: "test", client });
    check("채워진 종목은 건너뜀(호출 없음)", again.status === "skipped" && seen.length === 1);

    if (process.argv.includes("--keep")) {
      console.log("--keep: 시험 컬렉션(test_ppt_*)을 남기고 끝냄 — 생성기 --from-db 시험용, 다 쓰면 다시 실행해 지울 것");
      server.close();
      return;
    }
    // 4) 월 상한
    process.env.PPT_CLAUDE_MONTHLY_BUDGET_USD = "0.2";
    await (await pptCompanyCol()).deleteMany({});
    const b = await fillCompany("kr", "005930", { by: "test", client });
    check("월 상한 넘으면 호출 안 함", b.status === "budget" && seen.length === 1, b.note ?? "");
    await drop();
  } finally {
    server.close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
