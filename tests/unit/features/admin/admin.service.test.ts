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
    brand: { updateMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    product: { updateMany: vi.fn(), findUnique: vi.fn() },
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    user: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    inviteCode: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    categoryAuditTemplate: { upsert: vi.fn(), deleteMany: vi.fn() },
    refreshToken: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// admin.service 从 @/features/orders 引入 ORDER_STATUS / restoreStock；
// 直接走 feature index 会经过 orders.routes → next/navigation（node 环境不可用），
// 故 mock 该模块仅提供常量与恢复库存函数，与实际实现保持一致
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
  restoreStock: vi.fn(),
}));

import { prisma } from "@/shared/db/client";
import { restoreStock } from "@/features/orders";
import { ERROR_CODES } from "@/shared/errors/errors";
import {
  reviewBrand,
  deleteBrand,
  reviewProduct,
  delistProduct,
  relistProduct,
  updateProduct,
  shipOrder,
  deliverOrder,
  completeOrder,
  confirmRefund,
  generateInviteCodes,
  revokeInviteCode,
  setUserRole,
  setUserStatus,
  unlockUser,
  resetPassword,
  clearAgeVerification,
  deleteAuditTemplate,
} from "@/features/admin/admin.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type Tx = {
  brand: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  product: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  order: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  user: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  inviteCode: { create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  categoryAuditTemplate: { upsert: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  refreshToken: { deleteMany: ReturnType<typeof vi.fn> };
};

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    brand: { updateMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    product: { updateMany: vi.fn(), findUnique: vi.fn() },
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    user: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    inviteCode: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    categoryAuditTemplate: { upsert: vi.fn(), deleteMany: vi.fn() },
    refreshToken: { deleteMany: vi.fn() },
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
      where: { id: "brand-1", status: { in: ["PENDING", "REJECTED"] } },
      data: { status: "APPROVED" },
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", role: { notIn: ["BRAND", "ADMIN"] } },
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

    expect(tx.user.updateMany).not.toHaveBeenCalled();
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
    expect(tx.user.updateMany).not.toHaveBeenCalled();
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
    tx.user.updateMany.mockRejectedValue(new Error("DB down"));

    await expect(reviewBrand("brand-1", "APPROVED", "admin-1")).rejects.toThrow("DB down");
  });

  it("负责人已是 ADMIN（更高角色）→ 角色守卫不降级，仍通过 + 审计日志", async () => {
    tx.brand.findUnique.mockResolvedValue({ ownerId: "user-admin" });
    tx.brand.updateMany.mockResolvedValue({ count: 1 });
    // 守卫命中 0 行：updateMany 带 notIn:["BRAND","ADMIN"]，ADMIN 不匹配 → 0 行 = no-op 而非抛错
    tx.user.updateMany.mockResolvedValue({ count: 0 });

    await reviewBrand("brand-1", "APPROVED", "admin-1");

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-admin", role: { notIn: ["BRAND", "ADMIN"] } },
      data: { role: "BRAND" },
    });
    // 0 行命中不阻断审核流程（幂等升级），审计正常落库
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Brand", targetId: "brand-1", action: "REVIEW_APPROVED", operatorId: "admin-1" },
    });
  });

  it("REJECTED 品牌重审通过（改判错杀）→ 置 APPROVED + 负责人升级 BRAND 角色 + 审计日志", async () => {
    tx.brand.findUnique.mockResolvedValue({ ownerId: "user-1" });
    tx.brand.updateMany.mockResolvedValue({ count: 1 });

    await reviewBrand("brand-3", "APPROVED", "admin-1");

    expect(tx.brand.updateMany).toHaveBeenCalledWith({
      where: { id: "brand-3", status: { in: ["PENDING", "REJECTED"] } },
      data: { status: "APPROVED" },
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", role: { notIn: ["BRAND", "ADMIN"] } },
      data: { role: "BRAND" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Brand", targetId: "brand-3", action: "REVIEW_APPROVED", operatorId: "admin-1" },
    });
  });

  it("REJECTED 品牌再次拒绝 → 409 BRAND_ALREADY_REVIEWED（守卫只放行 PENDING 拒绝）", async () => {
    tx.brand.findUnique.mockResolvedValue({ ownerId: "user-1" });
    // 模拟守卫：REJECTED 走 REJECTED 决策的 where={status:"PENDING"} → 0 行
    tx.brand.updateMany.mockResolvedValue({ count: 0 });

    await expect(reviewBrand("brand-3", "REJECTED", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_ALREADY_REVIEWED.code,
      statusCode: 409,
    });
    expect(tx.brand.updateMany).toHaveBeenCalledWith({
      where: { id: "brand-3", status: "PENDING" },
      data: { status: "REJECTED" },
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── 删除审核拒绝的品牌 ──

describe("deleteBrand — 删除 REJECTED 品牌（删除后商家可重新入驻）", () => {
  it("REJECTED 品牌 → 删除 + 审计日志（同事务）", async () => {
    tx.brand.findUnique.mockResolvedValue({ status: "REJECTED" });
    tx.brand.delete.mockResolvedValue({});

    await deleteBrand("brand-3", "admin-1");

    expect(tx.brand.findUnique).toHaveBeenCalledWith({
      where: { id: "brand-3" },
      select: { status: true },
    });
    expect(tx.brand.delete).toHaveBeenCalledWith({ where: { id: "brand-3" } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Brand", targetId: "brand-3", action: "DELETE_BRAND", operatorId: "admin-1" },
    });
  });

  it("非 REJECTED（PENDING 在审）→ 409 BRAND_NOT_DELETABLE，不删除不写审计", async () => {
    tx.brand.findUnique.mockResolvedValue({ status: "PENDING" });

    await expect(deleteBrand("brand-1", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_NOT_DELETABLE.code,
      statusCode: 409,
    });
    expect(tx.brand.delete).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("品牌不存在 → 404 BRAND_NOT_FOUND", async () => {
    tx.brand.findUnique.mockResolvedValue(null);

    await expect(deleteBrand("brand-x", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_NOT_FOUND.code,
      statusCode: 404,
    });
    expect(tx.brand.delete).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("删除失败（DB 异常）→ 整体抛错回滚", async () => {
    tx.brand.findUnique.mockResolvedValue({ status: "REJECTED" });
    tx.brand.delete.mockRejectedValue(new Error("DB down"));

    await expect(deleteBrand("brand-3", "admin-1")).rejects.toThrow("DB down");
    expect(tx.auditLog.create).not.toHaveBeenCalled();
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
    certificates: [],
    specs: {},
    status: "APPROVED",
    version: 1,
  };

  it("APPROVED 改基本信息（name）→ 回 PENDING + 审计 PRODUCT_UPDATE_REVIEW + snapshot 留痕", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("product-1", { name: "静音震动器 Pro" }, "admin-1");

    expect(result).toEqual({ id: "product-1", status: "PENDING" });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "APPROVED", version: 1 },
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

  it("APPROVED 仅改检测证书 → 回 PENDING 重审（证书属基本信息）", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct(
      "product-1",
      {
        certificates: [
          { url: "https://img.example.com/cert/new.pdf", name: "新质检报告.pdf", mime: "application/pdf" },
        ],
      },
      "admin-1",
    );

    expect(result).toEqual({ id: "product-1", status: "PENDING" });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "APPROVED", version: 1 },
      data: expect.objectContaining({
        certificates: [
          { url: "https://img.example.com/cert/new.pdf", name: "新质检报告.pdf", mime: "application/pdf" },
        ],
        status: "PENDING",
        version: { increment: 1 },
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PRODUCT_UPDATE_REVIEW" }),
    });
  });

  it("APPROVED 仅改运营信息（price）→ 状态不变 + 审计 PRODUCT_UPDATE（价格元→分写库）", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("product-1", { price: 99 }, "admin-1");

    expect(result).toEqual({ id: "product-1", status: "APPROVED" });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "APPROVED", version: 1 },
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
      where: { id: "product-1", status: "APPROVED", version: 1 },
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

  it("L13：version 已被他处编辑（乐观锁 0 行）→ 409，绝不静默覆盖他人编辑", async () => {
    // 场景：管理员 A 与 B 同时打开同一商品编辑页，A 先保存（version 1→2），
    // B 保存时 where 带旧 version:1 → 命中 0 行 → 拒绝，防 last-write-wins 丢 A 的改动
    tx.product.findUnique.mockResolvedValue(baseOld); // 读到 version:1
    tx.product.updateMany.mockResolvedValue({ count: 0 }); // 实际 DB 已 version:2

    await expect(updateProduct("product-1", { price: 50 }, "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_STATUS_INVALID.code,
    });
    // 守卫必须携带 version（L13 核心断言）：status 未变但 version 变也拒绝
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", status: "APPROVED", version: 1 },
      data: expect.objectContaining({ price: 5000, version: { increment: 1 } }),
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
  it("退款中订单 → 置 REFUNDED + 回补库存/回减销量 + refundedAt + 审计日志", async () => {
    tx.order.findUnique.mockResolvedValue({
      items: [
        { productId: "p1", qty: 2 },
        { productId: "p2", qty: 1 },
      ],
    });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await confirmRefund("order-1", "admin-1");

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "REFUND_REQUESTED" },
      data: { status: "REFUNDED", refundedAt: expect.any(Date) },
    });
    // 退款成立 → 同事务回补库存（复用订单模块 restoreStock，防库存永久偏低）
    expect(restoreStock).toHaveBeenCalledWith(tx, [
      { productId: "p1", qty: 2 },
      { productId: "p2", qty: 1 },
    ]);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Order", targetId: "order-1", action: "REFUND_CONFIRMED", operatorId: "admin-1" },
    });
  });

  it("订单不存在 → 404 ORDER_NOT_FOUND，不触发状态更新", async () => {
    tx.order.findUnique.mockResolvedValue(null);

    await expect(confirmRefund("order-x", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.ORDER_NOT_FOUND.code,
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(restoreStock).not.toHaveBeenCalled();
  });

  it("非退款中订单（守卫 0 行）→ 抛 ORDER_STATUS_INVALID，不回补库存不写审计", async () => {
    tx.order.findUnique.mockResolvedValue({ items: [{ productId: "p1", qty: 1 }] });
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(confirmRefund("order-x", "admin-1")).rejects.toMatchObject({
      code: ERROR_CODES.ORDER_STATUS_INVALID.code,
    });
    expect(restoreStock).not.toHaveBeenCalled();
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

// ── 作废邀请码（L6） ──

describe("revokeInviteCode — 作废邀请码（置 DISABLED，仅 UNUSED 可作废）", () => {
  it("UNUSED 码作废 → 置 DISABLED + 审计 INVITE_REVOKED（同事务）", async () => {
    tx.inviteCode.updateMany.mockResolvedValue({ count: 1 });

    await revokeInviteCode("admin-1", "inv-code-001");

    expect(tx.inviteCode.updateMany).toHaveBeenCalledWith({
      where: { code: "INV-CODE-001", status: "UNUSED" },
      data: { status: "DISABLED" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetType: "InviteCode",
          targetId: "INV-CODE-001",
          action: "INVITE_REVOKED",
          operatorId: "admin-1",
        }),
      }),
    );
  });

  it("小写 code → 归一化为大写后再作废（与激活侧同规约）", async () => {
    tx.inviteCode.updateMany.mockResolvedValue({ count: 1 });

    await revokeInviteCode("admin-1", "inv-abc-1234");

    expect(tx.inviteCode.updateMany).toHaveBeenCalledWith({
      where: { code: "INV-ABC-1234", status: "UNUSED" },
      data: { status: "DISABLED" },
    });
  });

  it("已使用(USED)码 → 409 INVITE_CODE_USED，不写审计", async () => {
    tx.inviteCode.updateMany.mockResolvedValue({ count: 0 });
    tx.inviteCode.findUnique.mockResolvedValue({ status: "USED" });

    await expect(revokeInviteCode("admin-1", "INV-USED")).rejects.toMatchObject({
      code: ERROR_CODES.INVITE_CODE_USED.code,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("已作废(DISABLED)码 → 409 INVITE_CODE_DISABLED（并发双击只生效一次）", async () => {
    tx.inviteCode.updateMany.mockResolvedValue({ count: 0 });
    tx.inviteCode.findUnique.mockResolvedValue({ status: "DISABLED" });

    await expect(revokeInviteCode("admin-1", "INV-DONE")).rejects.toMatchObject({
      code: ERROR_CODES.INVITE_CODE_DISABLED.code,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("不存在的码 → 404 INVITE_CODE_NOT_FOUND", async () => {
    tx.inviteCode.updateMany.mockResolvedValue({ count: 0 });
    tx.inviteCode.findUnique.mockResolvedValue(null);

    await expect(revokeInviteCode("admin-1", "INV-NOPE")).rejects.toMatchObject({
      code: ERROR_CODES.INVITE_CODE_NOT_FOUND.code,
    });
  });
});

// ── 用户管理操作 ──

describe("setUserRole — 改角色", () => {
  it("USER → BRAND 成功 + 审计（同事务）", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil: null, ageVerified: false });
    tx.user.updateMany.mockResolvedValue({ count: 1 });

    await setUserRole("user-1", "BRAND", "admin-1");

    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { role: true, status: true, lockUntil: true, ageVerified: true },
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", role: "USER" },
      data: { role: "BRAND" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "User",
        targetId: "user-1",
        action: "SET_ROLE",
        operatorId: "admin-1",
        snapshot: { before: "USER", after: "BRAND" },
      },
    });
  });

  it("操作自己 → 403 CANNOT_OPERATE_SELF（不自伤）", async () => {
    await expect(setUserRole("admin-1", "ADMIN", "admin-1")).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.CANNOT_OPERATE_SELF.code, statusCode: 403 }),
    );
    expect(tx.user.findUnique).not.toHaveBeenCalled();
  });

  it("目标用户不存在 → 404 USER_NOT_FOUND", async () => {
    tx.user.findUnique.mockResolvedValue(null);
    await expect(setUserRole("nobody", "BRAND", "admin-1")).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.USER_NOT_FOUND.code, statusCode: 404 }),
    );
  });

  it("角色未变 → 幂等跳过，不落审计", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "ADMIN", status: "ACTIVE", lockUntil: null, ageVerified: false });

    await setUserRole("user-1", "ADMIN", "admin-1");

    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("setUserStatus — 禁用/启用", () => {
  it("禁用成功 + 审计 USER_DISABLED + 吊销该用户全部 refresh token", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil: null, ageVerified: false });
    tx.user.updateMany.mockResolvedValue({ count: 1 });

    await setUserStatus("user-1", "DISABLED", "admin-1");

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", status: "ACTIVE" },
      data: { status: "DISABLED" },
    });
    // 禁用立即吊销全部会话（防 refresh 续期维持权限）
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "User",
        targetId: "user-1",
        action: "USER_DISABLED",
        operatorId: "admin-1",
        snapshot: { before: "ACTIVE", after: "DISABLED" },
      },
    });
  });

  it("启用（ACTIVE）不吊销会话", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "DISABLED", lockUntil: null, ageVerified: false });
    tx.user.updateMany.mockResolvedValue({ count: 1 });

    await setUserStatus("user-1", "ACTIVE", "admin-1");

    expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it("禁用自己 → 403", async () => {
    await expect(setUserStatus("admin-1", "DISABLED", "admin-1")).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.CANNOT_OPERATE_SELF.code, statusCode: 403 }),
    );
  });

  it("并发状态已被他改 → 命中 0 行 → 409 语义抛错（不覆盖他人决策）", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil: null, ageVerified: false });
    tx.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(setUserStatus("user-1", "DISABLED", "admin-1")).rejects.toThrow(
      expect.objectContaining({ statusCode: 500 }),
    );
  });
});

describe("unlockUser — 解锁", () => {
  it("锁定中 → 清 lockUntil + failedLoginAttempts + 审计", async () => {
    const lockUntil = new Date(Date.now() + 600000);
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil, ageVerified: false });
    tx.user.updateMany.mockResolvedValue({ count: 1 });

    await unlockUser("user-1", "admin-1");

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", lockUntil },
      data: { lockUntil: null, failedLoginAttempts: 0 },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "User", targetId: "user-1", action: "USER_UNLOCKED", operatorId: "admin-1" },
    });
  });

  it("未锁定 → 409 USER_NOT_LOCKED", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil: null, ageVerified: false });

    await expect(unlockUser("user-1", "admin-1")).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.USER_NOT_LOCKED.code, statusCode: 409 }),
    );
  });

  it("锁定已过期（lockUntil < now）→ 视为未锁定 409", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil: new Date(Date.now() - 1000), ageVerified: false });

    await expect(unlockUser("user-1", "admin-1")).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.USER_NOT_LOCKED.code, statusCode: 409 }),
    );
  });
});

describe("resetPassword — 重置密码", () => {
  it("成功 → 覆盖 scrypt 哈希 + 解锁 + 吊销全部会话 + 返回临时密码 + 审计", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil: null, ageVerified: false });
    tx.user.updateMany.mockResolvedValue({ count: 1 });

    const result = await resetPassword("user-1", "Temp@123456", "admin-1");

    expect(result.tempPassword).toBe("Temp@123456");
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        passwordHash: expect.stringMatching(/^scrypt\.[0-9a-f]{32}\./),
        failedLoginAttempts: 0,
        lockUntil: null,
      },
    });
    // 重置密码同时吊销全部会话：攻击者旧 refresh token 无法再轮换
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "User", targetId: "user-1", action: "PASSWORD_RESET", operatorId: "admin-1" },
    });
  });

  it("临时密码 <6 位 → 422 VALIDATION_ERROR，不触碰 DB", async () => {
    await expect(resetPassword("user-1", "12345", "admin-1")).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.VALIDATION_ERROR.code, statusCode: 422 }),
    );
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("目标用户不存在 → 404，不产生「对不存在用户成功」", async () => {
    tx.user.findUnique.mockResolvedValue(null);
    await expect(resetPassword("nobody", "Temp@123456", "admin-1")).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.USER_NOT_FOUND.code, statusCode: 404 }),
    );
  });
});

describe("clearAgeVerification — 清除年龄验证", () => {
  it("已验证 → 置 false + 审计", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil: null, ageVerified: true });
    tx.user.updateMany.mockResolvedValue({ count: 1 });

    await clearAgeVerification("user-1", "admin-1");

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", ageVerified: true },
      data: { ageVerified: false },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "User",
        targetId: "user-1",
        action: "CLEAR_AGE_VERIFICATION",
        operatorId: "admin-1",
        snapshot: { before: true, after: false },
      },
    });
  });

  it("未验证 → 幂等跳过，不落审计", async () => {
    tx.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE", lockUntil: null, ageVerified: false });

    await clearAgeVerification("user-1", "admin-1");

    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ── 质检模板删除 ──

describe("deleteAuditTemplate — 删除质检模板", () => {
  it("存在 → 删除 + 审计（同事务）", async () => {
    tx.categoryAuditTemplate.deleteMany.mockResolvedValue({ count: 1 });

    await deleteAuditTemplate("成人计生用品", "admin-1");

    expect(tx.categoryAuditTemplate.deleteMany).toHaveBeenCalledWith({
      where: { categoryId: "成人计生用品" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "CategoryAuditTemplate",
        targetId: "成人计生用品",
        action: "DELETE_TEMPLATE",
        operatorId: "admin-1",
      },
    });
  });

  it("不存在 → 404 TEMPLATE_NOT_FOUND", async () => {
    tx.categoryAuditTemplate.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteAuditTemplate("不存在类目", "admin-1")).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.TEMPLATE_NOT_FOUND.code, statusCode: 404 }),
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
