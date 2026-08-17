// 通用 Zod 校验 Schemas — 全局复用
import { z } from "zod";
import {
  isOssUrl,
  extractOssKeyFromUrl,
  isValidOssKeyStructure,
} from "@/shared/adapters/oss.adapter";

// 手机号（中国大陆）
export const phoneSchema = z
  .string()
  .regex(/^1[3-9]\d{9}$/, "手机号格式不正确");

// 分页参数
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// 排序参数
export const sortSchema = z.object({
  sortBy: z.enum(["createdAt", "price", "sales"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// 货币金额（分为单位，整数）
export const moneySchema = z.number().int().min(0);

// 昵称
export const nicknameSchema = z
  .string()
  .min(2, "昵称至少 2 个字符")
  .max(20, "昵称最多 20 个字符")
  .optional();

// 密码
export const passwordSchema = z
  .string()
  .min(6, "密码至少 6 位")
  .max(64, "密码最长 64 位");

// OSS 图片 URL（只接受白名单 host 的 https URL，拒绝任意外链/大体积 base64）
// G4 key 前缀归属校验：URL 的 key 必须是本站上传结构 `<folder>/<userId>/<yyyymmdd>/<文件名>.<扩展名>`
// （buildObjectKey 生成格式）—— 只收经 /api/upload 生成的 URL，拒绝伪造/外部 key
export const ossImageUrlSchema = z
  .string()
  .trim()
  .max(500, "图片地址过长")
  .refine(isOssUrl, "图片必须是有效的 OSS 地址")
  .refine((url) => {
    const key = extractOssKeyFromUrl(url);
    return key !== null && isValidOssKeyStructure(key);
  }, "图片地址格式不正确");
