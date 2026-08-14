// admin.service 单元测试 — 后台状态变更（updateMany 状态守卫 + 审计同事务 + 409 语义）
// mock 系统边界：prisma $transaction（交互事务内 brand/product/order/user/inviteCode/categoryAuditTemplate/auditLog）
// 只测公共 seam：admin.service 的 reviewBrand / reviewProduct / shipOrder / deliverOrder / completeOrder / confirmRefund / generateInviteCodes
//
// 核心契约：
// - 所有状态变更带状态守卫（updateMany where status=X），命中 0 行抛错
// - 重复审核抛 409（实体存在）而非 404「不存在」误导调用方
// - 品牌审核通过 → 负责人同事务升级 BRAND 角色（品牌已过但角色未升是笔错账）
// - 状态变更与审计日志在同一 $transaction：审计失败整体回滚，不留「状态已变但无审计」的账

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    brand: { updateMany: vi.fn(), findUnique: vi.fn() },
    product: { updateMany: vi.fn(), findUnique: vi.fn() },
    order: { updateMany: vi.fn() },
    user: { update: vi.fn() },
    inviteCode: { create: vi.fn() },
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
  delistProduct,
  relistProduct,
  updateProduct,
  shipOrder,
  deliverOrder,
  completeOrder,
  confirmRefund,
  generateInviteCodes,
} from "@/features/admin/admin.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type Tx = {
  brand: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  product: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  order: { updateMany: ReturnType<typeof vi.fn> };
  user: { update: ReturnType<typeof vi.fn> };
  inviteCode: { create: ReturnType<typeof vi.fn> };
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
    user: { update: vi.fn() },
    inviteCode: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    categoryAuditTemplate: { upsert: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

// ── 品牌审核 ──

describe("reviewBrand — 品牌入驻审核", () => {
  it("PENDING 品牌通过 → 置 APPROVED + 负责人升级 BRAND 角色 + 审计日志（同事务）", async () => {
    tx.brand.findUnique.mockResolvedValue({ ownerId: "user-1" });
    tx.brand.updateMany.mockResolvedValue({ count: 1 });

    await reviewBrand("brand-1", "APPROVED", "admin-1");

    expect(tx.brand.findUnique).toHaveBeenCalledWith({
      where: { id: "brand-1" },
      select: { ownerId: true },
    });
    expect(tx.brand.updateMany).toHaveBeenCalledWith({
      where: { id: "brand-1", status: "PENDING" },
      data: { status: "APPROVED" },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { role: "BRAND" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Brand", targetId: "brand-1", action: "REVIEW_APPROVED", operatorId: "admin-1" },
    });
  });

  it("REJECTED 决策不升级角色，同样落审计日志", async () => {
    tx.brand.findUnique.mockResolvedValue({ ownerId: "user-1" });
    tx.brand.updateMany.mockResolvedValue({ count: 1 });

    await reviewBrand("brand-2", "REJECTED", "admin-1");

    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Brand", targetId: "brand-2", action: "REVIEW_REJECTED", operatorId: "admin-1" },
    });
  });

  it("品牌不存在 → 抛 404 BRAND_NOT_FOUND，不触发更新", async () => {
    tx.brand.findUnique.mockResolvedValue(null);

    await expect(reviewBrand("brand-x", "APPROVED", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_NOT_FOUND.code,
      statusCode: 404,
    });
    expect(tx.brand.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("守卫 0 行但品牌存在（已被审核）→ 抛 409 BRAND_ALREADY_REVIEWED，不升级角色不写审计", async () => {
    tx.brand.findUnique.mockResolvedValue({ ownerId: "user-1" });
    tx.brand.updateMany.mockResolvedValue({ count: 0 });

    await expect(reviewBrand("brand-1", "APPROVED", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_ALREADY_REVIEWED.code,
      statusCode: 409,
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("审计日志失败 → 整体抛错回滚，不留「状态已变但无审计」的账", async () => {
    tx.brand.findUnique.mockResolvedValue({ ownerId: "user-1" });
    tx.brand.updateMany.mockResolvedValue({ count: 1 });
    tx.auditLog.create.mockRejectedValue(new Error("DB down"));

    await expect(reviewBrand("brand-1", "APPROVED", "admin-1")).rejects.toThrow("DB down");
  });

  it("角色升级失败 → 整体抛错回滚，不留「品牌通过但角色未升」的账", async () => {
    tx.brand.findUnique.mockResolvedValue({ ownerId: "user-1" });
    tx.brand.updateMany.mockResolvedValue({ count: 1 });
    tx.user.update.mockRejectedValue(new Error("DB down"));

    await expect(reviewBrand("brand-1", "APPROVED", "admin-1")).rejects.toThrow("DB down");
  });
});

// ── 商品质检 ──

describe("reviewProduct — 商品质检", () => {
  it("PENDING 商品 → 置 APPROVED + version bump + 审计日志", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await reviewProduct("product-1", "APPROVED", "admin-1");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "PENDING" },
      data: { status: "APPROVED", version: { increment: 1 } },
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

// ── 商品生命周期：下架 / 重新上架 / 编辑 ──

describe("delistProduct — 下架（APPROVED → DELISTED）", () => {
  it("APPROVED 商品 → 置 DELISTED + version bump + 审计 PRODUCT_DELISTED", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await delistProduct("product-1", "admin-1");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "APPROVED" },
      data: { status: "DELISTED", version: { increment: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Product", targetId: "product-1", action: "PRODUCT_DELISTED", operatorId: "admin-1" },
    });
  });

  it("守卫 0 行但商品存在（非 APPROVED）→ 抛 409 PRODUCT_STATUS_INVALID", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue({ id: "product-1" });

    await expect(delistProduct("product-1", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_STATUS_INVALID.code,
      statusCode: 409,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("守卫 0 行且商品不存在 → 抛 404 PRODUCT_NOT_FOUND", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue(null);

    await expect(delistProduct("product-x", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_NOT_FOUND.code,
    });
  });
});

describe("relistProduct — 重新上架（DELISTED → APPROVED）", () => {
  it("DELISTED 商品 → 置 APPROVED + version bump + 审计 PRODUCT_RELISTED（不重质检）", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await relistProduct("product-1", "admin-1");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "DELISTED" },
      data: { status: "APPROVED", version: { increment: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Product", targetId: "product-1", action: "PRODUCT_RELISTED", operatorId: "admin-1" },
    });
  });

  it("守卫 0 行但商品存在（非 DELISTED）→ 抛 409", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue({ id: "product-1" });

    await expect(relistProduct("product-1", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_STATUS_INVALID.code,
    });
  });
});

describe("updateProduct — 管理端编辑商品（状态机：基本信息→重审 / 仅运营→直改 / 拒绝撤回→重提）", () => {
  const baseOld = {
    id: "product-1",
    name: "静音震动器",
    category: "智能设备",
    subCategory: "智能健康监测",
    description: "低噪 50dB",
    images: [],
    specs: {},
    status: "APPROVED",
  };

  it("APPROVED 改基本信息（name）→ 回 PENDING + 审计 PRODUCT_UPDATE_REVIEW + snapshot 留痕", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("product-1", { name: "静音震动器 Pro" }, "admin-1");

    expect(result).toEqual({ id: "product-1", status: "PENDING" });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "APPROVED" },
      data: {
        name: "静音震动器 Pro",
        status: "PENDING",
        version: { increment: 1 },
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "Product",
        targetId: "product-1",
        action: "PRODUCT_UPDATE_REVIEW",
        operatorId: "admin-1",
        snapshot: {
          before: {
            name: "静音震动器",
            category: "智能设备",
            subCategory: "智能健康监测",
            status: "APPROVED",
          },
          after: { status: "PENDING" },
        },
      },
    });
  });

  it("APPROVED 仅改运营信息（price）→ 状态不变 + 审计 PRODUCT_UPDATE（价格元→分写库）", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("product-1", { price: 99 }, "admin-1");

    expect(result).toEqual({ id: "product-1", status: "APPROVED" });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "APPROVED" },
      data: {
        price: 9900,
        version: { increment: 1 },
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PRODUCT_UPDATE" }),
    });
  });

  it("REJECTED 任意修改 → 回 PENDING 重新提交 + 审计 PRODUCT_UPDATE_RESUBMIT", async () => {
    tx.product.findUnique.mockResolvedValue({ ...baseOld, status: "REJECTED" });
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("product-1", { stock: 5 }, "admin-1");

    expect(result).toEqual({ id: "product-1", status: "PENDING" });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PRODUCT_UPDATE_RESUBMIT" }),
    });
  });

  it("WITHDRAWN 任意修改 → 回 PENDING 重新提交", async () => {
    tx.product.findUnique.mockResolvedValue({ ...baseOld, status: "WITHDRAWN" });
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("product-1", { description: "补充资质说明" }, "admin-1");

    expect(result).toEqual({ id: "product-1", status: "PENDING" });
  });

  it("description 传空字符串 → 归一化 null（防与旧 null 比较误判重审）", async () => {
    tx.product.findUnique.mockResolvedValue({ ...baseOld, description: null });
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await updateProduct("product-1", { description: "" }, "admin-1");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "APPROVED" },
      data: { description: null, version: { increment: 1 } },
    });
  });

  it("商品不存在 → 抛 404，不写审计", async () => {
    tx.product.findUnique.mockResolvedValue(null);

    await expect(updateProduct("product-x", { name: "x" }, "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_NOT_FOUND.code,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("读后状态并发变更（守卫 0 行）→ 抛 409 PRODUCT_STATUS_INVALID，不覆盖他人决策", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateProduct("product-1", { name: "并发改动" }, "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_STATUS_INVALID.code,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
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

// ── 批量生成邀请码 ──

describe("generateInviteCodes — 批量生成邀请码", () => {
  // 字符集为 32 字符（剔除 0/O/1/I），组间格式 INV-XXXX-XXXX
  const INV_CODE_RE = /^INV-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

  it("生成指定数量 INV-XXXX-XXXX 码（批内不重复），逐码落库 + 逐码审计", async () => {
    const codes = await generateInviteCodes({ count: 3, expiresAt: null }, "admin-1");

    expect(codes).toHaveLength(3);
    codes.forEach((c) => expect(c).toMatch(INV_CODE_RE));
    expect(new Set(codes).size).toBe(3);
    expect(tx.inviteCode.create).toHaveBeenCalledTimes(3);
    expect(tx.inviteCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdBy: "admin-1", expiresAt: null }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(3);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "InviteCode",
        targetId: expect.stringMatching(INV_CODE_RE),
        action: "INVITE_GENERATED",
        operatorId: "admin-1",
      },
    });
  });

  it("expiresAt 缺省 → 逐码落库 null（永不过期）", async () => {
    await generateInviteCodes({ count: 1 }, "admin-1");

    expect(tx.inviteCode.create).toHaveBeenCalledWith({
      data: { code: expect.stringMatching(INV_CODE_RE), createdBy: "admin-1", expiresAt: null },
    });
  });

  it("自定义过期时间 → 逐码写入该 expiresAt", async () => {
    const future = new Date("2099-01-01T00:00:00Z");
    await generateInviteCodes({ count: 2, expiresAt: future }, "admin-1");

    expect(tx.inviteCode.create).toHaveBeenCalledTimes(2);
    for (const call of tx.inviteCode.create.mock.calls) {
      expect(call[0].data.expiresAt).toBe(future);
    }
  });
});
