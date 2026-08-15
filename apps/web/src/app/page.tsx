"use client";

import { useEffect, useState } from "react";

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

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6">
      <div>
        <p className="text-sm tracking-wide text-[var(--tm-text-dim)]">TOOLMINT</p>
        <h1 className="mt-2 text-3xl font-semibold">ToolMint Video Editor</h1>
        <p className="mt-3 max-w-md text-[var(--tm-text-dim)]">
          Foundation scaffold — Phase 1 in progress. Authentication, the project
          dashboard, and media upload are being built next.
        </p>
      </div>

      <div className="rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-4">
        <p className="text-xs uppercase tracking-wide text-[var(--tm-text-dim)]">API status</p>
        {apiStatus.state === "checking" && <p className="mt-1">Checking…</p>}
        {apiStatus.state === "ok" && (
          <p className="mt-1 text-[var(--tm-accent)]">
            Connected — last check {new Date(apiStatus.timestamp).toLocaleTimeString()}
          </p>
        )}
        {apiStatus.state === "error" && (
          <p className="mt-1 text-red-400">
            Unreachable ({apiStatus.message}). Start the API with{" "}
            <code>npm run dev:api</code>.
          </p>
        )}
      </div>

      <p className="text-sm text-[var(--tm-text-dim)]">
        The editor itself lives at{" "}
        <a href="/video-editor" className="underline underline-offset-2">
          /video-editor
        </a>{" "}
        once Phase 2 ships.
      </p>
    </main>
  );
}
