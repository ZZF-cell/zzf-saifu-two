// cart.service 单元测试 — M6 原子 upsert（消除并发双击加购的 P2002 竞态）
// mock 系统边界：prisma（product.findUnique + cartItem.upsert）
// 只测公共 seam：cart.service.addToCart
//
// 回归点：修复前 addToCart 是 findUnique→create/update 两步（check-then-act），
// 并发双击「加入购物车」时两请求都读到 existing=null → 双双走 create →
// 违反 @@unique([userId, productId]) 抛 P2002 → 500 而非优雅合并。
// 本测试锁定：任何情况下只发一条 upsert 语句，绝不出现 findUnique/create/update 组合。

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    cartItem: { upsert: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { addToCart } from "@/features/cart/cart.service";

// prisma 类型是完整 Product，mock 只覆盖 service 用到的字段
const productFindUnique = vi.mocked(prisma.product.findUnique) as unknown as {
  mockResolvedValue: (value: {
    id: string;
    name: string;
    price: number;
    stock: number;
    status: string;
  } | null) => unknown;
};
const cartItemUpsert = vi.mocked(prisma.cartItem.upsert);
const cartItemFindUnique = vi.mocked(prisma.cartItem.findUnique);
const cartItemCreate = vi.mocked(prisma.cartItem.create);
const cartItemUpdate = vi.mocked(prisma.cartItem.update);

function mockProduct(overrides: Partial<{ stock: number; status: string }> = {}) {
  productFindUnique.mockResolvedValue({
    id: "p1",
    name: "商品1",
    price: 19900,
    stock: 10,
    status: "APPROVED",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addToCart — M6 原子 upsert", () => {
  it("原子性：任何路径只调一次 upsert，绝不出现 findUnique→create/update 两步", async () => {
    mockProduct();
    cartItemUpsert.mockResolvedValue({ id: "c1" } as never);

    await addToCart("u1", "p1", 2);

    expect(cartItemUpsert).toHaveBeenCalledTimes(1);
    // 竞态修复的核心断言：旧的 check-then-act 三件套一个都不能出现
    expect(cartItemFindUnique).not.toHaveBeenCalled();
    expect(cartItemCreate).not.toHaveBeenCalled();
    expect(cartItemUpdate).not.toHaveBeenCalled();
  });

  it("新行 → upsert create 分支，qty 按库存钳制", async () => {
    mockProduct();
    cartItemUpsert.mockResolvedValue({ id: "c1" } as never);

    await addToCart("u1", "p1", 2);

    expect(cartItemUpsert).toHaveBeenCalledWith({
      where: { userId_productId: { userId: "u1", productId: "p1" } },
      create: {
        userId: "u1",
        productId: "p1",
        productName: "商品1",
        price: 19900,
        qty: 2,
      },
      update: {
        qty: { increment: 2 },
        price: 19900,
        productName: "商品1",
      },
    });
  });

  it("新行但请求数量超库存 → create 分支钳制到 stock", async () => {
    mockProduct({ stock: 3 });
    cartItemUpsert.mockResolvedValue({ id: "c1" } as never);

    await addToCart("u1", "p1", 5);

    expect(cartItemUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ qty: 3 }),
      }),
    );
  });

  it("已有行 → upsert update 分支原子累加 qty（增量非覆盖，防丢失并发加购）", async () => {
    mockProduct();
    cartItemUpsert.mockResolvedValue({ id: "c1" } as never);

    await addToCart("u1", "p1", 1);

    // update.qty.increment 是原子累加：两次并发加购 1+1=2，而非各覆盖为 1
    expect(cartItemUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ qty: { increment: 1 } }),
      }),
    );
  });

  it("商品不存在或未上架 → PRODUCT_NOT_FOUND，不调 upsert", async () => {
    productFindUnique.mockResolvedValue(null);

    await expect(addToCart("u1", "p1", 1)).rejects.toMatchObject({
      code: "PRODUCT_NOT_FOUND",
    });
    expect(cartItemUpsert).not.toHaveBeenCalled();
  });

  it("商品下架（非 APPROVED）→ PRODUCT_NOT_FOUND", async () => {
    mockProduct({ status: "PENDING" });

    await expect(addToCart("u1", "p1", 1)).rejects.toMatchObject({
      code: "PRODUCT_NOT_FOUND",
    });
    expect(cartItemUpsert).not.toHaveBeenCalled();
  });

  it("库存为 0 → STOCK_CONFLICT，不调 upsert", async () => {
    mockProduct({ stock: 0 });

    await expect(addToCart("u1", "p1", 1)).rejects.toMatchObject({
      code: "STOCK_CONFLICT",
    });
    expect(cartItemUpsert).not.toHaveBeenCalled();
  });
});
