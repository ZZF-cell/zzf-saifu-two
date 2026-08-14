// 上传前端预检常量 — 与 src/features/upload/upload.api.ts 服务端校验保持一致
// 前端预检避免发起注定 422 的请求；服务端仍是最终仲裁（MIME 白名单 / 4MB/10MB 上限）
// 使用方：品牌入驻 Logo 上传、品牌后台提交商品图片上传、检测证书上传

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 图片：Vercel Node Serverless 请求体约 4.5MB，multipart 留余量
export const MAX_CERT_BYTES = 10 * 1024 * 1024; // 证书 PDF 扫描件常超 4MB，单独放宽到 10MB

export const ALLOWED_IMAGE_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

// 检测证书：图片 + PDF 都允许
export const ALLOWED_CERT_TYPES: readonly string[] = [
  ...ALLOWED_IMAGE_TYPES,
  "application/pdf",
];

// 商品主图上限 — 与 brand.submitProductSchema images.max(5) 一致
export const MAX_PRODUCT_IMAGES = 5;

// 检测证书上限 — 与 brand.submitProductSchema certificates.max(5) 一致
export const MAX_PRODUCT_CERTIFICATES = 5;
