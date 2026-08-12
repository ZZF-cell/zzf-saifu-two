// 加密与哈希工具 — AES-256-GCM 加密 + 手机号哈希 + scrypt 密码哈希
import crypto from "crypto";
import { promisify } from "util";

// scrypt 异步化（libuv 线程池执行，不阻塞事件循环）
const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const AES_ALGORITHM = "aes-256-gcm" as const;

/** 解析密钥列表，按版本索引 */
function getKeys(): Map<string, Buffer> {
  const keysStr = process.env.ENCRYPTION_KEYS || "";
  if (!keysStr) throw new Error("ENCRYPTION_KEYS 未配置");

  const map = new Map<string, Buffer>();
  for (const entry of keysStr.split(",")) {
    const match = entry.match(/^(v\d+):(.+)$/);
    if (match) {
      map.set(match[1], Buffer.from(match[2], "base64url"));
    }
  }
  if (map.size === 0) throw new Error("ENCRYPTION_KEYS 格式无效");
  return map;
}

/** 获取当前加密密钥（最左侧版本） */
function getCurrentVersion(): { version: string; key: Buffer } {
  const keysStr = process.env.ENCRYPTION_KEYS || "";
  const first = keysStr.split(",")[0];
  const match = first.match(/^(v\d+):(.+)$/);
  if (!match) throw new Error("ENCRYPTION_KEYS 格式无效");
  return { version: match[1], key: Buffer.from(match[2], "base64url") };
}

/**
 * 加密
 * 返回格式: base64url(<version>:<iv>:<authTag>:<ciphertext>)
 */
export function encrypt(plaintext: string): string {
  const { version, key } = getCurrentVersion();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64url");
  encrypted += cipher.final("base64url");
  const authTag = cipher.getAuthTag().toString("base64url");
  return `${version}:${iv.toString("base64url")}:${authTag}:${encrypted}`;
}

/**
 * 解密（自动根据密文版本前缀选择密钥）
 * 输入: base64url(<version>:<iv>:<authTag>:<ciphertext>)
 */
export function decrypt(ciphertext: string): string {
  const keys = getKeys();
  const parts = ciphertext.split(":");
  if (parts.length !== 4) throw new Error("密文格式无效");
  const [version, ivStr, authTagStr, encrypted] = parts;

  const key = keys.get(version);
  if (!key) throw new Error(`找不到密钥版本: ${version}`);

  const decipher = crypto.createDecipheriv(
    AES_ALGORITHM,
    key,
    Buffer.from(ivStr, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagStr, "base64url"));
  let decrypted = decipher.update(encrypted, "base64url", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * 手机号哈希: SHA-256(pepper + phone)
 * 不可逆，用于号码查重和登录校验
 * 生产环境 PEPPER 未配置时 fail-fast（默认 pepper 可被反推，绝不允许线上使用）
 */
export function hashPhone(phone: string): string {
  const pepper = process.env.PEPPER;
  if (!pepper) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PEPPER 未配置：生产环境禁止使用默认 pepper 计算手机号哈希");
    }
    console.warn("[crypto] PEPPER 未配置，使用默认 pepper（仅限开发环境）");
  }
  return crypto
    .createHash("sha256")
    .update((pepper || "default-pepper") + phone)
    .digest("hex");
}

// scrypt KDF 参数 — OWASP 推荐档位 N=2^14, r=8, p=1
// 慢哈希防离线爆破（单次约 50-100ms）；SHA-256 快速哈希已废弃
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

async function deriveScryptKey(password: string, salt: string): Promise<Buffer> {
  return scryptAsync(password, salt, 32, SCRYPT_PARAMS);
}

/**
 * 密码哈希（异步）: scrypt(password, salt)
 * 存储格式: `scrypt.<saltHex>.<hashBase64url>`（版本前缀便于未来 KDF 升级）
 */
export async function hashPassword(
  password: string,
  providedSalt?: string,
): Promise<string> {
  const salt = providedSalt || crypto.randomBytes(16).toString("hex");
  const derived = await deriveScryptKey(password, salt);
  return `scrypt.${salt}.${derived.toString("base64url")}`;
}

/**
 * 校验密码（异步，恒定时间比较）
 * - 新格式 `scrypt.xx.yy` → scrypt 校验
 * - 兼容旧格式 `salt.hash`（SHA-256 时代的历史密码，登录成功后由服务层升级为 scrypt）
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const legacy = !storedHash.startsWith("scrypt.");
  // 格式差异：旧格式 `salt.hash`（2 段）；scrypt 格式 `scrypt.salt.hash`（3 段，跳过版本前缀）
  const parts = storedHash.split(".");
  const salt = legacy ? parts[0] : parts[1];
  const expected = legacy ? parts[1] : parts[2];
  if (!salt || !expected) return false;

  const actual = legacy
    ? crypto.createHash("sha256").update(salt + password).digest("hex")
    : (await deriveScryptKey(password, salt)).toString("base64url");

  if (Buffer.byteLength(actual, "utf8") !== Buffer.byteLength(expected, "utf8")) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(actual, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

/**
 * 简单 SHA-256 哈希（用于 Token 哈希等不需要 salt 的场景）
 */
export function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * 生成随机 Token（Refresh Token 用）
 */
export function generateToken(length = 32): string {
  return crypto.randomBytes(length).toString("base64url");
}
