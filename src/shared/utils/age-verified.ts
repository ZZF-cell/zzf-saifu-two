// 年龄验证 cookie 服务端签名（L4）
// 修复前 age_verified=1 由客户端 document.cookie 直接写入，中间件只看「存在性」——
// 任何人一行 JS 即可伪造跳过年龄门禁。现改为服务端 HMAC 签名：
//   cookie 值 = "<签发时刻(ms)>.<hmac-sha256 hex>"
// 签发只在服务端（age-verify 路由，Web Crypto HMAC），中间件验签，客户端无法伪造。
// 密钥从 JWT_SECRET 域分离派生（"age-verified:" 前缀），不引入新环境变量。
// Web Crypto（crypto.subtle）在 Edge Middleware 与 Node route handler 均可用。

const ENCODER = new TextEncoder();
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 年，与 Set-Cookie Max-Age 对齐

/** encode 结果转 Uint8Array<ArrayBuffer>（BufferSource 要求 ArrayBuffer 背书，TextEncoder 返回 ArrayBufferLike） */
function encode(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(ENCODER.encode(s));
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encode(`age-verified:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function getKey(): Promise<CryptoKey | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return deriveKey(secret);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 签发 age_verified cookie 值；JWT_SECRET 缺失返回 null（调用方 fail-closed 拒绝） */
export async function signAgeVerified(): Promise<string | null> {
  const key = await getKey();
  if (!key) return null;
  const payload = String(Date.now());
  const sig = await crypto.subtle.sign("HMAC", key, encode(payload));
  return `${payload}.${toHex(new Uint8Array(sig))}`;
}

/** 校验 age_verified cookie 值：验签 + 签发时刻在有效期内，签名不符/伪造/过期均 false */
export async function verifyAgeVerified(value: string): Promise<boolean> {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const sigHex = value.slice(dot + 1);
  // 载荷必须是毫秒时间戳，签名必须是偶数长 hex——先挡格式错误，避免 fromHex 解析垃圾输入
  if (!/^\d{10,}$/.test(payload)) return false;
  if (!/^[0-9a-f]{40,}$/i.test(sigHex) || sigHex.length % 2 !== 0) return false;

  const issuedAt = Number(payload);
  const now = Date.now();
  // 过期拒绝：重放到 1 年后的旧 cookie 不得放行
  if (now - issuedAt > COOKIE_MAX_AGE_MS) return false;
  // 未来时间戳（时钟异常/攻击）也拒绝
  if (issuedAt > now + 60_000) return false;

  const key = await getKey();
  if (!key) return false;
  const sig = fromHex(sigHex);
  return crypto.subtle.verify("HMAC", key, sig, encode(payload));
}
