// admin.service 单元测试 — 后台状态变更（updateMany 状态守卫 + 审计同事务 + 409 语义）
// mock 系统边界：prisma $transaction（交互事务内 brand/product/order/categoryAuditTemplate/auditLog）
// 只测公共 seam：admin.service 的 reviewBrand / reviewProduct / shipOrder / deliverOrder / completeOrder / confirmRefund
//
// 核心契约：
// - 所有状态变更带状态守卫（updateMany where status=X），命中 0 行抛错
// - 重复审核抛 409（实体存在）而非 404「不存在」误导调用方
// - 状态变更与审计日志在同一 $transaction：审计失败整体回滚，不留「状态已变但无审计」的账

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    brand: { updateMany: vi.fn(), findUnique: vi.fn() },
    product: { updateMany: vi.fn(), findUnique: vi.fn() },
    order: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    categoryAuditTemplate: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// admin.service 从 @/features/orders 引入 ORDER_STATUS；
// 直接走 feature index 会经过 orders.routes → next/navigation（node 环境不可用），
// 故 mock 该模块仅提供常量，与实际 state-machine 值保持一致
vi.mock("@/features/orders", () => ({
  ORDER_STATUS: {
    PENDING: "PENDING",
    PAID: "PAID",
    SHIPPED: "SHIPPED",
    DELIVERED: "DELIVERED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    REFUND_REQUESTED: "REFUND_REQUESTED",
    REFUNDED: "REFUNDED",
  },
}));

import { prisma } from "@/shared/db/client";
import { ERROR_CODES } from "@/shared/errors/errors";
import {
  reviewBrand,
  reviewProduct,
  shipOrder,
  deliverOrder,
  completeOrder,
  confirmRefund,
} from "@/features/admin/admin.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type Tx = {
  brand: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  product: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  order: { updateMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  categoryAuditTemplate: { upsert: ReturnType<typeof vi.fn> };
};

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    brand: { updateMany: vi.fn(), findUnique: vi.fn() },
    product: { updateMany: vi.fn(), findUnique: vi.fn() },
    order: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    categoryAuditTemplate: { upsert: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

// ── 品牌审核 ──

describe("reviewBrand — 品牌入驻审核", () => {
  it("PENDING 品牌 → 置 APPROVED + 审计日志（同事务）", async () => {
    tx.brand.updateMany.mockResolvedValue({ count: 1 });

    await reviewBrand("brand-1", "APPROVED", "admin-1");

    expect(tx.brand.updateMany).toHaveBeenCalledWith({
      where: { id: "brand-1", status: "PENDING" },
      data: { status: "APPROVED" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Brand", targetId: "brand-1", action: "REVIEW_APPROVED", operatorId: "admin-1" },
    });
  });

  it("REJECTED 决策同样落审计日志", async () => {
    tx.brand.updateMany.mockResolvedValue({ count: 1 });

    await reviewBrand("brand-2", "REJECTED", "admin-1");

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Brand", targetId: "brand-2", action: "REVIEW_REJECTED", operatorId: "admin-1" },
    });
  });

  it("守卫 0 行但品牌存在（已被审核）→ 抛 409 BRAND_ALREADY_REVIEWED，不写审计", async () => {
    tx.brand.updateMany.mockResolvedValue({ count: 0 });
    tx.brand.findUnique.mockResolvedValue({ id: "brand-1" });

    await expect(reviewBrand("brand-1", "APPROVED", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_ALREADY_REVIEWED.code,
      statusCode: 409,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("守卫 0 行且品牌不存在 → 抛 404 BRAND_NOT_FOUND", async () => {
    tx.brand.updateMany.mockResolvedValue({ count: 0 });
    tx.brand.findUnique.mockResolvedValue(null);

    await expect(reviewBrand("brand-x", "APPROVED", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_NOT_FOUND.code,
      statusCode: 404,
    });
  });

  it("审计日志失败 → 整体抛错回滚，不留「状态已变但无审计」的账", async () => {
    tx.brand.updateMany.mockResolvedValue({ count: 1 });
    tx.auditLog.create.mockRejectedValue(new Error("DB down"));

    await expect(reviewBrand("brand-1", "APPROVED", "admin-1")).rejects.toThrow("DB down");
  });
});

// ── 商品质检 ──

describe("reviewProduct — 商品质检", () => {
  it("PENDING 商品 → 置 APPROVED + 审计日志", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await reviewProduct("product-1", "APPROVED", "admin-1");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "PENDING" },
      data: { status: "APPROVED" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Product", targetId: "product-1", action: "REVIEW_APPROVED", operatorId: "admin-1" },
    });
  });

  it("守卫 0 行但商品存在（已质检）→ 抛 409 PRODUCT_ALREADY_REVIEWED", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue({ id: "product-1" });

    await expect(reviewProduct("product-1", "REJECTED", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_ALREADY_REVIEWED.code,
      statusCode: 409,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("守卫 0 行且商品不存在 → 抛 404 PRODUCT_NOT_FOUND", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue(null);

    await expect(reviewProduct("product-x", "REJECTED", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_NOT_FOUND.code,
    });
  });
});

// ── 发货 ──

describe("shipOrder — 发货（PAID → SHIPPED）", () => {
  it("PAID 订单 → 置 SHIPPED + shippedAt + 审计日志", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await shipOrder("order-1", "admin-1");

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PAID" },
      data: { status: "SHIPPED", shippedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Order", targetId: "order-1", action: "SHIPPED", operatorId: "admin-1" },
    });
  });

  it("订单非 PAID（守卫 0 行）→ 抛 ORDER_STATUS_INVALID（防并发退款/取消冲突）", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(shipOrder("order-x", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.ORDER_STATUS_INVALID.code,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── 标记送达 ──

describe("deliverOrder — 标记送达（SHIPPED → DELIVERED）", () => {
  it("SHIPPED 订单 → 置 DELIVERED + deliveredAt + 审计日志", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await deliverOrder("order-1", "admin-1");

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "SHIPPED" },
      data: { status: "DELIVERED", deliveredAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Order", targetId: "order-1", action: "DELIVERED", operatorId: "admin-1" },
    });
  });

  it("订单非 SHIPPED → 抛 ORDER_STATUS_INVALID", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(deliverOrder("order-x", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.ORDER_STATUS_INVALID.code,
    });
  });
});

// ── 完成 ──

describe("completeOrder — 完成（DELIVERED → COMPLETED）", () => {
  it("DELIVERED 订单 → 置 COMPLETED + completedAt + 审计日志", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await completeOrder("order-1", "admin-1");

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "DELIVERED" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Order", targetId: "order-1", action: "COMPLETED", operatorId: "admin-1" },
    });
  });

  it("订单非 DELIVERED → 抛 ORDER_STATUS_INVALID", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(completeOrder("order-x", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.ORDER_STATUS_INVALID.code,
    });
  });
});

// ── 确认退款 ──

describe("confirmRefund — 确认退款（REFUND_REQUESTED → REFUNDED）", () => {
  it("退款中订单 → 置 REFUNDED + refundedAt + 审计日志", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await confirmRefund("order-1", "admin-1");

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "REFUND_REQUESTED" },
      data: { status: "REFUNDED", refundedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Order", targetId: "order-1", action: "REFUND_CONFIRMED", operatorId: "admin-1" },
    });
  });

  it("非退款中订单（守卫 0 行）→ 抛 ORDER_STATUS_INVALID", async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(confirmRefund("order-x", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.ORDER_STATUS_INVALID.code,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
