// OSS 适配器接口 + 阿里云 OSS 实现（仿 payment.adapter 范式）
// 策略：定义 OssAdapter 接口，阿里云 OSS 实现；微信/其它存储（二期）复用同一接口
//
// 环境变量（全部可选，未配置时优雅降级 → feature 层抛 503 STORAGE_NOT_CONFIGURED）：
//   OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_REGION（必填域）
//   OSS_PUBLIC_DOMAIN（可选，自定义公开访问域名/CDN；同时供 next.config 图片白名单）
//
// 安全要点：
// - key 生成绝不用客户端文件名，扩展名由白名单 MIME 映射（防路径穿越/特殊字符注入）
// - 对象 key 内嵌 userId（取鉴权 token，非客户端传），按人归属可审计

import OSS from "ali-oss";
import { randomUUID } from "crypto";

// ── 纯函数（导出供单测，仿 payment.adapter.getBeijingTimestamp） ──

export const ALLOWED_UPLOAD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export type AllowedUploadMime = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

/** 宽松的 env 形状：纯函数可注入任意对象供单测（process.env 天然兼容） */
export type OssEnvLike = Record<string, string | undefined>;

const REQUIRED_OSS_ENV_KEYS = [
  "OSS_ACCESS_KEY_ID",
  "OSS_ACCESS_KEY_SECRET",
  "OSS_BUCKET",
  "OSS_REGION",
] as const;

export function getMissingOssEnvKeys(env: OssEnvLike): string[] {
  return REQUIRED_OSS_ENV_KEYS.filter((key) => !env[key]);
}

export function getUnavailableReason(env: OssEnvLike): string | null {
  const missing = getMissingOssEnvKeys(env);
  if (missing.length === 0) return null;
  return `存储未配置，缺少环境变量: ${missing.join(", ")}`;
}

/** 归一化 host：去协议、去路径、去尾斜杠、去空白 */
export function normalizeHost(input: string): string {
  return input.replace(/^https?:\/\//, "").split("/")[0].trim();
}

/** 从 env 推导图片白名单 hosts（默认 OSS 域名 + 自定义 CDN 域名） */
export function getOssHostsFromEnv(env: OssEnvLike): string[] {
  const hosts: string[] = [];
  if (env.OSS_BUCKET && env.OSS_REGION) {
    hosts.push(`${env.OSS_BUCKET}.${env.OSS_REGION}.aliyuncs.com`);
  }
  if (env.OSS_PUBLIC_DOMAIN) {
    const host = normalizeHost(env.OSS_PUBLIC_DOMAIN);
    if (host) hosts.push(host);
  }
  return hosts;
}

export function getOssPublicUrl(opts: {
  bucket: string;
  region: string;
  key: string;
  publicDomain?: string | null;
}): string {
  const domain = opts.publicDomain
    ? normalizeHost(opts.publicDomain)
    : `${opts.bucket}.${opts.region}.aliyuncs.com`;
  return `https://${domain}/${opts.key}`;
}

export function getExtensionForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    default:
      throw new Error(`不支持的文件 MIME: ${mime}`);
  }
}

export function buildObjectKey(opts: {
  folder: string;
  userId: string;
  mime: AllowedUploadMime;
  randomId: string;
  date?: Date;
}): string {
  const d = opts.date ?? new Date();
  const ymd =
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${opts.folder}/${opts.userId}/${ymd}/${opts.randomId}.${getExtensionForMime(opts.mime)}`;
}

export function isOssUrlForHosts(url: string, hosts: string[]): boolean {
  if (!url.startsWith("https://")) return false;
  return hosts.includes(normalizeHost(url));
}

export function isOssUrl(url: string): boolean {
  return isOssUrlForHosts(url, getOssHostsFromEnv(process.env));
}

// ── G4 OSS key 结构 / 归属校验（纯函数，供消费侧 schema 与 service 复用） ──

/** 本站上传目录白名单（= 上传 purpose 枚举，buildObjectKey 的 folder 段） */
export const OSS_KEY_FOLDERS = ["product", "brand", "cert"] as const;

/**
 * 从 OSS URL 提取对象 key（host 白名单校验 + 去协议/去 host/去首斜杠）。
 * 非本站 OSS URL（host 不在白名单 / 无路径）返回 null。
 */
export function extractOssKeyFromUrl(url: string): string | null {
  if (!isOssUrl(url)) return null;
  const rest = url.split("://")[1] ?? "";
  const slashIndex = rest.indexOf("/");
  if (slashIndex < 0) return null;
  return rest.slice(slashIndex + 1);
}

/**
 * 校验 OSS key 符合本站上传结构：`<folder>/<userId>/<yyyymmdd>/<文件名>.<扩展名>`
 * （buildObjectKey 生成的格式）。folder 白名单 + userId 非空 + 日期 8 位 + 文件名带扩展名。
 * 目的：消费侧只收「经本站 /api/upload 生成的 URL」，拒绝任意外部/伪造 key
 * （如 img.example.com/other/fake.jpg 的 key=other/fake.jpg 只有 2 段，被拒）。
 */
export function isValidOssKeyStructure(key: string): boolean {
  const segments = key.split("/");
  if (segments.length !== 4) return false;
  const [folder, userId, ymd, fileName] = segments;
  if (!(OSS_KEY_FOLDERS as readonly string[]).includes(folder)) return false;
  if (!userId) return false;
  if (!/^\d{8}$/.test(ymd)) return false;
  return Boolean(fileName) && fileName!.includes(".");
}

/**
 * 校验 OSS URL 归属当前用户：key 的 userId 段（buildObjectKey 内嵌上传者 userId）等于给定用户。
 * 防「提交他人上传的 OSS URL」——品牌方入驻/商品/logo 只能使用本人上传的资源。
 */
export function isOssUrlOwnedBy(url: string, userId: string): boolean {
  const key = extractOssKeyFromUrl(url);
  if (!key || !isValidOssKeyStructure(key)) return false;
  return key.split("/")[1] === userId;
}

// ── 接口 ──

export interface PutObjectInput {
  folder: string; // "product" | "brand" | "cert"，决定 key 前缀（来自路由 purpose 白名单）
  userId: string; // 来自鉴权 token，绝不取自客户端
  mime: AllowedUploadMime;
  buffer: Buffer;
}

export interface PutObjectResult {
  success: boolean;
  url?: string; // 公开访问 URL
  key?: string; // OSS 对象 key（归属/排查用）
  error?: string;
}

export interface OssAdapter {
  /** 未配置 → 非 null（feature 层先行判定抛 503）；已配置 → null */
  getUnavailableReason(): string | null;
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
}

// ── OSS SDK 懒初始化 ──
// 环境变量未配置时不构造 SDK（模块加载阶段不抛错，上传流程可降级为 503）

let ossClient: OSS | null = null;
let unavailableReason: string | null = null;

function getOssClient(): OSS | null {
  if (ossClient) return ossClient;
  if (unavailableReason) return null;

  const reason = getUnavailableReason(process.env);
  if (reason) {
    unavailableReason = reason;
    return null;
  }

  ossClient = new OSS({
    region: process.env.OSS_REGION!,
    bucket: process.env.OSS_BUCKET!,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
  });
  return ossClient;
}

// ── 阿里云 OSS 适配器 ──

export function createOssAdapter(): OssAdapter {
  return {
    getUnavailableReason: () => unavailableReason ?? getUnavailableReason(process.env),

    async putObject(input) {
      const client = getOssClient();
      if (!client) {
        return { success: false, error: unavailableReason || "存储未配置" };
      }

      try {
        const key = buildObjectKey({
          folder: input.folder,
          userId: input.userId,
          mime: input.mime,
          randomId: randomUUID(),
        });
        // G3 证书 PDF 以下载方式输出（Content-Disposition: attachment）：
        // 浏览器不内联渲染 PDF，即使文件被魔数校验漏网为多态/带脚本，也不在浏览器页面上下文执行
        const isCertPdf = input.folder === "cert" && input.mime === "application/pdf";
        const headers = isCertPdf
          ? { "Content-Disposition": 'attachment; filename="certificate.pdf"' }
          : {};
        await client.put(key, input.buffer, { headers });
        const url = getOssPublicUrl({
          bucket: process.env.OSS_BUCKET!,
          region: process.env.OSS_REGION!,
          key,
          publicDomain: process.env.OSS_PUBLIC_DOMAIN,
        });
        return { success: true, url, key };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg };
      }
    },
  };
}

// 单例
export const ossAdapter: OssAdapter = createOssAdapter();
