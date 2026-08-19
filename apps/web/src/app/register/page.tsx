"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api-client";
import { GuestIcon } from "@/components/icons";

const inputClass =
  "w-full rounded-md border border-[var(--tm-line)] bg-[var(--tm-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--tm-accent)]";

export default function RegisterPage() {
  const { register, guestLogin } = useAuth();
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);

  async function handleGuest() {
    setError(null);
    setGuestLoading(true);
    try {
      await guestLogin();
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start a guest session. Try again.");
      setGuestLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      await register(email, password, displayName);
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
        <h1 className="mt-1 text-2xl font-semibold">Create your account</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            className={inputClass}
            type="text"
            required
            maxLength={80}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
          />
        </label>

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
          Password
          <input
            className={inputClass}
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Confirm password
          <input
            className={inputClass}
            type="password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-[var(--tm-accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>

      <div className="flex items-center gap-3 text-xs text-[var(--tm-text-dim)]">
        <span className="h-px flex-1 bg-[var(--tm-line)]" />
        or
        <span className="h-px flex-1 bg-[var(--tm-line)]" />
      </div>

      <button
        onClick={handleGuest}
        disabled={guestLoading}
        title="Skips sign-up — you get your own private projects, but they're tied to this browser session rather than an email you can log back in with."
        className="flex items-center justify-center gap-2 rounded-md border border-[var(--tm-line)] px-3 py-2 text-sm font-medium text-[var(--tm-text)] hover:border-[var(--tm-accent)] disabled:opacity-50"
      >
        <GuestIcon />
        {guestLoading ? "Starting…" : "Try as guest"}
      </button>

      <p className="text-sm text-[var(--tm-text-dim)]">
        Already have an account?{" "}
        <Link href="/login" className="underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </main>
  );
}
