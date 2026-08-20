// admin.api 单元测试 — PATCH /api/admin/users/[id]（用户管理操作 action 分发）
// mock 系统边界：requireRole（鉴权）+ adminService（业务）
// 核心契约（MAJOR#3 回归护栏）：userActionSchema 用 discriminatedUnion 把 action 与参数强耦合
//  - setRole 缺 role / setStatus 缺 status / resetPassword 缺 tempPassword → 一律 422
//  - 参数齐全 → 对应 service 收到正确参数（无 `!` 断言、无 undefined 泄漏进 service）

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/api/auth", () => ({
  requireRole: vi.fn(),
  ADMIN_ROLES: ["ADMIN", "SUPER"],
  AFTERSALES_ROLES: ["ADMIN", "SUPER", "CUSTOMER_SERVICE"],
  SERVICE_ROLES: ["CUSTOMER_SERVICE", "SUPER"],
  INSPECT_ROLES: ["QUALITY_INSPECTOR", "SUPER"],
}));

vi.mock("@/features/admin/admin.service", () => ({
  setUserRole: vi.fn(),
  setUserStatus: vi.fn(),
  unlockUser: vi.fn(),
  resetPassword: vi.fn(),
  clearAgeVerification: vi.fn(),
}));

vi.mock("@/features/admin/admin.queries", () => ({
  getAdminOrders: vi.fn(),
}));

import { patchUser, getOrders } from "@/features/admin/admin.api";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import * as auth from "@/shared/api/auth";
import * as adminService from "@/features/admin/admin.service";
import * as adminQueries from "@/features/admin/admin.queries";

const requireRoleMock = vi.mocked(auth.requireRole);
const setUserRoleMock = vi.mocked(adminService.setUserRole);
const setUserStatusMock = vi.mocked(adminService.setUserStatus);
const resetPasswordMock = vi.mocked(adminService.resetPassword);
const clearAgeMock = vi.mocked(adminService.clearAgeVerification);
const getAdminOrdersMock = vi.mocked(adminQueries.getAdminOrders);

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/users/user-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "user-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({ userId: "admin-1", role: "ADMIN" } as never);
});

describe("PATCH /api/admin/users/[id] — 参数与 action 耦合", () => {
  it("setRole 缺 role → 422 VALIDATION_ERROR，不调 service", async () => {
    const res = await patchUser(makeRequest({ action: "setRole" }), ctx);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it("setStatus 缺 status → 422，不调 service", async () => {
    const res = await patchUser(makeRequest({ action: "setStatus" }), ctx);

    expect(res.status).toBe(422);
    expect(setUserStatusMock).not.toHaveBeenCalled();
  });

  it("resetPassword 缺 tempPassword → 422，不调 service（杜绝 undefined 进哈希导致 500）", async () => {
    const res = await patchUser(makeRequest({ action: "resetPassword" }), ctx);

    expect(res.status).toBe(422);
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it("setRole 参数齐全 → 调 setUserRole(id, role, admin.userId, admin.role)", async () => {
    setUserRoleMock.mockResolvedValue(undefined);

    const res = await patchUser(makeRequest({ action: "setRole", role: "BRAND" }), ctx);

    expect(res.status).toBe(200);
    expect(setUserRoleMock).toHaveBeenCalledWith("user-1", "BRAND", "admin-1", "ADMIN");
  });

  it("resetPassword 参数齐全 → 返回一次临时密码透传", async () => {
    resetPasswordMock.mockResolvedValue({ tempPassword: "Temp@123456" });

    const res = await patchUser(makeRequest({ action: "resetPassword", tempPassword: "Temp@123456" }), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tempPassword).toBe("Temp@123456");
    expect(resetPasswordMock).toHaveBeenCalledWith("user-1", "Temp@123456", "admin-1", "ADMIN");
  });

  it("clearAgeVerification 无需参数 → 正常分发", async () => {
    clearAgeMock.mockResolvedValue(undefined);

    const res = await patchUser(makeRequest({ action: "clearAgeVerification" }), ctx);

    expect(res.status).toBe(200);
    expect(clearAgeMock).toHaveBeenCalledWith("user-1", "admin-1", "ADMIN");
  });

  it("非法 action → 422", async () => {
    const res = await patchUser(makeRequest({ action: "deleteUser" }), ctx);

    expect(res.status).toBe(422);
    expect(requireRoleMock).toHaveBeenCalled();
  });

  it("未授权（非 ADMIN）→ 403 透传 requireRole 错误", async () => {
    requireRoleMock.mockRejectedValue(
      new AppError(ERROR_CODES.FORBIDDEN, "无权限执行此操作"),
    );

    const res = await patchUser(makeRequest({ action: "unlock" }), ctx);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: ERROR_CODES.FORBIDDEN.code });
  });
});

// ── GET /api/admin/orders — 已销毁订单按需查询参数解析 ──

describe("GET /api/admin/orders — orderId/destroyed 查询参数", () => {
  beforeEach(() => {
    getAdminOrdersMock.mockResolvedValue({
      orders: [],
      total: 0,
      page: 1,
      pageSize: 20,
    } as never);
  });

  it("无参数 → orderId/destroyed 均为 undefined 透传（默认隐藏已销毁）", async () => {
    const req = new Request("http://localhost/api/admin/orders");

    await getOrders(req);

    expect(getAdminOrdersMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: undefined, destroyed: undefined }),
    );
  });

  it("orderId=xxx → 透传 orderId（按订单号精确查单笔含已销毁）", async () => {
    const req = new Request("http://localhost/api/admin/orders?orderId=ord-1");

    await getOrders(req);

    expect(getAdminOrdersMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "ord-1" }),
    );
  });

  it("destroyed=only → 透传 destroyed=only（只看已销毁订单）", async () => {
    const req = new Request("http://localhost/api/admin/orders?destroyed=only");

    await getOrders(req);

    expect(getAdminOrdersMock).toHaveBeenCalledWith(
      expect.objectContaining({ destroyed: "only" }),
    );
  });

  it("destroyed=其他值 → 不解析为 only（undefined，防脏值混入）", async () => {
    const req = new Request("http://localhost/api/admin/orders?destroyed=yes");

    await getOrders(req);

    expect(getAdminOrdersMock).toHaveBeenCalledWith(
      expect.objectContaining({ destroyed: undefined }),
    );
  });

  it("非售后角色 → 403 透传 requireRole 错误，不调 queries", async () => {
    requireRoleMock.mockRejectedValue(
      new AppError(ERROR_CODES.FORBIDDEN, "无权限执行此操作"),
    );
    const req = new Request("http://localhost/api/admin/orders");

    const res = await getOrders(req);

    expect(res.status).toBe(403);
    expect(getAdminOrdersMock).not.toHaveBeenCalled();
  });
});
