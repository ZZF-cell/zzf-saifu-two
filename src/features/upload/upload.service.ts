// 上传服务（CQS：本文件只写）— 文件 → OSS → URL
// 依赖 shared/adapters/oss.adapter 单例；未配置 OSS 时先行抛 503（决策：返回失败标记，不做 base64 回退）
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { ossAdapter, type PutObjectInput, type AllowedUploadMime } from "@/shared/adapters/oss.adapter";

// ── L14 魔数校验 ──
// 客户端声明的 MIME（file.type）不可信：攻击者能把 HTML/JS 改名 image.png 上传
// （MIME 伪造），OSS 以公开 URL 直出 → 存储型 XSS/钓鱼。上传前必须按白名单 MIME
// 核对文件头魔数，内容与声明不符即拒绝（422），绝不把不可信内容以图片名义公开。

// G2 魔数加强（对抗验证）：
// - JPEG：仅 FF D8 FF 开头可被 HTML/JS 伪装（polyglot 开头塞三个字节即可），
//   追加 SOF 段标记扫描（FF C0-CF，排除 DHT=C4 / JPG=C8 / DAC=CC）——
//   真正的 JPEG 文件必然在文件头附近声明图像帧结构，这是「真 JPEG」而非伪装的证据。
// - PDF：非多态 —— 要求 %PDF- 严格出现在字节 0-4（HTML polyglot 无法同时以 %PDF- 和 < 开头）、
//   且含对象结构关键字 obj（头部 1KB）+ 结束标记 %%EOF（尾部 2KB）。
//   纯 HTML/JS 伪装或截断的伪 PDF 因缺 %%EOF/obj 被拒。
const MAGIC_BY_MIME: Record<AllowedUploadMime, (b: Buffer) => boolean> = {
  "image/jpeg": (b) => {
    if (!(b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return false;
    // SOF 紧随文件头（APP 段之后），扫描前 4KB 足够
    const scanEnd = Math.min(b.length, 4096);
    for (let i = 2; i < scanEnd - 1; i++) {
      if (b[i] === 0xff) {
        const marker = b[i + 1];
        if (
          marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        ) {
          return true;
        }
      }
    }
    return false;
  },
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
  "application/pdf": (b) => {
    if (!(b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-")) return false;
    // latin1 逐字节映射不损坏二进制，可用 includes 搜索 ASCII 关键字
    const head = b.toString("latin1", 0, Math.min(b.length, 1024));
    if (!head.includes("obj")) return false;
    const tail = b.toString("latin1", Math.max(0, b.length - 2048));
    return tail.includes("%%EOF");
  },
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
