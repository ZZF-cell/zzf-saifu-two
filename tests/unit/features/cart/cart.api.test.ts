// cart.api 单元测试 — 仅 USER 角色可购物（requireRole 守卫）
// mock 系统边界：requireRole（鉴权）+ cart.service（业务）
// 核心契约：
// - USER 角色 → 四个端点正常放行并调用对应 service
// - 非 USER 角色（BRAND/客服/质检/ADMIN/SUPER）→ 403 FORBIDDEN「无权限」，不调 service
// - 游客（requireRole 抛 UNAUTHORIZED）→ 401（前端据此跳登录页）

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/api/auth", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/features/cart/cart.service", () => ({
  getCart: vi.fn(),
  addToCart: vi.fn(),
  updateCartQty: vi.fn(),
  removeFromCart: vi.fn(),
}));

import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { getCart, addToCart, updateCart, removeFromCart } from "@/features/cart/cart.api";
import * as auth from "@/shared/api/auth";
import * as cartService from "@/features/cart/cart.service";

const requireRoleMock = vi.mocked(auth.requireRole);
const getCartMock = vi.mocked(cartService.getCart);
const addToCartMock = vi.mocked(cartService.addToCart);
const updateCartQtyMock = vi.mocked(cartService.updateCartQty);
const removeFromCartMock = vi.mocked(cartService.removeFromCart);

function makeRequest(url: string, body?: unknown, method = "GET"): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

const forbidden = () =>
  requireRoleMock.mockRejectedValue(new AppError(ERROR_CODES.FORBIDDEN, "无权限执行此操作"));
const unauthorized = () =>
  requireRoleMock.mockRejectedValue(new AppError(ERROR_CODES.UNAUTHORIZED, "请先登录"));

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({ userId: "user-1", role: "USER" });
  getCartMock.mockResolvedValue({ items: [], totalCount: 0, totalAmount: 0 } as never);
  addToCartMock.mockResolvedValue(undefined);
  updateCartQtyMock.mockResolvedValue(undefined);
  removeFromCartMock.mockResolvedValue(undefined);
});

describe("GET /api/cart", () => {
  it("USER → 200 返回购物车", async () => {
    const res = await getCart(makeRequest("http://localhost/api/cart"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], totalCount: 0, totalAmount: 0 });
    expect(requireRoleMock).toHaveBeenCalledWith(expect.anything(), ["USER"]);
    expect(getCartMock).toHaveBeenCalledWith("user-1");
  });

  it("非 USER 角色 → 403 FORBIDDEN，不调 service", async () => {
    forbidden();

    const res = await getCart(makeRequest("http://localhost/api/cart"));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("FORBIDDEN");
    expect(getCartMock).not.toHaveBeenCalled();
  });

  it("游客 → 401 UNAUTHORIZED", async () => {
    unauthorized();

    const res = await getCart(makeRequest("http://localhost/api/cart"));

    expect(res.status).toBe(401);
    expect(getCartMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/cart — 添加商品", () => {
  it("USER → 200 success，addToCart 收到 qty 默认 1", async () => {
    const res = await addToCart(
      makeRequest("http://localhost/api/cart", { productId: "p1" }, "POST"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(addToCartMock).toHaveBeenCalledWith("user-1", "p1", 1);
  });

  it("USER 传 qty → 透传到 service", async () => {
    await addToCart(
      makeRequest("http://localhost/api/cart", { productId: "p1", qty: 3 }, "POST"),
    );

    expect(addToCartMock).toHaveBeenCalledWith("user-1", "p1", 3);
  });

  it("非 USER 角色 → 403，不调 service（点击加购显示无权限）", async () => {
    forbidden();

    const res = await addToCart(
      makeRequest("http://localhost/api/cart", { productId: "p1" }, "POST"),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe("无权限执行此操作");
    expect(addToCartMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/cart — 修改数量", () => {
  it("USER → 200，updateCartQty 收到 qty", async () => {
    const res = await updateCart(
      makeRequest("http://localhost/api/cart", { productId: "p1", qty: 2 }, "PATCH"),
    );

    expect(res.status).toBe(200);
    expect(updateCartQtyMock).toHaveBeenCalledWith("user-1", "p1", 2);
  });

  it("非 USER 角色 → 403，不调 service", async () => {
    forbidden();

    const res = await updateCart(
      makeRequest("http://localhost/api/cart", { productId: "p1", qty: 2 }, "PATCH"),
    );

    expect(res.status).toBe(403);
    expect(updateCartQtyMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/cart — 删除商品", () => {
  it("USER → 200，removeFromCart 收到 productId", async () => {
    const res = await removeFromCart(
      makeRequest("http://localhost/api/cart", { productId: "p1" }, "DELETE"),
    );

    expect(res.status).toBe(200);
    expect(removeFromCartMock).toHaveBeenCalledWith("user-1", "p1");
  });

  it("非 USER 角色 → 403，不调 service", async () => {
    forbidden();

    const res = await removeFromCart(
      makeRequest("http://localhost/api/cart", { productId: "p1" }, "DELETE"),
    );

    expect(res.status).toBe(403);
    expect(removeFromCartMock).not.toHaveBeenCalled();
  });
});
