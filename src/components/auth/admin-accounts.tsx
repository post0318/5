"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * 계정 승인 관리 — 관리자만. 4번 프로젝트의 「승인 관리」를 이식했다.
 * 대기자를 승인하면 Clerk 가 가입 안내 메일을 보내고, 그때부터 그 계정은
 * 자기 유니버스를 갖는다(계정별 분리).
 */

interface WaitlistEntry {
  id: string;
  email: string;
  status: "pending" | "invited" | "completed" | "rejected";
  createdAt: string;
}

interface AdminUser {
  id: string;
  email: string;
  banned: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  universeCount: number;
}

interface AccountsResponse {
  waitlist: WaitlistEntry[];
  users: AdminUser[];
  me: string;
}

const STATUS_KO: Record<WaitlistEntry["status"], string> = {
  pending: "대기 중",
  invited: "승인됨",
  completed: "가입 완료",
  rejected: "거절됨",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function AdminAccounts() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["admin-accounts"],
    queryFn: () => apiFetch<AccountsResponse>("/api/admin/accounts"),
    retry: false,
  });

  const act = useMutation({
    mutationFn: (v: { action: string; id: string }) =>
      apiFetch<{ ok: true }>("/api/admin/accounts", {
        method: "POST",
        body: JSON.stringify(v),
      }),
    onSuccess: (_d, v) => {
      const msg: Record<string, string> = {
        invite: "승인했습니다. 가입 안내 메일이 갑니다.",
        reject: "거절했습니다.",
        ban: "차단했습니다.",
        unban: "차단을 풀었습니다.",
      };
      toast.success(msg[v.action] ?? "처리했습니다.");
      qc.invalidateQueries({ queryKey: ["admin-accounts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (list.isLoading) {
    return <p className="text-muted-foreground text-sm">불러오는 중…</p>;
  }
  if (list.error) {
    return <p className="text-destructive text-sm">{(list.error as Error).message}</p>;
  }

  const waitlist = list.data?.waitlist ?? [];
  const users = list.data?.users ?? [];
  const pending = waitlist.filter((w) => w.status === "pending");
  const handled = waitlist.filter((w) => w.status !== "pending");
  const busy = act.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            가입 신청{" "}
            {pending.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {pending.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-muted-foreground text-sm">처리할 신청이 없습니다.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이메일</TableHead>
                  <TableHead>신청일</TableHead>
                  <TableHead className="text-right">처리</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.email}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {when(w.createdAt)}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => act.mutate({ action: "invite", id: w.id })}
                      >
                        승인
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => act.mutate({ action: "reject", id: w.id })}
                      >
                        거절
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {handled.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">처리한 신청</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이메일</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>신청일</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {handled.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.email}</TableCell>
                    <TableCell>
                      <Badge
                        variant={w.status === "rejected" ? "destructive" : "secondary"}
                      >
                        {STATUS_KO[w.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {when(w.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">계정</CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <p className="text-muted-foreground text-sm">계정이 없습니다.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이메일</TableHead>
                  <TableHead className="text-right">유니버스</TableHead>
                  <TableHead>가입일</TableHead>
                  <TableHead>마지막 로그인</TableHead>
                  <TableHead className="text-right">처리</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const isMe = u.email === list.data?.me;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">
                        {u.email}
                        {isMe && (
                          <span className="text-muted-foreground ml-1.5 text-xs">(나)</span>
                        )}
                        {u.banned && (
                          <Badge variant="destructive" className="ml-2">
                            차단됨
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="tnum text-right">{u.universeCount}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {when(u.createdAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {when(u.lastSignInAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {isMe ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : u.banned ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => act.mutate({ action: "unban", id: u.id })}
                          >
                            차단 해제
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => act.mutate({ action: "ban", id: u.id })}
                          >
                            차단
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <p className="text-muted-foreground mt-3 text-xs">
            차단은 삭제가 아닙니다. 로그인만 막히고 그 계정의 유니버스는 그대로
            남아 차단을 풀면 되살아납니다.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
