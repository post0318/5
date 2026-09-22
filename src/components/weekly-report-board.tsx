"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { WeeklyReportDoc, WeeklyReportSummary } from "@/lib/db/weekly-reports";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 주간 거시·시황 리포트 — 목록 / 미리보기 / 검수(편집·발행) 화면.
 * 초안은 월요일 아침 크론이 만들고, 여기서 오너가 고쳐 "발행"을 누른다.
 * 생성·수정·발행은 로그인 필요(Clerk, 헤더 계정 메뉴) — 비로그인이면 401 메시지.
 */

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * PDF 다운로드(오너 지시 2026-09-22). 바이너리 응답이라 JSON 만 다루는
 * apiFetch 를 안 쓰고 직접 fetch — blob 을 받아 임시 <a> 로 저장 트리거.
 * 실패해도 예외를 던지지 않고 메시지만 돌려준다 — 발행 자체는 이미 끝난
 * 뒤라(자동 트리거 시) 여기서 막히면 안 된다.
 */
async function downloadWeeklyPdf(id: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/weekly/${id}/pdf`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error ?? `PDF 생성 실패 (${res.status})`;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weekly-${id}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return null;
  } catch {
    return "PDF 다운로드 실패 — 네트워크 오류";
  }
}

function bodyChars(md: string): number {
  return md
    .split("\n")
    .filter((l) => !/^\s*\|/.test(l))
    .join("")
    .replace(/\s+/g, "").length;
}

export function WeeklyReportBoard() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["weekly", "list"],
    queryFn: () => apiFetch<{ items: WeeklyReportSummary[] }>("/api/weekly"),
  });

  const activeId = selected ?? list.data?.items[0]?._id ?? null;

  const detail = useQuery({
    queryKey: ["weekly", "detail", activeId],
    queryFn: () => apiFetch<WeeklyReportDoc>(`/api/weekly/${activeId}`),
    enabled: Boolean(activeId),
  });

  const generate = useMutation({
    mutationFn: (force: boolean) =>
      apiFetch<WeeklyReportDoc>("/api/weekly", { method: "POST", body: JSON.stringify({ force }) }),
    onSuccess: (doc) => {
      setMsg(`초안 생성 완료 — ${doc.model}, 추정 비용 $${doc.usage.costUsd.toFixed(3)}`);
      setSelected(doc._id);
      void qc.invalidateQueries({ queryKey: ["weekly"] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? `생성 실패: ${e.message}` : "생성 실패"),
  });

  const patch = useMutation({
    mutationFn: (p: { body?: string; status?: "draft" | "published" }) =>
      apiFetch<WeeklyReportDoc>(`/api/weekly/${activeId}`, { method: "PATCH", body: JSON.stringify(p) }),
    onSuccess: (doc, vars) => {
      setMsg(vars.status === "published" ? "발행 완료 — PDF 생성 중…" : vars.status === "draft" ? "발행 취소" : "저장 완료");
      void qc.invalidateQueries({ queryKey: ["weekly"] });
      // 발행 시 PDF 자동 생성·다운로드(오너 지시 2026-09-22 — "발행을 누르면
      // pdf로 생성"). 실패해도 발행 자체는 이미 끝났으니 메시지만 갱신.
      if (vars.status === "published") {
        void downloadWeeklyPdf(doc._id).then((err) => {
          setMsg(err ? `발행 완료 (PDF: ${err})` : "발행 완료 — PDF 다운로드됨");
        });
      }
    },
    onError: (e) => setMsg(e instanceof ApiError ? `실패: ${e.message}` : "실패"),
  });

  const doc = detail.data;
  const busy = generate.isPending || patch.isPending;

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      {/* 목록 */}
      <Card className="h-fit">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">주간 리포트</CardTitle>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => generate.mutate(false)}>
            {generate.isPending ? "생성 중…" : "초안 생성"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-1">
          {list.isLoading && <Skeleton className="h-16" />}
          {list.data?.items.length === 0 && (
            <p className="text-muted-foreground text-xs">
              아직 리포트가 없습니다. 매주 월요일 09:00에 자동 생성되며, 지금 바로 만들려면 &quot;초안 생성&quot;을 누르세요.
            </p>
          )}
          {list.data?.items.map((it) => (
            <button
              key={it._id}
              type="button"
              onClick={() => setSelected(it._id)}
              className={cn(
                "flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                it._id === activeId ? "bg-secondary" : "hover:bg-muted",
              )}
            >
              <span className="tnum font-medium">
                {it.weekStart} ~ {it.weekEnd.slice(5)}
              </span>
              <span className="text-muted-foreground flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    "rounded px-1",
                    it.status === "published" ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600",
                  )}
                >
                  {it.status === "published" ? "발행" : "초안"}
                </span>
                <span className="tnum">${it.costUsd.toFixed(2)}</span>
              </span>
            </button>
          ))}
        </CardContent>
      </Card>

      {/* 본문 */}
      <div className="min-w-0 space-y-3">
        {msg && (
          <p className="text-muted-foreground text-xs" role="status">
            {msg}
          </p>
        )}
        {activeId && detail.isLoading && <Skeleton className="h-96" />}
        {doc && (
          <ReportView
            key={`${doc._id}:${doc.updatedAt}`}
            doc={doc}
            busy={busy}
            onSave={(body) => patch.mutate({ body })}
            onPublish={() => patch.mutate({ status: "published" })}
            onUnpublish={() => patch.mutate({ status: "draft" })}
            onRegenerate={() => generate.mutate(true)}
            onMsg={setMsg}
          />
        )}
      </div>
    </div>
  );
}

interface ReportViewProps {
  doc: WeeklyReportDoc;
  busy: boolean;
  onSave: (body: string) => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onRegenerate: () => void;
  onMsg: (m: string) => void;
}

/** 리포트 1건의 미리보기/편집 — key 로 doc 이 바뀔 때마다 초기화되므로 effect 불필요 */
function ReportView({ doc, busy, onSave, onPublish, onUnpublish, onRegenerate, onMsg }: ReportViewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(doc.body);
  const [pdfBusy, setPdfBusy] = useState(false);
  const chars = useMemo(() => bodyChars(editing ? draft : doc.body), [doc.body, draft, editing]);
  return (
          <Card>
            <CardHeader className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{doc.title}</CardTitle>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs",
                    doc.status === "published" ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600",
                  )}
                >
                  {doc.status === "published" ? "발행됨" : "초안"}
                </span>
                <span className="text-muted-foreground tnum text-xs">
                  본문 {chars.toLocaleString()}자 · {doc.model} · ${doc.usage.costUsd.toFixed(3)} · 생성 {fmtDate(doc.generatedAt)}
                </span>
                {/* 그라운딩(웹검색) 실패 표시(오너 결정 2026-09-21) — 실패해도
                    리포트는 그냥 나가고 아무 신호가 없어서, 코멘트가 검색
                    근거인지 모델 내부 지식인지 검수 때 알 수 없었다. 실패는
                    "틀린 내용"이 아니라 "빈 코멘트" 방향이지만, 재생성 한 번
                    이면 되는 일이라 판단 근거를 화면에 남긴다. 실행마다 갈려서
                    (실측) 재생성하면 채워질 수 있다. */}
                {doc.sources.groundingSources.length === 0 ? (
                  <span
                    className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600"
                    title="Gemini 가 웹검색을 하지 않았거나 출처를 못 얻었습니다. 코멘트가 검색 근거 없이 작성됐을 수 있습니다 — 재생성하면 채워질 수 있습니다."
                  >
                    웹검색 실패
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    웹검색 출처 {doc.sources.groundingSources.length}건
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {!editing ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                    편집
                  </Button>
                ) : (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => onSave(draft)}>
                      저장
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setDraft(doc.body);
                        setEditing(false);
                      }}
                    >
                      취소
                    </Button>
                  </>
                )}
                {doc.status === "draft" ? (
                  <Button size="sm" disabled={busy || editing} onClick={onPublish}>
                    발행
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy || editing} onClick={onUnpublish}>
                    발행 취소
                  </Button>
                )}
                {/* 발행된 리포트는 재발행 없이도 다시 받을 수 있어야 한다 —
                    자동 다운로드는 "발행" 클릭 시 1회뿐이라(오너 지시
                    2026-09-22). */}
                {doc.status === "published" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || pdfBusy}
                    onClick={async () => {
                      setPdfBusy(true);
                      const err = await downloadWeeklyPdf(doc._id);
                      setPdfBusy(false);
                      onMsg(err ? `PDF: ${err}` : "PDF 다운로드됨");
                    }}
                  >
                    {pdfBusy ? "PDF 생성 중…" : "PDF 다운로드"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (doc.status === "published" && !window.confirm("발행된 리포트를 새 초안으로 덮어씁니다. 계속할까요?")) return;
                    onRegenerate();
                  }}
                >
                  재생성
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(editing ? draft : doc.body);
                    onMsg("마크다운을 클립보드에 복사했습니다");
                  }}
                >
                  복사
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="bg-background min-h-[70vh] w-full rounded-md border p-3 font-mono text-sm leading-relaxed"
                />
              ) : (
                <article className="weekly-md max-w-none text-sm leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.body}</ReactMarkdown>
                </article>
              )}

              <details className="mt-6">
                <summary className="text-muted-foreground cursor-pointer text-xs">
                  검수용: 후보 이슈 전체 · 입력 자료 · 웹검색 출처
                </summary>
                <div className="text-muted-foreground mt-2 space-y-3 text-xs">
                  <p className="tnum">
                    입력 자료 — 리포트 {doc.sources.researchCount}건, 뉴스 제목 {doc.sources.newsCount}건, 텔레그램{" "}
                    {doc.sources.telegramCount}건, 유튜브 {doc.sources.youtubeCount}건 · 토큰 입력{" "}
                    {doc.usage.inputTokens.toLocaleString()} / 출력 {doc.usage.outputTokens.toLocaleString()} / 사고{" "}
                    {doc.usage.thoughtTokens.toLocaleString()} · 호출 {doc.usage.calls}회
                  </p>
                  {doc.candidates && (
                    <div className="weekly-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.candidates}</ReactMarkdown>
                    </div>
                  )}
                  {doc.sources.groundingQueries.length > 0 && (
                    <p>웹검색어: {doc.sources.groundingQueries.join(" · ")}</p>
                  )}
                  {doc.sources.groundingSources.length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-4">
                      {doc.sources.groundingSources.map((s, i) => (
                        <li key={i}>
                          <a href={s.uri} target="_blank" rel="noreferrer" className="underline">
                            {s.title || s.uri}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* 코멘트가 빈 이유(오너 지시 2026-09-21 — "폐기사유 넣으라는거").
                      "근거 부족" 같은 뭉뚱그린 문구 대신 검증 실패·모델 미생성·
                      그라운딩 실패 중 실제로 무엇이었는지 항목별로 밝힌다. */}
                  {doc.sources.dropReasons && Object.keys(doc.sources.dropReasons).length > 0 && (
                    <div>
                      <p className="mb-1 font-medium">비어 있는 코멘트 — 사유</p>
                      <ul className="list-disc space-y-0.5 pl-4">
                        {Object.entries(doc.sources.dropReasons).map(([key, reason]) => (
                          <li key={key}>
                            <span className="font-medium">{key}</span>: {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div>
                    <p className="mb-1 font-medium">시세 스냅샷(원본)</p>
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b">
                          <th className="py-0.5 pr-2">지표</th>
                          <th className="py-0.5 pr-2 text-right">값</th>
                          <th className="py-0.5 pr-2 text-right">전주 대비</th>
                          <th className="py-0.5">기준일</th>
                        </tr>
                      </thead>
                      <tbody>
                        {doc.snapshot.map((r) => (
                          <tr key={r.key} className="border-b border-dashed">
                            <td className="py-0.5 pr-2">{r.name}</td>
                            <td className="tnum py-0.5 pr-2 text-right">{r.value == null ? "-" : r.value.toFixed(2)}</td>
                            <td className="tnum py-0.5 pr-2 text-right">
                              {r.diff != null && r.unit.startsWith("%")
                                ? `${r.diff >= 0 ? "+" : ""}${(r.diff * 100).toFixed(0)}bp`
                                : r.pct != null
                                  ? `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%`
                                  : "-"}
                            </td>
                            <td className="py-0.5">
                              {r.asOf ?? "-"}
                              {r.baseAsOf ? ` (vs ${r.baseAsOf})` : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            </CardContent>
          </Card>
  );
}
