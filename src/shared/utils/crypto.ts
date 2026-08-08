// 加密与哈希工具 — AES-256-GCM 加密 + 手机号哈希
import crypto from "crypto";

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
 */
export function hashPhone(phone: string): string {
  const pepper = process.env.PEPPER || "default-pepper";
  return crypto
    .createHash("sha256")
    .update(pepper + phone)
    .digest("hex");
}

/**
 * 密码哈希: SHA-256(salt + password)，salt 存储于 passwordHash 中以 . 分隔
 */
export function hashPassword(password: string, providedSalt?: string): string {
  const salt = providedSalt || crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .createHash("sha256")
    .update(salt + password)
    .digest("hex");
  return `${salt}.${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt] = storedHash.split(".");
  return hashPassword(password, salt) === storedHash;
}

/**
 * 生成随机 Token（Refresh Token 用）
 */
export function generateToken(length = 32): string {
  return crypto.randomBytes(length).toString("base64url");
}
