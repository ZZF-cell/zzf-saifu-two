// Upload 模块 API Route Handlers — POST /api/upload（multipart/form-data）
// 任意登录用户可传（BRAND 传商品图、USER 入驻传 logo、ADMIN 管理）：
// 归属约束 = key 内嵌 userId（服务端取 token）+ purpose 枚举白名单 + 消费侧 schema 只收 OSS URL
//
// ⚠️ multipart 不能复用 withValidation（其内部 req.json()），故手动 req.formData() + zod
// 校验失败直接 return apiError(parsed.error)（ZodError → 422，结构已统一）
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/shared/utils/api";
import { authenticateUser } from "@/shared/api/auth";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  type AllowedImageMime,
} from "@/shared/adapters/oss.adapter";
import { uploadImage } from "./upload.service";

// 4MB 上限：Vercel Node Serverless 请求体限制约 4.5MB，multipart 编码留余量（平台层 413 行为见 README）
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const uploadFormSchema = z.object({
  file: z
    .instanceof(File, { message: "请选择图片文件" })
    .refine(
      (f) => (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(f.type),
      "仅支持 JPG/PNG/WebP 图片",
    )
    .refine((f) => f.size > 0, "文件不能为空")
    .refine((f) => f.size <= MAX_UPLOAD_BYTES, "图片不能超过 4MB"),
  purpose: z.enum(["product", "brand"]).default("product"),
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

    const buffer = Buffer.from(await parsed.data.file.arrayBuffer());
    const { url, key } = await uploadImage({
      userId: user.userId, // 服务端取 token，绝不信任客户端传入的 userId
      folder: parsed.data.purpose,
      mime: parsed.data.file.type as AllowedImageMime,
      buffer,
    });
    return NextResponse.json({ success: true, url, key }, { status: 201 });
  } catch (error) {
    return apiError(error); // 503 STORAGE_NOT_CONFIGURED / 502 UPLOAD_FAILED
  }
}
