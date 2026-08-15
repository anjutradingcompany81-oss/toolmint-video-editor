const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === "string") return message;
      if (Array.isArray(message)) return message.join(", ");
    }
  } catch {
    // Response body wasn't JSON — fall through to the status text.
  }
  return res.statusText || "Request failed";
}

interface RefreshResponse<TUser> {
  accessToken: string;
  user: TUser;
}

let refreshPromise: Promise<RefreshResponse<unknown> | null> | null = null;

// Refresh tokens rotate on every use, and a reused (already-rotated) token
// is treated server-side as theft, revoking every session. Two callers
// racing to refresh from the same starting cookie — e.g. React invoking an
// effect twice, or a 401 retry overlapping a mount-time refresh — would
// trip that. Deduping onto a single in-flight request is what prevents it,
// so every caller (mount-time session restore, 401 auto-retry) MUST go
// through this function rather than fetching /auth/refresh directly.
async function requestRefresh<TUser>(): Promise<RefreshResponse<TUser> | null> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          setAccessToken(null);
          return null;
        }
        const data: RefreshResponse<unknown> = await res.json();
        setAccessToken(data.accessToken);
        return data;
      })
      .catch(() => {
        setAccessToken(null);
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise as Promise<RefreshResponse<TUser> | null>;
}

export function refreshSession<TUser>(): Promise<RefreshResponse<TUser> | null> {
  return requestRefresh<TUser>();
}

interface ApiFetchOptions extends RequestInit {
  skipAuthRetry?: boolean;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const res = await fetch(`${API_URL}${path}`, { ...options, headers, credentials: "include" });

  if (res.status === 401 && !options.skipAuthRetry && path !== "/auth/refresh") {
    const refreshed = await requestRefresh();
    if (refreshed) return apiFetch<T>(path, { ...options, skipAuthRetry: true });
  }

  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
