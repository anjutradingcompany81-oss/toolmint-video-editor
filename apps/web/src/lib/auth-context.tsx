"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch, refreshSession, setAccessToken } from "./api-client";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: string | null;
  isGuest: boolean;
}

interface AuthResponse {
  user: AuthUser;
  accessToken: string;
}

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  guestLogin: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const DEFAULT_DIRECT_USER: AuthUser = {
  id: "direct_creator",
  email: "creator@procut.local",
  displayName: "Creator (Direct Mode)",
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isGuest: true,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(DEFAULT_DIRECT_USER);
  const [status, setStatus] = useState<AuthStatus>("authenticated");

  useEffect(() => {
    let cancelled = false;

    async function initSession() {
      const restored = await refreshSession<AuthUser>();
      if (cancelled) return;
      if (restored) {
        setUser(restored.user);
        setStatus("authenticated");
        return;
      }

      // No existing session to restore (first visit, or an expired
      // refresh cookie). Get a REAL one automatically rather than
      // fabricating a client-only identity with no server-side
      // counterpart: every JWT-protected endpoint — voice over, voice
      // correction, exports — needs an actual access token, not just a
      // user object that looks signed in. Confirmed live: without this,
      // direct mode "worked" only for the two modules (projects, media)
      // that happen to have their own localStorage fallback; everything
      // else 401'd.
      try {
        const data = await apiFetch<AuthResponse>("/auth/guest", { method: "POST" });
        if (cancelled) return;
        setAccessToken(data.accessToken);
        setUser(data.user);
        setStatus("authenticated");
      } catch {
        // The backend itself is unreachable — fall back to a client-only
        // identity so the user is never blocked by a login screen, same
        // as before. This is now the genuine last resort, not the
        // default path.
        if (cancelled) return;
        const stored = typeof window !== "undefined" ? localStorage.getItem("procut_user") : null;
        if (stored) {
          try {
            setUser(JSON.parse(stored));
          } catch {
            setUser(DEFAULT_DIRECT_USER);
          }
        } else {
          setUser(DEFAULT_DIRECT_USER);
        }
        setStatus("authenticated");
      }
    }

    initSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const data = await apiFetch<AuthResponse>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      setAccessToken(data.accessToken);
      setUser(data.user);
      if (typeof window !== "undefined") localStorage.setItem("procut_user", JSON.stringify(data.user));
      setStatus("authenticated");
    } catch {
      // Offline fallback: log in directly
      const localUser: AuthUser = {
        id: "user_" + Math.random().toString(36).slice(2, 9),
        email: email || "creator@procut.local",
        displayName: (email.split("@")[0] || "Creator"),
        emailVerifiedAt: new Date().toISOString(),
        isGuest: true,
      };
      setUser(localUser);
      if (typeof window !== "undefined") localStorage.setItem("procut_user", JSON.stringify(localUser));
      setStatus("authenticated");
    }
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    try {
      const data = await apiFetch<AuthResponse>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, displayName }),
      });
      setAccessToken(data.accessToken);
      setUser(data.user);
      if (typeof window !== "undefined") localStorage.setItem("procut_user", JSON.stringify(data.user));
      setStatus("authenticated");
    } catch {
      // Offline fallback: register directly
      const localUser: AuthUser = {
        id: "user_" + Math.random().toString(36).slice(2, 9),
        email: email || "creator@procut.local",
        displayName: displayName || "Creator",
        emailVerifiedAt: new Date().toISOString(),
        isGuest: false,
      };
      setUser(localUser);
      if (typeof window !== "undefined") localStorage.setItem("procut_user", JSON.stringify(localUser));
      setStatus("authenticated");
    }
  }, []);

  const guestLogin = useCallback(async () => {
    try {
      const data = await apiFetch<AuthResponse>("/auth/guest", { method: "POST" });
      setAccessToken(data.accessToken);
      setUser(data.user);
      setStatus("authenticated");
    } catch {
      // Offline fallback
      setUser(DEFAULT_DIRECT_USER);
      setStatus("authenticated");
    }
  }, []);

  const logout = useCallback(async () => {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    setAccessToken(null);
    if (typeof window !== "undefined") localStorage.removeItem("procut_user");
    setUser(DEFAULT_DIRECT_USER);
    setStatus("authenticated");
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await apiFetch<AuthUser>("/auth/me");
      setUser(me);
    } catch {
      // Keep existing user
    }
  }, []);

  return <AuthContext.Provider value={{ user, status, login, register, guestLogin, logout, refreshUser }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
