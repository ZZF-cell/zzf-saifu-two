// auth.api 单元测试 — POST /api/auth/refresh（Refresh Rotation 响应映射）
// mock 系统边界：authService.refreshAccessToken
// 契约（#5 回归护栏）：refreshHandler 的 catch 必须区分错误来源 ——
// USER_DISABLED 是「拒绝续期」应透传 403（前端提示「账号已被禁用」），
// 其余（token 失效/冲突）统一 401 TOKEN_EXPIRED（清 Cookie 要求重新登录）

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/features/auth/auth.service", () => ({
  refreshAccessToken: vi.fn(),
}));

import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { refreshHandler } from "@/features/auth/auth.api";
import * as authService from "@/features/auth/auth.service";

const refreshMock = vi.mocked(authService.refreshAccessToken);

function makeRequest(refreshToken?: string): Request {
  return new Request("http://localhost/api/auth/refresh", {
    method: "POST",
    headers: refreshToken ? { cookie: `refresh_token=${refreshToken}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 静默失败路径的 console.error，保持测试输出干净
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/auth/refresh — 错误映射", () => {
  it("无 refresh_token → 401 TOKEN_EXPIRED，不调 service", async () => {
    const res = await refreshHandler(makeRequest());

    expect(res.status).toBe(ERROR_CODES.TOKEN_EXPIRED.status);
    expect(await res.json()).toMatchObject({ error: "TOKEN_EXPIRED" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("被禁用用户续期（service 抛 USER_DISABLED）→ 透传 403 + message，并吊销 cookie", async () => {
    refreshMock.mockRejectedValue(
      new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员"),
    );

    const res = await refreshHandler(makeRequest("raw-token"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      error: "USER_DISABLED",
      message: "账号已被禁用，请联系管理员",
    });
    // 不返回误导性的「登录已过期」；同时清 Cookie 让前端退出
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("token 失效/冲突（TOKEN_EXPIRED）→ 统一 401 TOKEN_EXPIRED，清 Cookie", async () => {
    refreshMock.mockRejectedValue(
      new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录"),
    );

    const res = await refreshHandler(makeRequest("raw-token"));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "TOKEN_EXPIRED" });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("成功轮换 → 200，签发新 access/refresh cookie", async () => {
    refreshMock.mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });

    const res = await refreshHandler(makeRequest("raw-token"));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("access_token=new-access");
    expect(setCookie).toContain("refresh_token=new-refresh");
  });
});
