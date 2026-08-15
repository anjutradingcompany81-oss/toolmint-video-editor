import { Suspense } from "react";
import VerifyEmailStatus from "./verify-email-status";

export default function VerifyEmailPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <p className="text-sm tracking-wide text-[var(--tm-text-dim)]">TOOLMINT</p>
        <h1 className="mt-1 text-2xl font-semibold">Verify your email</h1>
      </div>
      <Suspense fallback={null}>
        <VerifyEmailStatus />
      </Suspense>
    </main>
  );
}
