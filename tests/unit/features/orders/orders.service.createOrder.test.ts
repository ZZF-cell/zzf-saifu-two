// createOrder 购物车子集校验 单元测试 — 防「无 ?items= 回退全量」误删整张购物车
// mock 系统边界：prisma.$transaction（交互事务内 cartItem/product/order）+ paymentService.createPayment
// 只测公共 seam：orders.service.createOrder
//
// 回归点：修复前 createOrder 完全信任请求 body 的 items，服务端不校验 items 与购物车的一致性。
// 结算页「无 ?items= 时回退全量」会把整张购物车 POST 下单 → Step 4 deleteMany 删光全部行
// （用户以为只下单一个，剩余商品却全部消失）。本测试锁定：
//   ① items 含购物车中不存在的商品 → 拒绝下单（VALIDATION_ERROR），事务内不扣库存/不建单
//   ② items 全在购物车 → 正常下单，Step 4 只删本次提交的商品

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: { $transaction: vi.fn() },
}));

// 阻断订单 service 对真实 payment 模块的调用（支付宝网关不可测）；createPayment 由用例 mock
vi.mock("@/features/payment", () => ({
  paymentService: { createPayment: vi.fn(), queryAlipayTrade: vi.fn() },
}));
vi.mock("@/shared/adapters/payment.adapter", () => ({
  paymentAdapter: { createPayment: vi.fn(), verifyCallback: vi.fn(), queryPayment: vi.fn() },
}));

import { prisma } from "@/shared/db/client";
import { paymentService } from "@/features/payment";
import { createOrder } from "@/features/orders/orders.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type TxCartItem = {
  findMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};
type TxProduct = {
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
type TxOrder = { create: ReturnType<typeof vi.fn> };
type Tx = { cartItem: TxCartItem; product: TxProduct; order: TxOrder };

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

const baseInput = {
  items: [{ productId: "p1", qty: 1 }],
  shippingAddress: {
    name: "测试", phone: "13800138000", province: "广东省",
    city: "深圳市", district: "南山区", detail: "科技园路 1 号", zipCode: "",
  },
  privacy: { anonymousPackaging: true, hideProductName: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    cartItem: { findMany: vi.fn(), deleteMany: vi.fn() },
    product: { findUnique: vi.fn(), updateMany: vi.fn() },
    order: { create: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

describe("createOrder — 购物车子集校验（防回退全量误删）", () => {
  it("提交项含购物车中不存在的商品 → VALIDATION_ERROR，且不扣库存/不建单", async () => {
    // 购物车里只有 p1，用户提交 p1 + p2（p2 不在购物车）
    tx.cartItem.findMany.mockResolvedValue([{ productId: "p1" }]);

    await expect(
      createOrder("u1", { ...baseInput, items: [{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }] }),
    ).rejects.toThrow("p2");

    // 校验失败后事务内不得继续执行扣库存 / 创建订单 / 删购物车
    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
  });

  it("提交项全在购物车 → 正常下单，Step 4 只删本次提交的商品", async () => {
    tx.cartItem.findMany.mockResolvedValue([{ productId: "p1" }, { productId: "p2" }]);
    tx.product.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        id: where.id, name: `商品${where.id}`, price: 19900, stock: 100, version: 1, status: "APPROVED",
      }),
    );
    tx.product.updateMany.mockResolvedValue({ count: 1 });
    tx.order.create.mockResolvedValue({
      id: "order1", total: 19900, status: "PENDING",
      items: [{ productId: "p1", productName: "商品1", price: 19900, qty: 1 }],
    });
    (vi.mocked(paymentService.createPayment)).mockResolvedValue({ qrCode: "alipay_qr_1" });

    const r = await createOrder("u1", {
      ...baseInput,
      items: [{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }],
    });

    expect(r.orderId).toBe("order1");
    // Step 0 校验通过后才走到扣库存
    expect(tx.product.updateMany).toHaveBeenCalled();
    // Step 4 删除范围 = 本次提交的购物车商品（不含未提交的）
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", productId: { in: ["p1", "p2"] } },
    });
  });

  it("空 items → VALIDATION_ERROR（原有守卫回归）", async () => {
    await expect(
      createOrder("u1", { ...baseInput, items: [] }),
    ).rejects.toThrow("订单至少包含一个商品");
    expect(tx.cartItem.findMany).not.toHaveBeenCalled();
  });
});
