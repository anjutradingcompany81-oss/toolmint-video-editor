"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api-client";

const inputClass =
  "w-full rounded-md border border-[var(--tm-line)] bg-[var(--tm-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--tm-accent)]";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <p className="text-sm tracking-wide text-[var(--tm-text-dim)]">TOOLMINT</p>
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
          className="rounded-md bg-[var(--tm-accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="text-sm text-[var(--tm-text-dim)]">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="underline underline-offset-2">
          Create one
        </Link>
      </p>
    </main>
  );
}
