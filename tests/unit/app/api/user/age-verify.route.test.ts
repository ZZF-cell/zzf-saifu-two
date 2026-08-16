// POST /api/user/age-verify 单元测试（L4 服务端签发）
// mock 系统边界：auth.service（verifyAccessToken/setAgeVerified）+ signAgeVerified（签名）
// 核心契约：
// - 匿名用户也可获得签名 cookie（门禁通行证与登录解耦），不再强制 401
// - 响应 Set-Cookie 携带 age_verified 签名值，中间件验签放行
// - 签名密钥缺失（signAgeVerified → null）→ 500，绝不发无签名 cookie
// - 已登录用户额外同步 DB ageVerified（best-effort，token 失效静默忽略）

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/features/auth/auth.service", () => ({
  verifyAccessToken: vi.fn(),
  setAgeVerified: vi.fn(),
}));
vi.mock("@/shared/utils/age-verified", () => ({
  signAgeVerified: vi.fn(),
}));

import { POST } from "@/app/api/user/age-verify/route";
import * as authService from "@/features/auth/auth.service";
import { signAgeVerified } from "@/shared/utils/age-verified";

const verifyTokenMock = vi.mocked(authService.verifyAccessToken);
const setAgeVerifiedMock = vi.mocked(authService.setAgeVerified);
const signMock = vi.mocked(signAgeVerified);

function makeRequest(cookie?: string): Request {
  return new Request("http://localhost/api/user/age-verify", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signMock.mockResolvedValue("1700000000000.abcdef");
});

describe("POST /api/user/age-verify — 服务端签发签名 cookie", () => {
  it("匿名（无 token）→ 200 + Set-Cookie age_verified 签名值，不查 DB", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("age_verified=1700000000000.abcdef");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it("已登录且 token 有效 → 同步 DB ageVerified 并签发 cookie", async () => {
    verifyTokenMock.mockResolvedValue({ userId: "u1", role: "USER" } as never);
    setAgeVerifiedMock.mockResolvedValue(undefined as never);

    const res = await POST(makeRequest("access_token=abc"));

    expect(res.status).toBe(200);
    expect(verifyTokenMock).toHaveBeenCalledWith("abc");
    expect(setAgeVerifiedMock).toHaveBeenCalledWith("u1");
    expect(res.headers.get("set-cookie")).toContain("age_verified=");
  });

  it("token 失效（同步失败）→ 仍签发 cookie（不阻断匿名年龄认证）", async () => {
    verifyTokenMock.mockRejectedValue(new Error("expired"));

    const res = await POST(makeRequest("access_token=expired"));

    expect(res.status).toBe(200);
    expect(setAgeVerifiedMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toContain("age_verified=");
  });

  it("签名密钥缺失（signAgeVerified → null）→ 500，绝不下发无签名 cookie", async () => {
    signMock.mockResolvedValue(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
