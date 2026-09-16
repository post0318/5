"use client";

import { useState, type ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppAuthProvider } from "@/components/auth/app-auth";
import type { InitialAuthState } from "@/lib/server/app-auth";
import { SignupHost } from "@/components/auth/signup-host";

export function Providers({
  children,
  authEnabled,
  initialAuth = null,
}: {
  children: ReactNode;
  /** Clerk 키가 설정돼 있는지 — 서버(layout)에서 내려준다 */
  authEnabled: boolean;
  /** 서버 렌더링 시점의 인증 판정 — 첫 화면의 /api/auth/me 왕복을 없앤다 */
  initialAuth?: InitialAuthState | null;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <AppAuthProvider enabled={authEnabled} initial={initialAuth}>
            {children}
            <SignupHost />
          </AppAuthProvider>
        </TooltipProvider>
        <Toaster richColors position="top-center" />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
