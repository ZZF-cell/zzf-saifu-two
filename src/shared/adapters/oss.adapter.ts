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

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

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
    default:
      throw new Error(`不支持的图片 MIME: ${mime}`);
  }
}

export function buildObjectKey(opts: {
  folder: string;
  userId: string;
  mime: AllowedImageMime;
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

// ── 接口 ──

export interface PutObjectInput {
  folder: string; // "product" | "brand"，决定 key 前缀（来自路由 purpose 白名单）
  userId: string; // 来自鉴权 token，绝不取自客户端
  mime: AllowedImageMime;
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
        await client.put(key, input.buffer);
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
