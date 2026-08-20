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

// 阻断订单 service 对真实 payment 模块的调用（支付宝网关不可测）；createPayment/isPaymentConfigured 由用例 mock
vi.mock("@/features/payment", () => ({
  paymentService: {
    createPayment: vi.fn(),
    queryAlipayTrade: vi.fn(),
    isPaymentConfigured: vi.fn(),
  },
}));
vi.mock("@/shared/adapters/payment.adapter", () => ({
  paymentAdapter: { createPayment: vi.fn(), verifyCallback: vi.fn(), queryPayment: vi.fn() },
}));

import { prisma } from "@/shared/db/client";
import { paymentService } from "@/features/payment";
import { createOrder } from "@/features/orders/orders.service";
import { ERROR_CODES } from "@/shared/errors/errors";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type TxCartItem = {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
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

/** 按 productId 返回购物车行（F4 差额扣减 findUnique 用） */
function mockCartRows(rows: { productId: string; qty: number }[]) {
  const map = new Map(rows.map((r) => [r.productId, r]));
  tx.cartItem.findUnique.mockImplementation(
    ({ where }: { where: { userId_productId: { userId: string; productId: string } } }) => {
      const row = map.get(where.userId_productId.productId);
      return Promise.resolve(row ? { id: `cart-${row.productId}`, qty: row.qty } : null);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    cartItem: { findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    product: { findUnique: vi.fn(), updateMany: vi.fn() },
    order: { create: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
  // E1 默认：支付宝未配置（paymentState=unavailable），支付测试用例自行开启
  vi.mocked(paymentService.isPaymentConfigured).mockReturnValue(false);
});

describe("createOrder — 购物车子集校验（防回退全量误删）", () => {
  it("提交项含购物车中不存在的商品 → VALIDATION_ERROR，且不扣库存/不建单", async () => {
    // 购物车里只有 p1，用户提交 p1 + p2（p2 不在购物车）
    tx.cartItem.findMany.mockResolvedValue([{ productId: "p1", qty: 999 }]);

    await expect(
      createOrder("u1", { ...baseInput, items: [{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }] }),
    ).rejects.toThrow("p2");

    // 校验失败后事务内不得继续执行扣库存 / 创建订单 / 删购物车
    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
  });

  it("下单数量超过购物车数量 → VALIDATION_ERROR，不扣库存/不建单（防改参超量下单）", async () => {
    // 购物车只有 p1×2，提交 p1×3 → 拒绝
    tx.cartItem.findMany.mockResolvedValue([{ productId: "p1", qty: 2 }]);

    await expect(
      createOrder("u1", { ...baseInput, items: [{ productId: "p1", qty: 3 }] }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR.code,
    });

    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("提交项全在购物车 → 正常下单，Step 4 按购买数量扣减购物车", async () => {
    tx.cartItem.findMany.mockResolvedValue([{ productId: "p1", qty: 999 }, { productId: "p2", qty: 999 }]);
    // 购物车 p1×1、p2×1，下单各 1 → 购满 → 整行删除
    mockCartRows([{ productId: "p1", qty: 1 }, { productId: "p2", qty: 1 }]);
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
    // F4 差额扣减：购满 1=1 → 删除整行（delete），而非 deleteMany 全量
    expect(tx.cartItem.delete).toHaveBeenCalledWith({ where: { id: "cart-p1" } });
    expect(tx.cartItem.delete).toHaveBeenCalledWith({ where: { id: "cart-p2" } });
    expect(tx.cartItem.update).not.toHaveBeenCalled();
  });

  it("F4 差额扣减：购物车 A×5 只买 A×2 → 保留剩余 3（update 而非整行删除）", async () => {
    tx.cartItem.findMany.mockResolvedValue([{ productId: "p1", qty: 999 }]);
    mockCartRows([{ productId: "p1", qty: 5 }]);
    tx.product.findUnique.mockResolvedValue({
      id: "p1", name: "商品1", price: 19900, stock: 100, version: 1, status: "APPROVED",
    });
    tx.product.updateMany.mockResolvedValue({ count: 1 });
    tx.order.create.mockResolvedValue({ id: "order1", total: 39800, status: "PENDING", items: [] });

    await createOrder("u1", { ...baseInput, items: [{ productId: "p1", qty: 2 }] });

    // 5-2=3 留在购物车（update qty），不删除
    expect(tx.cartItem.update).toHaveBeenCalledWith({
      where: { id: "cart-p1" },
      data: { qty: 3 },
    });
    expect(tx.cartItem.delete).not.toHaveBeenCalled();
  });

  it("F5 privacy 白名单：input 注入额外字段（destroyed）→ 落库仅 anonymousPackaging/hideProductName", async () => {
    tx.cartItem.findMany.mockResolvedValue([{ productId: "p1", qty: 999 }]);
    mockCartRows([{ productId: "p1", qty: 5 }]);
    tx.product.findUnique.mockResolvedValue({
      id: "p1", name: "商品1", price: 19900, stock: 100, version: 1, status: "APPROVED",
    });
    tx.product.updateMany.mockResolvedValue({ count: 1 });
    tx.order.create.mockResolvedValue({ id: "order1", total: 19900, status: "PENDING", items: [] });

    await createOrder("u1", {
      ...baseInput,
      privacy: {
        anonymousPackaging: true,
        hideProductName: false,
        destroyed: true, // 恶意注入字段，不得落库
        destroyedAt: "2026-01-01T00:00:00.000Z",
      } as unknown as { anonymousPackaging: boolean; hideProductName: boolean },
    });

    const createCall = tx.order.create.mock.calls[0][0] as { data: { privacy: object } };
    expect(createCall.data.privacy).toEqual({ anonymousPackaging: true, hideProductName: false });
  });

  it("空 items → VALIDATION_ERROR（原有守卫回归）", async () => {
    await expect(
      createOrder("u1", { ...baseInput, items: [] }),
    ).rejects.toThrow("订单至少包含一个商品");
    expect(tx.cartItem.findMany).not.toHaveBeenCalled();
  });
});

// ── M2 去重 / M3 qty 上限 / E1 支付失败可见 ──

describe("createOrder — M2 去重 / M3 qty 上限 / E1 支付状态", () => {
  /** 事务内 happy path：购物车含 p1、商品可扣、建单成功 */
  function mockHappyPath(total = 19900) {
    tx.cartItem.findMany.mockResolvedValue([{ productId: "p1", qty: 999 }]);
    tx.product.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        id: where.id, name: "商品1", price: 19900, stock: 100, version: 1, status: "APPROVED",
      }),
    );
    tx.product.updateMany.mockResolvedValue({ count: 1 });
    tx.order.create.mockResolvedValue({
      id: "order1", total, status: "PENDING", items: [],
    });
  }

  it("M2：同一 productId 重复行合并 → 单次扣减合并后 qty、建单仅一行", async () => {
    mockHappyPath(99500);

    const r = await createOrder("u1", {
      ...baseInput,
      items: [{ productId: "p1", qty: 2 }, { productId: "p1", qty: 3 }],
    });

    // 合并后按 qty=5 单次扣减（修复前逐行扣 2+3 可「逐行均足、合计超卖」）
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", stock: { gte: 5 }, version: 1 },
      data: { stock: { decrement: 5 }, version: { increment: 1 }, sales: { increment: 5 } },
    });
    // 建单只有一行同商品 OrderItem（修复前生成两条，对账混乱）
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: { create: [expect.objectContaining({ productId: "p1", qty: 5 })] },
        }),
      }),
    );
    expect(r.total).toBe(99500);
  });

  it("M3：单行 qty 超上限(1000) → VALIDATION_ERROR，事务内不执行任何操作", async () => {
    await expect(
      createOrder("u1", { ...baseInput, items: [{ productId: "p1", qty: 1000 }] }),
    ).rejects.toThrow(/p1/);
    expect(tx.cartItem.findMany).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("M3：重复行合并后 qty 超上限 → VALIDATION_ERROR（防重复行绕过单行上限）", async () => {
    await expect(
      createOrder("u1", {
        ...baseInput,
        items: [{ productId: "p1", qty: 500 }, { productId: "p1", qty: 500 }],
      }),
    ).rejects.toThrow(/p1/);
    expect(tx.cartItem.findMany).not.toHaveBeenCalled();
  });

  it("E1：已配置且支付单创建成功 → paymentState=ok + qrCode", async () => {
    mockHappyPath();
    vi.mocked(paymentService.isPaymentConfigured).mockReturnValue(true);
    vi.mocked(paymentService.createPayment).mockResolvedValue({ qrCode: "alipay_qr_1" });

    const r = await createOrder("u1", baseInput);

    expect(r.paymentState).toBe("ok");
    expect(r.qrCode).toBe("alipay_qr_1");
    expect(r.orderId).toBe("order1");
  });

  it("E1：已配置但支付单创建失败 → paymentState=failed，订单仍创建（不阻塞下单）", async () => {
    mockHappyPath();
    vi.mocked(paymentService.isPaymentConfigured).mockReturnValue(true);
    vi.mocked(paymentService.createPayment).mockRejectedValue(new Error("alipay down"));

    const r = await createOrder("u1", baseInput);

    expect(r.paymentState).toBe("failed");
    expect(r.qrCode).toBeNull();
    expect(r.orderId).toBe("order1");
  });

  it("E1：未配置 → paymentState=unavailable 且不调 createPayment（dev 降级）", async () => {
    mockHappyPath();

    const r = await createOrder("u1", baseInput);

    expect(r.paymentState).toBe("unavailable");
    expect(r.qrCode).toBeNull();
    expect(paymentService.createPayment).not.toHaveBeenCalled();
  });
});
