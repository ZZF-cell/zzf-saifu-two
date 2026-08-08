// 购物车服务 — 服务端同步
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { multiplyFen, sumFen } from "@/shared/utils/money";
import { toJsonStringArray } from "@/shared/utils/format";

export interface CartItemRow {
  id: string;
  productId: string;
  productName: string;
  price: number;       // 分
  qty: number;
  image: string | null;
  stock: number;
  subtotal: number;    // 分 = price × qty
}

export interface CartData {
  items: CartItemRow[];
  totalCount: number;
  totalAmount: number; // 分
}

// ── 获取购物车 ──

export async function getCart(userId: string): Promise<CartData> {
  const items = await prisma.cartItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  // 并行获取商品最新信息（库存和图片）
  const productIds = items.map((i) => i.productId);
  const products =
    productIds.length > 0
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, stock: true, images: true, status: true },
        })
      : [];

  const productMap = new Map(products.map((p) => [p.id, p]));

  const cartItems: CartItemRow[] = items.map((item) => {
    const product = productMap.get(item.productId);
    const availableStock = product?.status === "APPROVED" ? product.stock : 0;
    const effectiveQty = Math.min(item.qty, availableStock || 0);
    const images = toJsonStringArray(product?.images);
    return {
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      price: item.price,
      qty: effectiveQty,
      image: images[0] || null,
      stock: availableStock,
      subtotal: multiplyFen(item.price, effectiveQty),
    };
  });

  // 过滤掉库存为零的商品（返回前端前移除，不自动删 DB 记录）
  const visibleItems = cartItems.filter((i) => i.qty > 0);

  return {
    items: visibleItems,
    totalCount: visibleItems.reduce((sum, i) => sum + i.qty, 0),
    totalAmount: sumFen(visibleItems.map((i) => i.subtotal)),
  };
}

// ── 添加商品到购物车 ──

export async function addToCart(
  userId: string,
  productId: string,
  qty: number,
): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, price: true, stock: true, status: true },
  });

  if (!product || product.status !== "APPROVED") {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, "商品不存在或已下架");
  }
  if (product.stock < 1) {
    throw new AppError(ERROR_CODES.STOCK_CONFLICT, "商品库存不足");
  }

  const existing = await prisma.cartItem.findUnique({
    where: { userId_productId: { userId, productId } },
  });

  if (existing) {
    const newQty = existing.qty + qty;
    await prisma.cartItem.update({
      where: { id: existing.id },
      data: {
        qty: Math.min(newQty, product.stock),
        // 价格快照更新到最新
        price: product.price,
        productName: product.name,
      },
    });
  } else {
    await prisma.cartItem.create({
      data: {
        userId,
        productId,
        productName: product.name,
        price: product.price,
        qty: Math.min(qty, product.stock),
      },
    });
  }
}

// ── 修改数量 ──

export async function updateCartQty(
  userId: string,
  productId: string,
  qty: number,
): Promise<void> {
  if (qty < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "数量至少为 1");
  }

  const item = await prisma.cartItem.findUnique({
    where: { userId_productId: { userId, productId } },
  });
  if (!item) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, "购物车中未找到该商品");
  }

  // 读取实时库存（购物车数量修改是 best-effort，下单时有乐观锁严格校验）
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { stock: true, status: true },
  });
  if (!product || product.status !== "APPROVED") {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, "商品已下架");
  }

  await prisma.cartItem.update({
    where: { id: item.id },
    data: { qty: Math.min(qty, product.stock) },
  });
}

// ── 删除商品 ──

export async function removeFromCart(
  userId: string,
  productId: string,
): Promise<void> {
  await prisma.cartItem.deleteMany({
    where: { userId, productId },
  });
}

// ── 清空购物车（下单后调用） ──

export async function clearCart(userId: string): Promise<void> {
  await prisma.cartItem.deleteMany({ where: { userId } });
}
