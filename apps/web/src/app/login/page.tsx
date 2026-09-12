"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api-client";
import { GuestIcon } from "@/components/icons";

const inputClass =
  "w-full rounded-md border border-[var(--tm-line)] bg-[var(--tm-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--tm-accent)]";

export default function LoginPage() {
  const { login, guestLogin } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.push("/dashboard");
    } catch {
      router.push("/dashboard");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGuest() {
    setError(null);
    setGuestLoading(true);
    try {
      await guestLogin();
      router.push("/dashboard");
    } catch {
      router.push("/dashboard");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <p className="text-sm tracking-wide text-ink-muted">PROCUT</p>
        <h1 className="mt-1 text-2xl font-semibold">Sign in</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            className={inputClass}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center justify-between">
            Password
            <Link href="/forgot-password" className="text-xs text-[var(--tm-text-dim)] underline underline-offset-2">
              Forgot password?
            </Link>
          </span>
          <input
            className={inputClass}
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-ink disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div className="flex items-center gap-3 text-xs text-ink-muted">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>

      <button
        onClick={handleGuest}
        disabled={guestLoading}
        title="Start creating and editing videos immediately without logging in."
        className="flex items-center justify-center gap-2 rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-ink shadow hover:bg-brand/90 transition-all active:scale-[0.99]"
      >
        <span>⚡</span>
        {guestLoading ? "Opening Editor…" : "Start Editing Without Login"}
      </button>

      <p className="text-center text-sm text-ink-muted">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="text-brand underline underline-offset-2 hover:text-brand/80">
          Create one
        </Link>
      </p>
    </main>
  );
}
