"use client";

// 前端 API fetch 封装 — 401 时自动刷新 Access Token 并重试一次
// 使用场景：Access Token（15min）过期时，前端自动调 /api/auth/refresh 轮换，
// 避免用户操作到一半被弹回登录页。Refresh Token 也失效（7d 过期/被吊销）才跳转登录。
//
// 并发去抖：多个请求同时 401 时共享同一次 refresh（避免刷新风暴）。

let refreshing: Promise<boolean> | null = null;

/** 刷新 Access Token（单例，多个并发 401 共享） */
async function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/** 刷新失败 → 登出并跳转登录页 */
function redirectToLogin(): void {
  if (typeof window !== "undefined") {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?redirect=${redirect}`;
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
  if (!refreshed) {
    redirectToLogin();
    throw new Error("登录已过期，请重新登录");
  }

  const retried = await fetch(input, { ...init, credentials: "include" });
  if (retried.status === 401) {
    redirectToLogin();
    throw new Error("登录已过期，请重新登录");
  }
  return retried;
}
