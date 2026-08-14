// 品牌方写入操作（CQS：本文件只写）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { yuanToFen } from "@/shared/utils/money";

// ── 提交新商品（需质检） ──

export interface SubmitProductInput {
  name: string;
  description?: string;
  category: string;
  subCategory: string; // 子类（API 层已校验与大类组合合法）
  price: number; // 元
  stock: number;
  specs?: Record<string, string>;
  images?: string[]; // 上传到 OSS 的公开 URL（schema 层已用 ossImageUrlSchema 校验）
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
      status: "PENDING", // 新商品默认待质检
    },
    select: { id: true },
  });
  return product;
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
