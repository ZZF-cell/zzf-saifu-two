// 赛夫严选 PWA Service Worker — 运行时缓存
//
// 策略（README「PWA 缓存策略」的实现）：
//   /api/*               → Network Only（绝不入缓存：鉴权/交易数据必须新鲜）
//   /_next/static + icons + manifest → Stale-While-Revalidate
//                            （文件名带内容哈希，SWR 安全且省流量）
//   /build-id.json       → Network First（构建版本校验需要最新值）
//   HTML 导航            → Network First + 离线回退（断网时最近访问页可用）
//
// 安全护栏：
//   - 只缓存 200 响应，绝不缓存带 Set-Cookie 的响应（防离线回放鉴权 Cookie）
//   - 只处理同源 GET；其余走浏览器默认（不劫持）
//
// 升级：activate 清理旧缓存名（CACHE_NAME 随版本递增），skipWaiting 立即接管。

const CACHE_NAME = "saife-runtime-v1";
const SWR_ROOTS = ["/_next/static/", "/icons/", "/manifest.webmanifest"];

self.addEventListener("install", () => {
  // 新 SW 立即接管，不等旧页面全部关闭
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // 1) API 永不缓存
  if (path.startsWith("/api/")) return;

  // 2) 构建版本校验 — Network First
  if (path === "/build-id.json") {
    event.respondWith(networkFirst(req));
    return;
  }

  // 3) 静态资源 — Stale-While-Revalidate
  if (SWR_ROOTS.some((root) => path.startsWith(root))) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 4) HTML 导航 — Network First + 离线回退
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res.ok && !res.headers.has("set-cookie")) {
        cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => undefined);
  return cached || (await networkPromise);
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  // 导航请求带 mode=navigate，Cache API 不接受该 mode 作为 key → 用纯 URL 重建
  const cacheKey = req.mode === "navigate" ? new Request(req.url) : req;
  try {
    const res = await fetch(req);
    if (res.ok && !res.headers.has("set-cookie")) {
      await cache.put(cacheKey, res.clone());
    }
    return res;
  } catch {
    const cached = await cache.match(cacheKey);
    return cached || Response.error();
  }
}
