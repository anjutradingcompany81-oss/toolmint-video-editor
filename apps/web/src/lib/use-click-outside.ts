"use client";

import { useEffect, useRef } from "react";

// Returns a ref to attach to the dropdown's root element — clicking
// anywhere outside it (while `active`) calls `onOutside`. Shared by every
// menu-bar dropdown instead of each one rolling its own listener.
export function useClickOutside<T extends HTMLElement>(active: boolean, onOutside: () => void) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!active) return;

    function handlePointerDown(e: PointerEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        onOutside();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [active, onOutside]);

  return ref;
}
