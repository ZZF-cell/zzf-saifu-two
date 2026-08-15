// 品牌方写入操作（CQS：本文件只写）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { yuanToFen } from "@/shared/utils/money";
import { writeAuditLog } from "@/shared/utils/audit";
import type { Prisma } from "@prisma/client";


// ── 提交新商品（需质检） ──

export interface ProductCertificate {
  url: string; // OSS 公开 URL（schema 层已校验）
  name: string; // 证书名称（如"第三方检测报告.pdf"）
  mime: string; // 白名单 MIME（image/* 或 application/pdf）
}

export interface SubmitProductInput {
  name: string;
  description?: string;
  category: string;
  subCategory: string; // 子类（API 层已校验与大类组合合法）
  price: number; // 元
  stock: number;
  specs?: Record<string, string>;
  images?: string[]; // 上传到 OSS 的公开 URL（schema 层已用 ossImageUrlSchema 校验）
  certificates?: ProductCertificate[]; // 随商品提交的检测证书（图片/PDF）
}

export async function submitProduct(
  brandId: string,
  input: SubmitProductInput,
): Promise<{ id: string }> {
  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    select: { status: true },
  });
  if (!brand) throw new AppError(ERROR_CODES.BRAND_NOT_FOUND, "品牌不存在");
  if (brand.status !== "APPROVED") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "品牌审核通过后才能提交商品");
  }

  const product = await prisma.product.create({
    data: {
      brandId,
      name: input.name,
      description: input.description ?? null,
      category: input.category,
      subCategory: input.subCategory,
      price: yuanToFen(input.price),
      stock: input.stock,
      specs: input.specs as unknown as object | undefined,
      images: (input.images ?? []) as unknown as object,
      certificates: (input.certificates ?? []) as unknown as object,
      status: "PENDING", // 新商品默认待质检
    },
    select: { id: true },
  });
  return product;
}

// ── 商品撤回 / 下架 / 重新上架 / 编辑（与 admin 同一套状态机，但强制 brandId 归属） ──

export interface BrandProductUpdateInput {
  name?: string;
  description?: string | null;
  category?: string;
  subCategory?: string;
  price?: number; // 元
  stock?: number;
  images?: string[];
  certificates?: ProductCertificate[];
  specs?: Record<string, string>;
}

/** 守卫命中 0 行时区分原因：不存在(404) / 非本品牌(403) / 状态不允许(409) */
async function assertOwnedAndStatus(
  tx: Prisma.TransactionClient,
  productId: string,
  brandId: string,
  message: string,
): Promise<never> {
  const existing = await tx.product.findUnique({
    where: { id: productId },
    select: { brandId: true },
  });
  if (!existing) throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, "商品不存在");
  if (existing.brandId !== brandId) throw new AppError(ERROR_CODES.BRAND_NOT_OWNED, "无权操作该商品");
  throw new AppError(ERROR_CODES.PRODUCT_STATUS_INVALID, message);
}

/** 基本信息变更判定（只读旧值比较，价格/库存属运营信息不触发重审） */
function basicInfoChanged(
  old: {
    name: string;
    category: string;
    subCategory: string | null;
    description: string | null;
    images: unknown;
    certificates: unknown;
    specs: unknown;
  },
  input: BrandProductUpdateInput,
): boolean {
  if (input.name !== undefined && input.name !== old.name) return true;
  if (input.category !== undefined && input.category !== old.category) return true;
  if (input.subCategory !== undefined && input.subCategory !== old.subCategory) return true;
  // description 传 ""（表单清空）归一化 null：与写侧 `input.description || null` 一致，
  // 旧值为 null 时清空不误判为重审
  if (input.description !== undefined && (input.description || null) !== old.description) return true;
  if (input.images !== undefined && JSON.stringify(input.images) !== JSON.stringify(old.images)) return true;
  // 检测证书属基本信息（质检依据）：改证书需重审
  if (input.certificates !== undefined && JSON.stringify(input.certificates) !== JSON.stringify(old.certificates)) return true;
  if (input.specs !== undefined && JSON.stringify(input.specs) !== JSON.stringify(old.specs)) return true;
  return false;
}

/** 撤回待审提交：PENDING → WITHDRAWN（从审核队列撤下，不删除记录） */
export async function withdrawProduct(
  brandId: string,
  productId: string,
  operatorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.product.updateMany({
      where: { id: productId, brandId, status: "PENDING" },
      data: { status: "WITHDRAWN", version: { increment: 1 } },
    });
    if (updated.count === 0) {
      await assertOwnedAndStatus(tx, productId, brandId, "仅待质检商品可撤回");
    }
    await writeAuditLog(tx, "Product", productId, "PRODUCT_WITHDRAWN", operatorId);
  });
}

/** 下架：APPROVED → DELISTED */
export async function delistProduct(
  brandId: string,
  productId: string,
  operatorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.product.updateMany({
      where: { id: productId, brandId, status: "APPROVED" },
      data: { status: "DELISTED", version: { increment: 1 } },
    });
    if (updated.count === 0) {
      await assertOwnedAndStatus(tx, productId, brandId, "仅已上架商品可下架");
    }
    await writeAuditLog(tx, "Product", productId, "PRODUCT_DELISTED", operatorId);
  });
}

/** 重新上架：DELISTED → APPROVED（不重质检，用户已确认） */
export async function relistProduct(
  brandId: string,
  productId: string,
  operatorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.product.updateMany({
      where: { id: productId, brandId, status: "DELISTED" },
      data: { status: "APPROVED", version: { increment: 1 } },
    });
    if (updated.count === 0) {
      await assertOwnedAndStatus(tx, productId, brandId, "仅已下架商品可重新上架");
    }
    await writeAuditLog(tx, "Product", productId, "PRODUCT_RELISTED", operatorId);
  });
}

/** 编辑商品：基本信息变更 → 已上架/已下架回待质检；拒绝/撤回任意改 → 重新提交；仅运营信息 → 状态不变 */
export async function updateProduct(
  brandId: string,
  productId: string,
  input: BrandProductUpdateInput,
  operatorId: string,
): Promise<{ id: string; status: string }> {
  return prisma.$transaction(async (tx) => {
    const old = await tx.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        brandId: true,
        name: true,
        category: true,
        subCategory: true,
        description: true,
        images: true,
        certificates: true,
        specs: true,
        status: true,
      },
    });
    if (!old) throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, "商品不存在");
    if (old.brandId !== brandId) throw new AppError(ERROR_CODES.BRAND_NOT_OWNED, "无权操作该商品");

    const basicChanged = basicInfoChanged(old, input);
    let nextStatus = old.status;
    let action = "PRODUCT_UPDATE";
    if (basicChanged && (old.status === "APPROVED" || old.status === "DELISTED")) {
      nextStatus = "PENDING";
      action = "PRODUCT_UPDATE_REVIEW";
    } else if (old.status === "REJECTED" || old.status === "WITHDRAWN") {
      nextStatus = "PENDING";
      action = "PRODUCT_UPDATE_RESUBMIT";
    }

    const data: Prisma.ProductUpdateManyMutationInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      // description 清空：传 "" 归一化 null 防与旧 null 比较误判重审
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.subCategory !== undefined ? { subCategory: input.subCategory } : {}),
      ...(input.price !== undefined ? { price: yuanToFen(input.price) } : {}),
      ...(input.stock !== undefined ? { stock: input.stock } : {}),
      ...(input.images !== undefined ? { images: input.images as unknown as object } : {}),
      ...(input.certificates !== undefined ? { certificates: input.certificates as unknown as object } : {}),
      ...(input.specs !== undefined ? { specs: input.specs as unknown as object } : {}),
      ...(nextStatus !== old.status ? { status: nextStatus } : {}),
      version: { increment: 1 },
    };

    // 守卫 status: old.status + brandId：读后并发变更/越权写入整体失败
    const updated = await tx.product.updateMany({
      where: { id: productId, brandId, status: old.status },
      data,
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.PRODUCT_STATUS_INVALID, "商品状态已变更，请刷新后重试");
    }

    await writeAuditLog(tx, "Product", productId, action, operatorId, {
      before: {
        name: old.name,
        category: old.category,
        subCategory: old.subCategory,
        status: old.status,
      },
      after: { status: nextStatus },
    });

    return { id: productId, status: nextStatus };
  });
}

// ── 更新品牌资料 ──

export async function updateBrandProfile(
  brandId: string,
  input: { name?: string; logo?: string },
): Promise<{ success: true }> {
  await prisma.brand.update({
    where: { id: brandId },
    data: {
      ...(input.name !== undefined && input.name.trim() ? { name: input.name.trim() } : {}),
      ...(input.logo !== undefined ? { logo: input.logo } : {}),
    },
  });
  return { success: true };
}
