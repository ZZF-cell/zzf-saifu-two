// 品牌方后台查询 — 品牌概览 + 商品/订单列表（只读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { ORDER_STATUS, getOrderListByBrand } from "@/features/orders";
import type { BrandOrderListResult } from "@/features/orders";
import type { Prisma } from "@prisma/client";

// ── 按用户查品牌（归属校验，纯读 → CQS 归查询层） ──

export interface BrandIdentity {
  id: string;
  name: string;
  logo: string | null;
  status: string;
}

export async function getBrandByOwner(userId: string): Promise<BrandIdentity> {
  const brand = await prisma.brand.findUnique({
    where: { ownerId: userId },
    select: { id: true, name: true, logo: true, status: true },
  });
  if (!brand) throw new AppError(ERROR_CODES.BRAND_NOT_FOUND, "您还未开通品牌方账号");
  return brand;
}

// ── 品牌概览 ──

export interface BrandOverview {
  brand: {
    id: string;
    name: string;
    logo: string | null;
    status: string;
    createdAt: Date;
  };
  productCount: number;
  approvedProductCount: number;
  orderCount: number;
  paidRevenue: number; // 已支付订单总金额（分）
}

export async function getBrandOverview(brandId: string): Promise<BrandOverview> {
  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    select: { id: true, name: true, logo: true, status: true, createdAt: true },
  });
  if (!brand) throw new AppError(ERROR_CODES.BRAND_NOT_FOUND, "品牌不存在");

  const products = await prisma.product.findMany({
    where: { brandId },
    select: { id: true, status: true },
  });
  const productIds = products.map((p) => p.id);

  // 品牌没有任何商品 → 直接返回零统计，绝不查全平台订单/销售额（防跨租户数据泄漏）
  if (productIds.length === 0) {
    return {
      brand,
      productCount: 0,
      approvedProductCount: 0,
      orderCount: 0,
      paidRevenue: 0,
    };
  }

  const paidFamily = [
    ORDER_STATUS.PAID,
    ORDER_STATUS.SHIPPED,
    ORDER_STATUS.DELIVERED,
    ORDER_STATUS.COMPLETED,
  ];
  const orderWhere: Prisma.OrderWhereInput = {
    items: { some: { productId: { in: productIds } } },
  };

  const [orderCount, paidItems] = await Promise.all([
    prisma.order.count({ where: orderWhere }),
    // 只聚合本品牌商品行的实付金额（price 行总额之和，price 已含 ×qty），
    // 避免混合品牌订单的整单金额被每个涉及品牌各全额计入（跨品牌金额泄漏）
    prisma.orderItem.findMany({
      where: {
        productId: { in: productIds },
        order: { status: { in: paidFamily } },
      },
      select: { price: true },
    }),
  ]);

  const paidRevenue = paidItems.reduce((sum, i) => sum + i.price, 0);

  return {
    brand,
    productCount: products.length,
    approvedProductCount: products.filter((p) => p.status === "APPROVED").length,
    orderCount,
    paidRevenue,
  };
}

// ── 品牌商品列表 ──

export interface BrandProductRow {
  id: string;
  name: string;
  category: string;
  subCategory: string | null;
  price: number;
  stock: number;
  status: string;
  sales: number;
  description: string | null;
  images: unknown;
  certificates: unknown;
  createdAt: Date;
}

export interface BrandProductListResult {
  items: BrandProductRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getBrandProducts(
  brandId: string,
  page = 1,
  pageSize = 20,
): Promise<BrandProductListResult> {
  const where: Prisma.ProductWhereInput = { brandId };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        category: true,
        subCategory: true,
        price: true,
        stock: true,
        status: true,
        sales: true,
        description: true,
        images: true,
        certificates: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── 质检模板按大类查询（品牌提交页读「该品类必交材料」；无模板 → null） ──

export async function getAuditTemplateByCategory(
  categoryId: string,
): Promise<{ requiredDocs: unknown; checkPoints: unknown } | null> {
  return prisma.categoryAuditTemplate.findUnique({
    where: { categoryId },
    select: { requiredDocs: true, checkPoints: true },
  });
}

// ── 品牌订单列表（复用 orders 模块 getOrderListByBrand，按品牌商品过滤） ──

export async function getBrandOrders(
  brandId: string,
  page = 1,
  pageSize = 20,
): Promise<BrandOrderListResult> {
  const products = await prisma.product.findMany({
    where: { brandId },
    select: { id: true },
  });
  return getOrderListByBrand(
    products.map((p) => p.id),
    page,
    pageSize,
  );
}
