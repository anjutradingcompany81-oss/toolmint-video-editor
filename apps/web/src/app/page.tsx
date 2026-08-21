"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

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

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6">
      <div>
        <p className="text-sm tracking-wide text-ink-muted">PROCUT</p>
        <h1 className="mt-2 text-3xl font-semibold">ProCut Video Editor</h1>
        <p className="mt-3 max-w-md text-ink-muted">
          Upload your clips, arrange and trim them on the timeline, and export one merged video — all in the browser.
        </p>
        <div className="mt-4 flex gap-3">
          {status === "authenticated" && user ? (
            <Link href="/dashboard" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-ink">
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-ink">
                Sign in
              </Link>
              <Link href="/register" className="rounded-md border border-line px-4 py-2 text-sm font-medium hover:border-brand">
                Create account
              </Link>
            </>
          )}
        </div>
      </div>

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
