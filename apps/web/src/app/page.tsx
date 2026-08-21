"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { ClapperboardIcon } from "@/components/icons";

type ApiStatus =
  | { state: "checking" }
  | { state: "ok"; timestamp: string }
  | { state: "error"; message: string };

function useApiHealth() {
  const [status, setStatus] = useState<ApiStatus>({ state: "checking" });

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    let cancelled = false;

    fetch(`${apiUrl}/health`)
      .then((res) => {
        if (!res.ok) throw new Error(`API responded with ${res.status}`);
        return res.json();
      })
      .then((data: { timestamp: string }) => {
        if (!cancelled) setStatus({ state: "ok", timestamp: data.timestamp });
      })
      .catch((err: Error) => {
        if (!cancelled) setStatus({ state: "error", message: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

export default function Home() {
  const apiStatus = useApiHealth();
  const { user, status } = useAuth();
  const signedIn = status === "authenticated" && !!user;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm tracking-wide text-ink-muted">TOOLMINT</p>
          <h1 className="mt-1 text-2xl font-semibold">A growing suite of practical, browser-based tools</h1>
        </div>
        {signedIn ? (
          <Link href="/dashboard" className="rounded-md border border-line px-4 py-2 text-sm font-medium hover:border-brand">
            Your account
          </Link>
        ) : (
          <div className="flex gap-3">
            <Link href="/login" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-ink">
              Sign in
            </Link>
            <Link href="/register" className="rounded-md border border-line px-4 py-2 text-sm font-medium hover:border-brand">
              Create account
            </Link>
          </div>
        )}
      </header>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-muted">Applications</h2>

        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link
            href={signedIn ? "/dashboard" : "/login"}
            className="group flex flex-col gap-3 rounded-xl border border-line bg-panel p-5 transition-colors hover:border-brand"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/15 text-brand">
              <ClapperboardIcon width={20} height={20} />
            </div>
            <div>
              <h3 className="font-medium text-ink">Video Editing Software</h3>
              <p className="mt-1 text-sm text-ink-muted">
                Upload clips, arrange and trim them on a timeline, and export one merged video — all in the browser.
              </p>
            </div>
            <span className="mt-auto text-sm font-medium text-brand group-hover:underline">
              {signedIn ? "Open editor" : "Sign in to open"} →
            </span>
          </Link>
        </div>
      </section>

      <div className="rounded-lg border border-line bg-panel p-4">
        <p className="text-xs uppercase tracking-wide text-ink-muted">API status</p>
        {apiStatus.state === "checking" && <p className="mt-1">Checking…</p>}
        {apiStatus.state === "ok" && (
          <p className="mt-1 text-success">Connected — last check {new Date(apiStatus.timestamp).toLocaleTimeString()}</p>
        )}
        {apiStatus.state === "error" && (
          <p className="mt-1 text-danger">
            Unreachable ({apiStatus.message}). Start the API with <code>npm run dev:api</code>.
          </p>
        )}
      </div>
    </main>
  );
}
