// authenticateUser / requireRole 单元测试 — 无状态 JWT 载荷与 DB 实时状态校准
// mock 系统边界：authService（verifyAccessToken / getUserAuthContext）——不真实验签，只测校准逻辑
// 契约：
// - 无 token / token 失效 → UNAUTHORIZED / TOKEN_EXPIRED
// - 用户被禁用（DB status=DISABLED）→ 403 USER_DISABLED（不等 token 自然过期，立即生效）
// - 用户在 DB 中不存在 → UNAUTHORIZED
// - DB 角色实时值优先于 token 载荷（管理员降权/升权即刻生效）
// - requireRole 角色不符 → FORBIDDEN

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/features/auth", () => ({
  authService: {
    verifyAccessToken: vi.fn(),
    getUserAuthContext: vi.fn(),
  },
}));

import { authenticateUser, requireRole } from "@/shared/api/auth";
import { authService } from "@/features/auth";
import { ERROR_CODES } from "@/shared/errors/errors";

function makeRequest(token: string | null = "valid-jwt"): Request {
  const cookie = token ? `access_token=${token}` : "";
  return new Request("http://localhost/api/test", {
    headers: { cookie },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateUser — token 载荷与 DB 实时状态校准", () => {
  it("无 access token → UNAUTHORIZED", async () => {
    await expect(authenticateUser(makeRequest(null))).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHORIZED.code,
    });
    expect(vi.mocked(authService.verifyAccessToken)).not.toHaveBeenCalled();
  });

  it("token 失效 → TOKEN_EXPIRED", async () => {
    vi.mocked(authService.verifyAccessToken).mockResolvedValue(null);
    await expect(authenticateUser(makeRequest())).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED.code,
    });
  });

  it("DB 用户已不存在 → UNAUTHORIZED（token 虽有效，账号已删除）", async () => {
    vi.mocked(authService.verifyAccessToken).mockResolvedValue({
      userId: "user-1",
      role: "USER",
    } as never);
    vi.mocked(authService.getUserAuthContext).mockResolvedValue(null);

    await expect(authenticateUser(makeRequest())).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHORIZED.code,
    });
  });

  it("用户被禁用（status=DISABLED）→ 403 USER_DISABLED，立即拒绝而非等 token 过期", async () => {
    vi.mocked(authService.verifyAccessToken).mockResolvedValue({
      userId: "user-1",
      role: "USER",
    } as never);
    vi.mocked(authService.getUserAuthContext).mockResolvedValue({
      id: "user-1",
      role: "USER",
      status: "DISABLED",
    });

    await expect(authenticateUser(makeRequest())).rejects.toMatchObject({
      code: ERROR_CODES.USER_DISABLED.code,
      statusCode: 403,
    });
  });

  it("正常 ACTIVE 用户 → 返回 DB 实时 role（而非 token 载荷里的旧 role）", async () => {
    // token 载荷还是 USER（降权前签发），DB 实时已是 ADMIN → 返回 ADMIN
    vi.mocked(authService.verifyAccessToken).mockResolvedValue({
      userId: "user-1",
      role: "USER",
    } as never);
    vi.mocked(authService.getUserAuthContext).mockResolvedValue({
      id: "user-1",
      role: "ADMIN",
      status: "ACTIVE",
    });

    const ctx = await authenticateUser(makeRequest());
    expect(ctx).toEqual({ userId: "user-1", role: "ADMIN" });
  });
});

describe("requireRole — 角色门禁", () => {
  it("角色不符 → FORBIDDEN", async () => {
    vi.mocked(authService.verifyAccessToken).mockResolvedValue({
      userId: "user-1",
      role: "USER",
    } as never);
    vi.mocked(authService.getUserAuthContext).mockResolvedValue({
      id: "user-1",
      role: "USER",
      status: "ACTIVE",
    });

    await expect(requireRole(makeRequest(), ["ADMIN"])).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN.code,
    });
  });

  it("角色匹配 → 返回用户上下文", async () => {
    vi.mocked(authService.verifyAccessToken).mockResolvedValue({
      userId: "user-1",
      role: "BRAND",
    } as never);
    vi.mocked(authService.getUserAuthContext).mockResolvedValue({
      id: "user-1",
      role: "BRAND",
      status: "ACTIVE",
    });

    const ctx = await requireRole(makeRequest(), ["BRAND", "ADMIN"]);
    expect(ctx.role).toBe("BRAND");
  });
});
