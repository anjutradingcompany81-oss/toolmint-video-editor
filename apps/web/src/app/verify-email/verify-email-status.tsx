"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

type State = "verifying" | "success" | "error";

export default function VerifyEmailStatus() {
  const token = useSearchParams().get("token");
  const { refreshUser, status: authStatus } = useAuth();
  const [state, setState] = useState<State>("verifying");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return; // handled by the render-time check below — nothing to run
    let cancelled = false;

    async function verify() {
      try {
        await apiFetch("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
        if (cancelled) return;
        setState("success");
        if (authStatus === "authenticated") await refreshUser().catch(() => undefined);
      } catch (err) {
        if (cancelled) return;
        setState("error");
        setMessage(err instanceof ApiError ? err.message : "Something went wrong.");
      }
    }

    verify();
    return () => {
      cancelled = true;
    };
    // Only run once per token — refreshUser/authStatus intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) {
    return (
      <p className="text-sm text-[var(--tm-text-dim)]">
        This link is missing its verification token.{" "}
        <Link href="/dashboard" className="underline underline-offset-2">
          Go to your dashboard
        </Link>{" "}
        to resend it.
      </p>
    );
  }

  if (state === "verifying") return <p className="text-sm text-[var(--tm-text-dim)]">Confirming your email…</p>;

  if (state === "success") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-[var(--tm-accent)]">Your email is verified.</p>
        <Link href="/dashboard" className="text-sm underline underline-offset-2">
          Go to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-red-400">{message}</p>
      <Link href="/dashboard" className="text-sm underline underline-offset-2">
        Go to dashboard
      </Link>
    </div>
  );
}
