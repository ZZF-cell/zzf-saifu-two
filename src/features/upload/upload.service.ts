// 上传服务（CQS：本文件只写）— 文件 → OSS → URL
// 依赖 shared/adapters/oss.adapter 单例；未配置 OSS 时先行抛 503（决策：返回失败标记，不做 base64 回退）
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { ossAdapter, type PutObjectInput, type AllowedUploadMime } from "@/shared/adapters/oss.adapter";

// ── L14 魔数校验 ──
// 客户端声明的 MIME（file.type）不可信：攻击者能把 HTML/JS 改名 image.png 上传
// （MIME 伪造），OSS 以公开 URL 直出 → 存储型 XSS/钓鱼。上传前必须按白名单 MIME
// 核对文件头魔数，内容与声明不符即拒绝（422），绝不把不可信内容以图片名义公开。

const MAGIC_BY_MIME: Record<AllowedUploadMime, (b: Buffer) => boolean> = {
  // JPEG: FF D8 FF
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  "image/png": (b) =>
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  // WebP: "RIFF"...."WEBP"
  "image/webp": (b) =>
    b.length >= 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP",
  // PDF: "%PDF-"
  "application/pdf": (b) => b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-",
};

/** 校验文件头魔数与声明 MIME 一致，不符抛 VALIDATION_ERROR（拒绝上传） */
export function assertValidMagicBytes(mime: AllowedUploadMime, buffer: Buffer): void {
  const check = MAGIC_BY_MIME[mime];
  if (!check || !check(buffer)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "文件内容与声明的类型不符，请重新上传",
    );
  }
}

export async function uploadImage(
  input: PutObjectInput,
): Promise<{ url: string; key: string }> {
  const reason = ossAdapter.getUnavailableReason();
  if (reason) {
    throw new AppError(ERROR_CODES.STORAGE_NOT_CONFIGURED, reason);
  }

  // 内容校验先于任何写操作：文件到达 OSS 之前拒绝伪造内容
  assertValidMagicBytes(input.mime, input.buffer);

  const result = await ossAdapter.putObject(input);
  if (!result.success) {
    throw new AppError(ERROR_CODES.UPLOAD_FAILED, result.error || "图片上传失败");
  }
  return { url: result.url!, key: result.key! };
}
