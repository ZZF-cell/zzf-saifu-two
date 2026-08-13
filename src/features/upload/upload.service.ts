// 上传服务（CQS：本文件只写）— 文件 → OSS → URL
// 依赖 shared/adapters/oss.adapter 单例；未配置 OSS 时先行抛 503（决策：返回失败标记，不做 base64 回退）
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { ossAdapter, type PutObjectInput } from "@/shared/adapters/oss.adapter";

export async function uploadImage(
  input: PutObjectInput,
): Promise<{ url: string; key: string }> {
  const reason = ossAdapter.getUnavailableReason();
  if (reason) {
    throw new AppError(ERROR_CODES.STORAGE_NOT_CONFIGURED, reason);
  }

  const result = await ossAdapter.putObject(input);
  if (!result.success) {
    throw new AppError(ERROR_CODES.UPLOAD_FAILED, result.error || "图片上传失败");
  }
  return { url: result.url!, key: result.key! };
}
