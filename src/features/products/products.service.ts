// 商品模块 — 业务逻辑 + 查询
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { toJsonStringArray } from "@/shared/utils/format";
import { PRODUCT_CATEGORIES, type ProductCategory } from "@/shared/constants/product-categories";
import type { Prisma } from "@prisma/client";

// ── 类型 ──

export interface ProductListParams {
  page: number;
  pageSize: number;
  category?: string;
  subCategory?: string;
  search?: string;
  sortBy: "createdAt" | "price" | "sales";
  sortOrder: "asc" | "desc";
}

export interface ProductListItem {
  id: string;
  name: string;
  price: number;
  images: string[];
  category: string;
  subCategory: string | null;
  sales: number;
  createdAt: Date;
}

export interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  price: number;
  images: string[];
  specs: unknown;
  category: string;
  subCategory: string | null;
  stock: number;
  version: number;
  sales: number;
  status: string;
  brand: {
    id: string;
    name: string;
  };
}

export interface ProductListResult {
  items: ProductListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ── 商品列表（分页 + 搜索 + 分类筛选 + 排序） ──

export async function getProductList(
  params: ProductListParams,
): Promise<ProductListResult> {
  const { page, pageSize, category, subCategory, search, sortBy, sortOrder } = params;

  const where: Prisma.ProductWhereInput = {
    status: "APPROVED", // 只展示审核通过的商品
    stock: { gt: 0 },   // 只展示有库存的商品
    ...(category ? { category } : {}),
    ...(subCategory ? { subCategory } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { description: { contains: search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        price: true,
        images: true,
        category: true,
        subCategory: true,
        sales: true,
        createdAt: true,
      },
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items: items.map((item) => ({
      ...item,
      images: toJsonStringArray(item.images),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── 商品详情 ──

export async function getProductById(
  id: string,
): Promise<ProductDetail | null> {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      brand: { select: { id: true, name: true } },
    },
  });

  if (!product) return null;

  return {
    ...product,
    images: toJsonStringArray(product.images),
    specs: product.specs as unknown,
  };
}

// ── 获取商品详情（带 404 处理） ──

export async function requireProductById(id: string): Promise<ProductDetail> {
  const product = await getProductById(id);
  if (!product) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, "商品不存在");
  }
  return product;
}

// ── 获取所有品类（两级结构：大类 + 子类，用于分类筛选器） ──

export async function getCategories(): Promise<ProductCategory[]> {
  // 平台预设类目清单（唯一来源：src/shared/constants/product-categories.ts）
  // 不再从在售商品反推：全部大类恒出现，前端渲染完整两级树
  return PRODUCT_CATEGORIES;
}
