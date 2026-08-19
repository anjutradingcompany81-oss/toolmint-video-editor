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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    // A page load has no access token in memory — try the refresh cookie to
    // restore a session before deciding the user is logged out. Goes through
    // the shared, deduped refreshSession() (not a raw fetch) so this doesn't
    // race a concurrent 401 auto-retry, or React re-invoking this effect, and
    // trip the server's refresh-token-reuse detection.
    refreshSession<AuthUser>().then((data) => {
      if (cancelled) return;
      if (data) {
        setUser(data.user);
        setStatus("authenticated");
      } else {
        setUser(null);
        setStatus("unauthenticated");
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiFetch<AuthResponse>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    setAccessToken(data.accessToken);
    setUser(data.user);
    setStatus("authenticated");
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    const data = await apiFetch<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName }),
    });
    setAccessToken(data.accessToken);
    setUser(data.user);
    setStatus("authenticated");
  }, []);

  const guestLogin = useCallback(async () => {
    const data = await apiFetch<AuthResponse>("/auth/guest", { method: "POST" });
    setAccessToken(data.accessToken);
    setUser(data.user);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await apiFetch<AuthUser>("/auth/me");
    setUser(me);
  }, []);

  return <AuthContext.Provider value={{ user, status, login, register, guestLogin, logout, refreshUser }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
