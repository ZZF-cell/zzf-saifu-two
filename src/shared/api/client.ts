"use client";

// 前端 API fetch 封装 — 401 时自动刷新 Access Token 并重试一次
// 使用场景：Access Token（15min）过期时，前端自动调 /api/auth/refresh 轮换，
// 避免用户操作到一半被弹回登录页。Refresh Token 也失效（7d 过期/被吊销）才跳转登录。
//
// 并发去抖：多个请求同时 401 时共享同一次 refresh（避免刷新风暴）。

let refreshing: Promise<RefreshResult> | null = null;

type RefreshResult = "ok" | "disabled" | "failed";

/**
 * 刷新 Access Token（单例，多个并发 401 共享）
 * 结果三态：ok（成功）/ disabled（账号被禁用）/ failed（其余失败）
 */
async function refreshAccessToken(): Promise<RefreshResult> {
  if (refreshing) return refreshing;
  const pending = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
      if (res.ok) return "ok" as const;
      // 后端对禁用账号透传 USER_DISABLED(403)：读取响应体区分「拒绝续期」与「会话过期」，
      // 避免把被禁用用户误导性地提示为「登录已过期」
      const body = await res.json().catch(() => null);
      return body?.error === "USER_DISABLED" ? ("disabled" as const) : ("failed" as const);
    } catch {
      return "failed" as const;
    } finally {
      refreshing = null;
    }
  })();
  refreshing = pending;
  return pending;
}

/** 刷新失败 → 登出并跳转登录页（disabled 时带标记供登录页提示「账号已被禁用」） */
function redirectToLogin(disabled = false): void {
  if (typeof window !== "undefined") {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?redirect=${redirect}${disabled ? "&disabled=1" : ""}`;
  }
}

/**
 * 带自动刷新的 fetch
 * - 首次请求非 401 → 直接返回
 * - 401 → 刷新 Access Token → 重试原请求一次
 * - 刷新失败或重试仍 401 → 跳转登录页并抛错
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (res.status !== 401) return res;

  const refreshed = await refreshAccessToken();
  if (refreshed !== "ok") {
    const disabled = refreshed === "disabled";
    redirectToLogin(disabled);
    throw new Error(disabled ? "账号已被禁用，请联系管理员" : "登录已过期，请重新登录");
  }

  const retried = await fetch(input, { ...init, credentials: "include" });
  if (retried.status === 401) {
    redirectToLogin();
    throw new Error("登录已过期，请重新登录");
  }
  return retried;
}
