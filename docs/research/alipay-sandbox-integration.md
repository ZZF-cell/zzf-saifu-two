# 支付宝沙箱支付集成研究（Next.js + alipay-sdk@3.6.2）

> 调查范围：对照一手资料——`alipay-sdk@3.6.2` 的 node_modules 源码、SDK 自带 README、支付宝开放平台官方文档（opendocs.alipay.com / open.alipay.com）。opendocs 站点为客户端渲染 SPA，无法直接抓取正文，正文要点通过搜索引擎命中的官方页面原文核对。
>
> 项目中的相关现状文件：
> - `src/shared/adapters/payment.adapter.ts`：支付宝适配器，`createPayment` 目前**手工拼接 URL（未签名）**，`verifyCallback` 是 TODO（`return true`）——需要改造成走 SDK。
> - `.env.example`：已预留 `ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY / ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do`。
>
> 所有结论逐条标注来源。SDK 源码行号基于 `node_modules/alipay-sdk@3.6.2`。

---

## 0. 一句话结论

1. **pageExec**：`bizContent` 放业务参数（JSON 对象，SDK 自动 stringify），`notifyUrl/returnUrl` 放**顶层**（公共参数）；返回类型是 **string**——传 `method: 'GET'` 返回**完整支付跳转 URL**，默认 `POST` 返回**自动提交的 HTML 表单**。
2. **checkNotifySign**：支付宝异步回调是 `application/x-www-form-urlencoded` 的 POST，需先解析成**对象**再传给 `checkNotifySign(postData, raw=true)`；对象里**必须有 `sign`**（`sign_type` 可选，SDK 自动回填），验签失败/缺公钥/缺 sign 均返回 **false**。
3. **RSA2 密钥**：应用私钥/支付宝公钥都是 **PEM** 文本；SDK 默认按 **PKCS1** 解析私钥（可显式 `keyType: 'PKCS8'`）；支付宝公钥按 **SPKI "PUBLIC KEY"** 处理；沙箱网关是 `https://openapi-sandbox.dl.alipaydev.com/gateway.do`。
4. **幂等**：支付宝**会重复通知**（最多约 8 次、横跨约 24 小时、间隔递增），`out_trade_no` 唯一约束 + 订单状态机判断是标准幂等方案。
5. **本地联调**：notifyUrl 必须公网可达，ngrok / cloudflared 免费隧道可用但域名每次重启变化、回调是服务器发起的 POST（ngrok 免费版会插入拦警告页头）；Vercel 预览部署最稳，但注意 serverless 函数超时限制（回调须 5 秒内返回 `success`）。

---

## 1. `pageExec("alipay.trade.page.pay", params)` 的参数结构与返回类型

### 1.1 参数结构（直接读源码验证）

pageExec 的完整调用链：

```
pageExec(method, params)                       -> alipay.js L210-219
  -> new AliPayForm()                          -> form.js L7-12（默认 method = 'post'）
  -> 遍历 params：k==='method' 时 setMethod，其余 addField
  -> _pageExec(method, { formData })           -> alipay.js L221-251
     -> signParams = { alipaySdk: sdkVersion } -> L222
     -> camelcaseKeys(signParams)              -> L229
     -> util.sign(method, signParams, config)  -> L231  （签名 + bizContent stringify）
     -> formatUrl(gateway, signData)           -> L233  （notify_url/return_url 移入 URL）
     -> GET  => 返回 `${url}&${query}`         -> L235-240
     -> POST => 返回自动提交的 HTML 表单       -> L241-250
```

**bizContent**（业务参数，SDK 自动 `JSON.stringify(snakeCaseKeys(bizContent))`，见 `util.js L71-84`）。电脑网站支付 `alipay.trade.page.pay` 的 bizContent 必填项（官方文档 alipay.trade.page.pay 参数表 + SDK README 示例）：

| 参数 | 必填 | 说明 |
|---|---|---|
| `out_trade_no` | 是 | 商户订单号，商户端必须唯一 |
| `product_code` | 是 | 销售产品码，电脑网站支付固定 `FAST_INSTANT_TRADE_PAY` |
| `total_amount` | 是 | 订单总金额，单位**元**，保留两位小数（如 `"0.01"`） |
| `subject` | 是 | 订单标题 |
| `body` | 否 | 订单描述 |
| `timeout_express` | 否 | 绝对超时时间；如 `"90m"`。不传则支付宝取默认（默认值以官方文档为准） |

> 注意 `total_amount` 单位是**元**，而项目订单金额以**分**存储（`payment.adapter.ts` 里 `total` 单位为分），转换时要 `(total / 100).toFixed(2)`。

**notifyUrl / returnUrl 放顶层**（公共参数），**不放 bizContent**。证据链：
- `util.js L57`：`Object.assign({method, appId, charset, version, signType, timestamp}, omit(params, ['bizContent','needEncrypt']))` —— 顶层参数全部进入请求参数，`bizContent` 被排除。
- `alipay.js L97-103`：`urlArgs = ['app_id','method','format','charset','sign_type','sign','timestamp','version','notify_url','return_url','auth_token','app_auth_token',...]` —— `notify_url`/`return_url` 在格式化时被移入请求 URL（GET）或表单 action（POST）。
- SDK README L140-145：`sdk.pageExec('alipay.trade.page.pay', { method: 'POST', bizContent, returnUrl: 'https://www.taobao.com' })` —— 官方示例即顶层 `returnUrl`（camelCase）。

调用示例（对应官方文档与 README）：

```ts
const result = sdk.pageExec('alipay.trade.page.pay', {
  method: 'GET', // GET => URL；POST（默认）=> 自动提交的 HTML 表单
  bizContent: {
    out_trade_no: orderNo,
    product_code: 'FAST_INSTANT_TRADE_PAY',
    total_amount: (totalFen / 100).toFixed(2),
    subject,
    timeout_express: '90m',
  },
  notifyUrl: 'https://your-domain.com/api/payments/alipay/notify',
  returnUrl: 'https://your-domain.com/orders/success',
});
```

### 1.2 返回值类型

**返回值是 string，但形态取决于 `method` 参数**（源码 `_pageExec`，alipay.js L235-250）：

- 传 `method: 'GET'` → 返回**完整支付跳转 URL**：`${gateway}?...&biz_content=...&sign=...`。浏览器打开即可跳转支付宝收银台。
- **默认（不传 method，或传 `'POST'`）** → 返回**自动提交的 HTML 表单**（含 `<form action=...>` + `<script>document.forms[...].submit();</script>`），需要让浏览器渲染/注入这段 HTML 来触发跳转。

类型签名佐证：`alipay.d.ts L115-117`：`pageExec(method, params: IRequestParams & { method?: 'GET' | 'POST' }): string;`；README L269-281 的 API 说明："Returns: string - 请求链接或表单 HTML"，"method：如为 GET，即返回 http 链接；如为 POST，则生成表单 html"。

**注意**：pageExec 不发起任何网络请求，纯本地拼串/拼表单。因此无论哪个 method，都需要**前端/浏览器**去访问该 URL 或提交表单，才会真正发生支付跳转。

> 与现有代码的偏差：`payment.adapter.ts L47` 当前手工拼 `gateway?app_id=...&out_trade_no=...`（无签名、无 biz_content），支付宝必然验签失败。应改为 `sdk.pageExec('alipay.trade.page.pay', {...})` 并用 `ALIPAY_GATEWAY` 覆盖网关。

来源：alipay.js L210-250；form.js L7-12；util.js L49-100；alipay.d.ts L115-117；README L126-168、L269-281；官方 alipay.trade.page.pay 文档 https://opendocs.alipay.com/open/028r8t

---

## 2. `checkNotifySign(postData, raw?)` 的输入格式与失败返回值

### 2.1 支付宝异步回调的传输格式

- 异步通知（notify_url）是**支付宝服务器主动 POST** 商户地址，Content-Type 为 **`application/x-www-form-urlencoded`**（表单键值对：`trade_no=...&out_trade_no=...&trade_status=TRADE_SUCCESS&sign=...&sign_type=RSA2&...`）。
- 同步跳转（return_url）是**用户浏览器 GET** 跳转，**不参与验签、不可信**，不能用于更新订单状态；更新状态以异步通知为准。

### 2.2 checkNotifySign 期望的对象形态（读源码验证）

`checkNotifySign(postData, raw)`（alipay.js L421-450）：

```js
checkNotifySign(postData, raw) {
  const signStr = postData.sign;                                    // L422
  if (!this.config.alipayPublicKey || !signStr) return false;       // L424-426  缺支付宝公钥 或 缺 sign => false
  const signType = postData.sign_type || this.config.signType || 'RSA2';  // L428  sign_type 可选，取不到默认 RSA2
  const signArgs = Object.assign({}, postData);
  delete signArgs.sign;                                             // L431     移除 sign
  signArgs.sign_type = signType;                                    // L437     回填 sign_type
  const verifyResult = this.notifyRSACheck(signArgs, signStr, signType, raw);  // L439
  if (!verifyResult) { delete signArgs.sign_type;                   // L446-447 兼容历史：去掉 sign_type 再验一次
      return this.notifyRSACheck(signArgs, signStr, signType, raw); }
  return true;
}
```

结论：

- **输入是对象**（不是字符串），即把 form-urlencoded 解析成 `{ 字段名: 字符串值 }`。SDK README L210-216 明确："获取 queryObj，如 ctx.query, router.query；如服务器未将 queryString 转化为 object，需要手动转化"，示例对象含 `sign_type: 'RSA2', sign: '...', gmt_create: '...', other_biz_field: '...'`。
- **必须包含 `sign` 字段**，否则返回 false（L424-426）。
- **`sign_type` 可选**：缺省时用 `config.signType`（构造器默认 `'RSA2'`，alipay.js L74），SDK 内部自动回填 sign_type 参与验签，并对"含 sign_type / 不含 sign_type"两种历史情况各验一次（L437、L446-447）。
- **传入的对象必须是支付宝发来的原始字段全集**（除 sign 外全部字段），多字段、少字段、字段被改驼峰都会导致验签失败。字段名保留下划线（`out_trade_no` 不能转成 `outTradeNo`）。
- **`raw` 参数建议传 `true`**：`notifyRSACheck`（alipay.js L260-266）中，`raw=false`（默认）会对每个 value 做 `decodeURIComponent`，而异步通知是 POST 表单、值已被标准解析器 URL 解码过；若值中含 `%` 等字符会二次解码甚至抛错。SDK 源码注释："notify 消息大部分都是 post 请求，无需进行 decodeURIComponent 操作"。所以回调场景用 `checkNotifySign(postData, true)`。

### 2.3 验签失败时返回什么

**返回布尔值 `false`**（`true` = 验签通过）。失败的情形包括：未配置支付宝公钥、postData 无 `sign`、RSA 验签不通过。注意 `false` 是函数返回值，不是抛异常。

### 2.4 Next.js Route Handler 里怎么接

```ts
// app/api/payments/alipay/notify/route.ts
export async function POST(req: Request) {
  const raw = await req.text();                       // 原始 body（x-www-form-urlencoded）
  const params = Object.fromEntries(new URLSearchParams(raw)); // 解析为对象
  const ok = alipaySdk.checkNotifySign(params, true); // 验签（raw=true）
  if (!ok) return new Response('fail');               // 支付宝会重试
  // 二次核验：app_id、out_trade_no、total_amount、trade_status ∈ {TRADE_SUCCESS, TRADE_FINISHED}
  // 业务处理（幂等，见第 4 节）
  return new Response('success');                     // 纯文本 success，无空格换行
}
```

来源：alipay.js L253-270、L421-450；README L207-217、L321-328；官方异步通知文档 https://opendocs.alipay.com/open/203/107093

---

## 3. RSA2 密钥生成与沙箱配置

### 3.1 三个配置项的格式

| 配置 | 来源 | 格式 |
|---|---|---|
| `ALIPAY_APP_ID`（appId） | 开放平台 → 沙箱应用 → 应用信息 | 数字串（沙箱 APPID，官方文档说明为沙箱应用详情页展示） |
| `ALIPAY_PRIVATE_KEY`（privateKey） | 自己用官方密钥工具/OpenSSL 生成，**不上传** | PEM 私钥，2048 位 RSA2；PKCS1 或 PKCS8 |
| `ALIPAY_PUBLIC_KEY`（alipayPublicKey） | 平台"接口加签方式"上传**应用公钥**后，由平台返回 | PEM 公钥（SPKI，`-----BEGIN PUBLIC KEY-----`） |
| `ALIPAY_GATEWAY`（gateway） | 沙箱固定值 | `https://openapi-sandbox.dl.alipaydev.com/gateway.do` |

### 3.2 SDK 对密钥格式的处理（读源码验证）

**私钥 privateKey**：
- 构造器 `alipay.js L47-48`：`const privateKeyType = config.keyType === 'PKCS8' ? 'PRIVATE KEY' : 'RSA PRIVATE KEY';` —— **默认按 PKCS1 解析**（`-----BEGIN RSA PRIVATE KEY-----`），PKCS8 需显式 `keyType: 'PKCS8'`（`-----BEGIN PRIVATE KEY-----`）。
- `formatKey`（alipay.js L81-92）会剥离首尾行再按 PEM 头重包，因此传入"带 BEGIN/END 头的完整 PEM"或"裸 base64"都能被处理。
- SDK README L17（关键）："本 SDK 默认采用 PKCS1 的格式解析密钥，与密钥工具的默认生成格式不一致。请使用密钥工具【格式转换】功能转为 PKCS1，或在本 SDK 初始化时显式指定 `keyType: 'PKCS8'`。"

**支付宝公钥 alipayPublicKey**：
- 构造器 `alipay.js L65-68`：普通公钥模式下统一 `formatKey(alipayPublicKey, 'PUBLIC KEY')`，即按 **SPKI `-----BEGIN PUBLIC KEY-----`** 处理（alipay.js L63、L67）。
- 平台"支付宝公钥"即此 SPKI 格式。若误传 PKCS1 `-----BEGIN RSA PUBLIC KEY-----`，`formatKey` 会因头字符串包含 `PUBLIC KEY` 而被剥离并以 SPKI 头重包，base64 与 SPKI 不同会导致验签失败——**务必用平台返回的 SPKI 格式支付宝公钥**。
- 类型定义佐证：`alipay.d.ts L10-18`：`privateKey: string`（必填）、`alipayPublicKey?: string`（"需要对返回值做验签时候必填"）、`keyType?: 'PKCS1' | 'PKCS8'`（L31-32，默认 PKCS1）。
- 私钥缺失/为空时构造器直接抛错：`alipay.js L44-46`。

### 3.3 RSA2 密钥生成方式（官方做法）

- 使用支付宝开放平台官方**密钥工具**生成 2048 位 RSA2 密钥对，工具默认生成 PKCS8（Java 用），非 Java 语言可通过工具"格式转换"转 PKCS1，或在 SDK 初始化时 `keyType: 'PKCS8'`。
- 或用 OpenSSL：`openssl genrsa -out app_private_key.pem 2048`；PKCS8 转换 `openssl pkcs8 -topk8 -inform PEM -in app_private_key.pem -outform PEM -nocrypt -out app_private_key_pkcs8.pem`；导出公钥 `openssl rsa -in app_private_key.pem -pubout -out app_public_key.pem`。
- 三个关键值：**应用私钥**（自留、不上传、泄漏需立即更换）、**应用公钥**（上传到平台的"接口加签方式"）、**支付宝公钥**（上传后平台返回，用于验签）。

### 3.4 沙箱配置要点

- 沙箱不用创建真实应用、无需签约，开放平台控制台登录即可见"沙箱应用"。
- **网关**：沙箱 `https://openapi-sandbox.dl.alipaydev.com/gateway.do`（生产为 `https://openapi.alipay.com/gateway.do`）。SDK 构造器默认 gateway 是生产地址（alipay.js L69-77），**沙箱必须显式传 `gateway` 覆盖**。项目 `.env.example` 已配置该沙箱网关，`payment.adapter.ts L33-35` 也读取 `ALIPAY_GATEWAY`。
- 沙箱与生产的支付宝公钥**不同**，切换环境时三件套都要换。

来源：alipay.js L40-92；alipay.d.ts L10-18、L31-32；README L13-20、L27-38、L231-252；沙箱官方文档 https://opendocs.alipay.com/support/01rb2a；官方密钥工具/加签文档 https://opendocs.alipay.com/common/02kf5p、https://opendocs.alipay.com/common/02kipk

---

## 4. 幂等回调最佳实践

### 4.1 支付宝会重复通知吗？

**会。** 官方文档明确：商户未在限定时间内返回 `success`（或返回非 `success` / 响应超时 / 网络丢包）时，支付宝会**重复推送异步通知**。业界普遍引用的官方说明为：约 **24 小时 22 分钟**内发送约 **8 次**通知，间隔递增（约 4 分钟、10 分钟、10 分钟、1 小时、2 小时、6 小时、15 小时；不同时期文档数字略有出入，有的版本写"最多重试 16 次"）。收到 `success` 后停止推送。因此**回调处理天然需要幂等**。

### 4.2 `out_trade_no` 唯一约束的作用

- `out_trade_no` 是商户订单号，文档要求"商户端保证唯一"。同一笔交易每次通知都携带同一个 `out_trade_no`。
- 数据库对 `outTradeNo` 加**唯一索引**后，重复通知会导致插入重复记录/更新冲突，从而让幂等逻辑有据可依；配合订单状态机，重复通知直接命中"已处理"分支。

### 4.3 服务端幂等方案（推荐组合：唯一索引 + 状态机判断）

1. **状态机判断**（与项目已有 `src/features/orders/orders.state-machine.ts` 一致）：取订单当前状态，仅当状态为"待支付/PAID_PENDING"时才更新为"已支付/PAID_SUCCESS"并落支付流水；已处于终态则直接返回 `success` 不再处理。
2. **条件更新**：`UPDATE orders SET status='PAID' WHERE order_id=? AND status='PAID_PENDING'`，影响行数 0 表示已被处理过，避免并发重复入账。
3. **唯一约束兜底**：`UNIQUE KEY (out_trade_no)` 或对支付流水表建唯一键，重复插入直接冲突捕获。
4. **防重放**：验签（`checkNotifySign`）+ 校验 `app_id` 等于自身配置、`out_trade_no` 存在于库、`total_amount` 与订单金额一致、`trade_status` ∈ {`TRADE_SUCCESS`, `TRADE_FINISHED`}。
5. **响应规范**：处理成功后必须返回**纯文本 `success`**（7 个字符，无空格/换行/BOM/HTML），否则支付宝按失败继续重试；耗时业务（邮件、库存、消息）放异步队列，回调内 5 秒内返回。

来源：官方异步通知文档 https://opendocs.alipay.com/open/203/107093；项目订单状态机 `src/features/orders/orders.state-machine.ts`

---

## 5. 本地联调沙箱回调

### 5.1 为什么需要公网地址

`notify_url` 必须能被支付宝服务器直连：**公网可达的 HTTP(S) 地址，不能是 localhost/127.0.0.1/内网 IP**；HTTPS 证书需受信 CA 签发、域名匹配（沙箱对证书要求通常宽松，但生产严格）。`localhost` 在路由器内网，支付宝无法访问，因此本地开发要用内网穿透/公网中继把通知转发回本地。

### 5.2 方案对比

| 方案 | 优点 | 注意点 |
|---|---|---|
| **ngrok**（免费版） | 一键起隧道，`ngrok http 3000` 即得公网 HTTPS 域名 | 免费版域名每次重启**变化**（回调前要更新 notify_url）；免费版页面会插入浏览器拦截警告页头，而回调是支付宝服务器 POST、无法自己加 `ngrok-skip-browser-warning` 头，可能被拦截；有连接数/带宽限制，频繁回调会限流 |
| **cloudflared（Cloudflare Tunnel 快速隧道）** | `cloudflared tunnel --url http://localhost:3000` 即得 `https://xxx.trycloudflare.com` 临时域名，免费、无注册 | 域名也是**临时随机**的，重启即变；需重下订单（notify_url 是在下单请求里带上的）才生效；HTTPS 自动、无拦截页，比 ngrok 免费版省心 |
| **Vercel 预览部署** | 推送分支后 Vercel 自动生成公网预览 URL，域名稳定、HTTPS 完备，最接近生产 | 每次改回调代码要重新部署才生效；注意 **Vercel serverless 函数超时**（需在 5 秒内返回 `success`，否则可把耗时业务异步化）；预览域名可用于沙箱联调 |
| 云端中继（alipay-notify 等） | 支付宝先 POST 到中继 HTTPS 地址，中继通过 SSE/WebSocket 把原始报文推给本地 CLI | 第三方服务，需自行评估安全 |

### 5.3 注意点汇总

- `notify_url` 在**下单请求参数**里传（`pageExec` 顶层 `notifyUrl`），不是改开放平台控制台；改隧道域名后要**重新创建订单**再测。
- 回调必须 5 秒内返回 `success`；沙箱通知可能有 1~3 秒延迟，收不到先等一会儿再排查。
- 强烈建议在回调接口记录**原始请求体**日志，配合隧道工具转发排查"收不到/验签失败"。
- 沙箱环境里 `return_url`（用户浏览器 GET 跳转）只做前端展示，**不要**依赖它更新订单状态。
- 防火墙/安全组/WAF 不要拦支付宝的 POST（官方说明异步通知不保证固定源 IP，无可靠 IP 白名单）。

来源：官方异步通知文档 https://opendocs.alipay.com/open/203/107093；ngrok 官方文档 https://ngrok.com/docs；Cloudflare Tunnel 文档 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/；Vercel 文档 https://vercel.com/docs

---

## 附：引用的 SDK 源码文件与关键行号

| 文件 | 位置 | 内容 |
|---|---|---|
| `node_modules/alipay-sdk/lib/alipay.js` | L40-92 | 构造器、keyType/formatKey、默认 gateway/signType |
| `node_modules/alipay-sdk/lib/alipay.js` | L94-113 | formatUrl：notify_url/return_url 移入 URL |
| `node_modules/alipay-sdk/lib/alipay.js` | L210-219 | pageExec |
| `node_modules/alipay-sdk/lib/alipay.js` | L221-251 | _pageExec：GET 返 URL、POST 返表单 |
| `node_modules/alipay-sdk/lib/alipay.js` | L253-270 | notifyRSACheck（raw 分支） |
| `node_modules/alipay-sdk/lib/alipay.js` | L421-450 | checkNotifySign |
| `node_modules/alipay-sdk/lib/util.js` | L49-100 | sign：bizContent stringify、顶层参数 |
| `node_modules/alipay-sdk/lib/form.js` | L7-12 | 默认 method='post' |
| `node_modules/alipay-sdk/lib/alipay.d.ts` | L10-18、L31-32、L115-117 | AlipaySdkConfig / pageExec 签名 |
| `node_modules/alipay-sdk/README.md` | L13-20、L27-38、L89-98、L126-168、L207-217、L231-252、L269-281 | 官方使用示例与 API 表 |

## 附：主要官方文档链接

- 电脑网站支付 alipay.trade.page.pay：https://opendocs.alipay.com/open/028r8t
- 异步通知机制（验签/返回 success/重试/幂等）：https://opendocs.alipay.com/open/203/107093
- 沙箱环境（网关/APPID/密钥）：https://opendocs.alipay.com/support/01rb2a
- 接口加签方式：https://opendocs.alipay.com/common/02kf5p
- 开放平台密钥工具：https://opendocs.alipay.com/common/02kipk
- SDK 仓库：https://github.com/ali-sdk/alipay-sdk
