"use client";

import { LogIn, UserRound } from "lucide-react";
import { useAppAuth } from "@/components/auth/app-auth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** 헤더 우측 계정 메뉴 — 로그인 전에는 로그인·가입 신청, 후에는 계정·로그아웃. */
export function AccountMenu() {
  const auth = useAppAuth();

  if (!auth.enabled) return null;

  if (!auth.isSignedIn) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={auth.openSignIn}
          className="text-muted-foreground hover:text-foreground gap-1.5"
        >
          <LogIn className="size-4" />
          <span className="hidden sm:inline">로그인</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={auth.openSignup}
          className="text-muted-foreground hover:text-foreground hidden sm:inline-flex"
        >
          가입 신청
        </Button>
      </>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground gap-1.5"
        >
          <UserRound className="size-4" />
          <span className="hidden max-w-[12rem] truncate sm:inline">
            {auth.email ?? "계정"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="max-w-[16rem] truncate text-xs font-normal">
          {auth.email}
          {auth.isAdmin ? " · 관리자" : ""}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => auth.openProfile()}>내 계정</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void auth.signOut()}>로그아웃</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
