"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useClickOutside } from "@/lib/use-click-outside";
import type { SaveStatus } from "@/lib/use-composition-editor";
import SaveIndicator from "@/components/save-indicator";
import { ChevronDownIcon, ExportIcon, RedoIcon, SignOutIcon, UndoIcon } from "@/components/icons";
import ExportPanel from "./export-panel";

interface EditorMenuBarProps {
  projectId: string;
  projectTitle: string;
  sceneId: string;
  sceneName: string;
  saveStatus: SaveStatus;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

// The editor's top nav — brand/breadcrumb on the left, transport +
// save-state + export + account on the right. Everything here used to be
// scattered (export buried in the left sidebar, no account access from the
// editor at all) — consolidating it here matches how every desktop-style
// NLE places these controls.
export default function EditorMenuBar({
  projectId,
  projectTitle,
  sceneId,
  sceneName,
  saveStatus,
  saveError,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: EditorMenuBarProps) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [exportOpen, setExportOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const exportRef = useClickOutside<HTMLDivElement>(exportOpen, () => setExportOpen(false));
  const accountRef = useClickOutside<HTMLDivElement>(accountOpen, () => setAccountOpen(false));

  async function handleSignOut() {
    setAccountOpen(false);
    await logout();
    router.push("/login");
  }

  return (
    <header className="flex items-center justify-between border-b border-[var(--tm-line)] bg-[var(--tm-surface)] px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Link href="/dashboard" className="shrink-0 font-semibold tracking-wide">
          TOOLMINT
        </Link>
        <span className="shrink-0 text-[var(--tm-text-dim)]">/</span>
        <Link
          href={`/dashboard/${projectId}/edit`}
          className="min-w-0 truncate text-[var(--tm-text-dim)] hover:text-[var(--tm-text)] hover:underline"
          title={projectTitle}
        >
          {projectTitle}
        </Link>
        <span className="shrink-0 text-[var(--tm-text-dim)]">/</span>
        <span className="shrink-0 font-medium">{sceneName}</span>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-1">
          <button
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--tm-line)] text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)] disabled:opacity-30 disabled:hover:border-[var(--tm-line)]"
          >
            <UndoIcon />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--tm-line)] text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)] disabled:opacity-30 disabled:hover:border-[var(--tm-line)]"
          >
            <RedoIcon />
          </button>
        </div>

        <SaveIndicator status={saveStatus} error={saveError} />

        <div ref={exportRef} className="relative">
          <button
            onClick={() => {
              setExportOpen((v) => !v);
              setAccountOpen(false);
            }}
            className="flex items-center gap-1.5 rounded-md bg-[var(--tm-accent)] px-3 py-1.5 text-sm font-medium text-black"
          >
            <ExportIcon width={15} height={15} />
            Export
            <ChevronDownIcon width={13} height={13} />
          </button>
          {exportOpen && (
            <div className="absolute right-0 top-[calc(100%+6px)] z-20 w-80 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3 shadow-xl">
              <ExportPanel projectId={projectId} sceneId={sceneId} />
            </div>
          )}
        </div>

        <div ref={accountRef} className="relative">
          <button
            onClick={() => {
              setAccountOpen((v) => !v);
              setExportOpen(false);
            }}
            title={user?.displayName}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--tm-accent)]/20 text-xs font-medium text-[var(--tm-accent)] hover:bg-[var(--tm-accent)]/30"
          >
            {user?.displayName.charAt(0).toUpperCase()}
          </button>
          {accountOpen && (
            <div className="absolute right-0 top-[calc(100%+6px)] z-20 w-56 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-1.5 text-sm shadow-xl">
              <div className="px-2 py-1.5">
                <p className="truncate font-medium">{user?.displayName}</p>
                <p className="truncate text-xs text-[var(--tm-text-dim)]">{user?.isGuest ? "Guest account" : user?.email}</p>
              </div>
              <div className="my-1 border-t border-[var(--tm-line)]" />
              <Link
                href="/dashboard"
                onClick={() => setAccountOpen(false)}
                className="block rounded px-2 py-1.5 hover:bg-[var(--tm-bg)]"
              >
                Dashboard
              </Link>
              <button
                onClick={handleSignOut}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-red-400 hover:bg-[var(--tm-bg)]"
              >
                <SignOutIcon />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
