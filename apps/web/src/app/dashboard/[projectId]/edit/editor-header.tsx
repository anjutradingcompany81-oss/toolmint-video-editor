"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { useClickOutside } from "@/lib/use-click-outside";
import { ExportIcon, MicWaveIcon, RedoIcon, SignOutIcon, UndoIcon } from "@/components/icons";
import SaveIndicator from "@/components/save-indicator";
import type { SaveStatus } from "@/lib/use-composition-editor";

interface EditorHeaderProps {
  title: string;
  saveStatus: SaveStatus;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  exportDisabled: boolean;
  onToggleVoiceCorrection: () => void;
  voiceCorrectionOpen: boolean;
}

export default function EditorHeader({
  title,
  saveStatus,
  saveError,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onExport,
  exportDisabled,
  onToggleVoiceCorrection,
  voiceCorrectionOpen,
}: EditorHeaderProps) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useClickOutside<HTMLDivElement>(menuOpen, () => setMenuOpen(false));

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface-2 px-4">
      <Link href="/dashboard" className="shrink-0 text-sm font-semibold tracking-wide text-ink">
        PROCUT
      </Link>
      <span className="h-5 w-px bg-line" />
      <p className="min-w-0 truncate text-sm text-ink-muted" title={title}>
        {title}
      </p>

      <Link href="/dashboard" className="ml-4 rounded-md border border-line px-3 py-1.5 text-sm hover:border-brand" title="Back to your projects">
        New project
      </Link>

      <div className="ml-2 flex items-center gap-1">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-panel hover:text-ink disabled:opacity-30"
        >
          <UndoIcon />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-panel hover:text-ink disabled:opacity-30"
        >
          <RedoIcon />
        </button>
      </div>

      <SaveIndicator status={saveStatus} error={saveError} />

      <div className="ml-auto flex items-center gap-3">
        <button
          onClick={onToggleVoiceCorrection}
          aria-pressed={voiceCorrectionOpen}
          title="AI Voice Correction — detect and fix accidentally repeated speech"
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
            voiceCorrectionOpen ? "border-brand bg-brand/15 text-brand" : "border-line text-ink hover:border-brand"
          }`}
        >
          <MicWaveIcon width={14} height={14} /> AI Voice Correction
        </button>

        <button
          onClick={onExport}
          disabled={exportDisabled}
          title={exportDisabled ? "Add at least one clip to export" : "Export video"}
          className="flex items-center gap-1.5 rounded-md bg-brand px-3.5 py-1.5 text-sm font-medium text-ink hover:bg-brand/90 disabled:opacity-40"
        >
          <ExportIcon width={14} height={14} /> Export video
        </button>

        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/20 text-xs font-medium text-brand"
          >
            {user?.displayName.charAt(0).toUpperCase() ?? "?"}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-9 z-20 w-44 rounded-md border border-line bg-panel py-1 shadow-lg">
              <p className="truncate px-3 py-1.5 text-xs text-ink-muted">{user?.displayName}</p>
              <button
                onClick={() => logout()}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-surface"
              >
                <SignOutIcon /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
