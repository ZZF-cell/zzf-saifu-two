// auth.api 单元测试 — GET /api/auth/me（登录态查询，供前端导航）
// mock 系统边界：authService.verifyAccessToken + authQueries.getUserById
// 契约：
// - 无 cookie → 401 UNAUTHORIZED；token 无效 → 401 TOKEN_EXPIRED
// - 用户不存在 → 401；有效 → 200 返回安全字段 {id,nickname,role,ageVerified}，绝不带 phoneHash

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/features/auth/auth.service", () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock("@/features/auth/auth.queries", () => ({
  getUserById: vi.fn(),
  getUserByPhone: vi.fn(),
}));

import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { meHandler } from "@/features/auth/auth.api";
import * as authService from "@/features/auth/auth.service";
import * as authQueries from "@/features/auth/auth.queries";

const verifyMock = vi.mocked(authService.verifyAccessToken);
const getUserByIdMock = vi.mocked(authQueries.getUserById);

function makeRequest(cookie?: string): Request {
  return new Request("http://localhost/api/auth/me", {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me", () => {
  it("无 cookie → 401 UNAUTHORIZED，不查库", async () => {
    const res = await meHandler(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "UNAUTHORIZED" });
    expect(verifyMock).not.toHaveBeenCalled();
    expect(getUserByIdMock).not.toHaveBeenCalled();
  });

  it("token 无效（verifyAccessToken → null）→ 401 TOKEN_EXPIRED", async () => {
    verifyMock.mockResolvedValue(null);

    const res = await meHandler(makeRequest("access_token=fake-token"));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "TOKEN_EXPIRED" });
    expect(getUserByIdMock).not.toHaveBeenCalled();
  });

  it("有效 token 但用户不存在 → 401", async () => {
    verifyMock.mockResolvedValue({ userId: "user-1", role: "USER" });
    getUserByIdMock.mockResolvedValue(null);

    const res = await meHandler(makeRequest("access_token=valid"));

    expect(res.status).toBe(401);
    expect(getUserByIdMock).toHaveBeenCalledWith("user-1");
  });

  it("有效 → 200 返回安全字段，绝不带 phoneHash", async () => {
    verifyMock.mockResolvedValue({ userId: "user-1", role: "USER" });
    getUserByIdMock.mockResolvedValue({
      id: "user-1",
      phoneHash: "HASH-SECRET",
      nickname: "昵称",
      role: "USER",
      ageVerified: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await meHandler(makeRequest("access_token=valid"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.user).toEqual({
      id: "user-1",
      nickname: "昵称",
      role: "USER",
      ageVerified: true,
    });
    expect(body.user).not.toHaveProperty("phoneHash");
    expect(JSON.stringify(body)).not.toContain("HASH-SECRET");
  });
});
