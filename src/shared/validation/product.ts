// 商品字段共享 Zod 校验 — 品牌提交 / 品牌编辑 / 管理端编辑复用同一套约束
import { z } from "zod";
import { ossImageUrlSchema } from "@/shared/validation/schemas";
import { ALLOWED_UPLOAD_MIME_TYPES } from "@/shared/adapters/oss.adapter";
import { isValidCategoryPair } from "@/shared/constants/product-categories";

// 商品字段对象：抽自原 brand.api submitProductSchema 的字段层
// 注意「类目组合校验」必须放 superRefine（依赖两个字段联合判断），
// 因此先把字段对象拆出：submit 用 object(productFields) 全量必填，
// update 用 object(productFields).partial() 支持部分更新。
export const productFields = {
  name: z.string().trim().min(1, "商品名称不能为空").max(100),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().min(1, "请选择大类").max(50),
  subCategory: z.string().trim().min(1, "请选择子类").max(50),
  images: z.array(ossImageUrlSchema).max(5, "最多 5 张图片").optional(),
  // 检测证书（随商品提交）：url 必须过 OSS host 校验，mime 必须来自白名单（图片+PDF）
  certificates: z
    .array(
      z.object({
        url: ossImageUrlSchema,
        name: z.string().trim().min(1, "证书名称不能为空").max(100),
        mime: z.enum(ALLOWED_UPLOAD_MIME_TYPES),
      }),
    )
    .max(5, "最多 5 份检测证书")
    .optional(),
  // 价格（元）：min 0.01 保证元→分后至少 1 分（0.001 会 round 成 0 分免费商品）；
  // max 21_474_836 保证 ×100 后不超 PostgreSQL Int 上限（2^31-1），防溢出写库报 500
  price: z.number().positive("价格必须大于 0").min(0.01).max(21_474_836),
  stock: z.number().int().min(0, "库存不能为负").max(2_147_483_647), // Int 上限
  specs: z.record(z.string(), z.string()).optional(),
} as const;

/**
 * 类目组合校验（superRefine 用）。
 * 仅当 category 与 subCategory「同时出现」才校验 isValidCategoryPair：
 * 兼容 partial 更新（只改价格时 subCategory 缺省，不误拦）。
 */
export function categoryPairRefine(
  data: { category?: string; subCategory?: string },
  ctx: z.RefinementCtx,
): void {
  if (data.category === undefined || data.subCategory === undefined) return;
  if (!isValidCategoryPair(data.category, data.subCategory)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subCategory"],
      message: "大类与子类不是合法组合",
    });
  }
}

/** 更新商品（品牌/管理端编辑共用）：全字段可选，但至少更新一个字段 */
export const updateProductSchema = z
  .object(productFields)
  .partial()
  .superRefine(categoryPairRefine)
  .refine((data) => Object.keys(data).length > 0, "至少需要更新一个字段");
