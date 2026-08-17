// Upload 模块 API Route Handlers — POST /api/upload（multipart/form-data）
// 任意登录用户可传（BRAND 传商品图、USER 入驻传 logo、BRAND 传检测证书）：
// 归属约束 = key 内嵌 userId（服务端取 token）+ purpose 枚举白名单 + 消费侧 schema 只收 OSS URL
//
// ⚠️ multipart 不能复用 withValidation（其内部 req.json()），故手动 req.formData() + zod
// 校验失败直接 return apiError(parsed.error)（ZodError → 422，结构已统一）
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/shared/utils/api";
import { authenticateUser } from "@/shared/api/auth";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { hitRateLimit, hashKey } from "@/shared/utils/rate-limit";
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  type AllowedUploadMime,
} from "@/shared/adapters/oss.adapter";
import { uploadImage } from "./upload.service";

// 图片 4MB / PDF 10MB：Vercel Node Serverless 请求体限制约 4.5MB，multipart 编码留余量（平台层 413 行为见 README）；
// 检测证书扫描件常超 4MB，PDF 单独放宽到 10MB
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

// G3 检测证书是品牌方提交商品的质检材料，仅 BRAND 角色可上传 cert 用途
// （USER 无商品可提交，传证无业务意义且可被用来伪造资质材料堆砌）。
// product/brand 用途仍放行任意登录用户：product=商品图（BRAND 用）、brand=入驻 logo（USER 激活时传）
const CERT_UPLOAD_ROLES: readonly string[] = ["BRAND"];

// G1 每日上传配额（复用 RateLimitBucket 原子桶）：单用户 24h 窗口最多 100 次。
// 防批量灌图刷 OSS 存储/流量；窗口滑动自动开新桶（与短信限流同机制）
const UPLOAD_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPLOAD_DAILY_MAX = 100;

const isPdfMime = (mime: string) => mime === "application/pdf";

const uploadFormSchema = z
  .object({
    file: z
      .instanceof(File, { message: "请选择文件" })
      .refine((f) => f.size > 0, "文件不能为空"),
    purpose: z.enum(["product", "brand", "cert"]).default("product"),
  })
  .superRefine((data, ctx) => {
    const { file, purpose } = data;
    const isPdf = isPdfMime(file.type);
    // product/brand 用途只收图片（商品主图/品牌 logo）；cert 收图片 + PDF（检测证书）
    if (isPdf && purpose !== "cert") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file"],
        message: "该场景仅支持 JPG/PNG/WebP 图片",
      });
      return;
    }
    if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file"],
        message: "仅支持 JPG/PNG/WebP 图片或 PDF",
      });
      return;
    }
    const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
    if (file.size > maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file"],
        message: isPdf ? "PDF 不能超过 10MB" : "图片不能超过 4MB",
      });
    }
  });

/** POST /api/upload — 上传图片到 OSS，返回公开 URL（未配置 → 503） */
export async function uploadFile(req: Request) {
  try {
    const user = await authenticateUser(req); // 401
    const form = await req.formData();
    const parsed = uploadFormSchema.safeParse({
      file: form.get("file"),
      purpose: form.get("purpose") ?? "product",
    });
    if (!parsed.success) return apiError(parsed.error); // 422

    // G3 角色限定：cert 用途仅 BRAND（非 BRAND 传证 → 403）
    if (parsed.data.purpose === "cert" && !CERT_UPLOAD_ROLES.includes(user.role)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, "仅品牌方可上传检测证书");
    }

    // G1 每日配额：有效请求才扣（校验失败/越权不占配额），原子桶防并发绕过
    const daily = await hitRateLimit("upload:daily", hashKey(user.userId), {
      windowMs: UPLOAD_DAILY_WINDOW_MS,
      max: UPLOAD_DAILY_MAX,
    });
    if (!daily.allowed) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, "今日上传次数已达上限，请明日再试");
    }

    const buffer = Buffer.from(await parsed.data.file.arrayBuffer());
    const { url, key } = await uploadImage({
      userId: user.userId, // 服务端取 token，绝不信任客户端传入的 userId
      folder: parsed.data.purpose,
      mime: parsed.data.file.type as AllowedUploadMime,
      buffer,
    });
    return NextResponse.json({ success: true, url, key }, { status: 201 });
  } catch (error) {
    return apiError(error); // 503 STORAGE_NOT_CONFIGURED / 502 UPLOAD_FAILED
  }
}
