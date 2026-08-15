# 赛夫严选

成人用品品牌聚合严选电商平台。隐私配送，正品保障。

> **法律合规声明**：本平台仅面向年满 18 周岁的成年人。所有用户首次访问时必须通过年龄验证门禁。平台严格遵守《个人信息保护法》，用户手机号仅存储哈希值、配送信息采用 AES-256-GCM 加密、订单支持一键不可逆销毁。我们不会以任何形式向第三方泄露用户隐私数据。详见下方「隐私与安全」章节的技术实现。

## 架构理念

| 支柱 | 模式 | 说明 |
|------|------|------|
| 骨架 | **模块化单体** | 按业务领域组织代码，模块间通过 Public API 通信，`eslint-plugin-boundaries` 强制边界 |
| 大脑 | **事务脚本 + 领域服务** | Prisma `$transaction` 保证 ACID，纯函数状态机保证规则可测试 |
| 神经系统 | **Inngest 异步事件** | 强一致性路径走同步事务，弱一致性路径投递 Inngest |
| 血液循环 | **CQS 逻辑分离** | `service.ts` 负责写，`queries.ts` 负责读，物理层同库（Neon PostgreSQL）|

## 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 框架 | Next.js 15 (App Router) | 精确版本锁定，保留 Webpack 回退 |
| 数据库 | PostgreSQL (Neon) | 开发/生产统一，本地 Docker 运行 |
| ORM | Prisma (PostgreSQL provider) | 交互式事务 `$transaction`，Service 层直调 |
| 认证 | JWT 双 Token (jose) | Access 15min + Refresh 7d Rotation，Refresh Token 存 DB |
| 校验 | Zod | `withValidation` HOF + Server Actions 用 `next-safe-action` |
| 异步 | Inngest | 订单支付超时自动取消 |
| 支付 | 支付宝沙箱 | `outTradeNo` 唯一索引 + `updateMany` 保证幂等 |
| UI | shadcn/ui + Tailwind CSS v4 | `shared/ui/` 只读，业务组件在 `features/*/` 内；`Image.tsx` / `SiteHeader.tsx` 为自定义组件（登录态感知全局导航） |
| PWA | Service Worker + Web App Manifest | API 路由 Network Only，静态资源 SWR，构建版本校验 |
| 测试 | Playwright (E2E) + Vitest (单元) | CI 双构建流水线（Turbopack + Webpack） |
| 错误追踪 | Sentry (`@sentry/nextjs`) | 全局 `AppError` + `apiError` 包装器 |
| 部署 | Vercel | 配合 Neon 边缘集成 |
| 模块边界 | `eslint-plugin-boundaries` | 模块间只能通过 `index.ts` Public API 通信 |

## 快速开始

### 前置条件

- Node.js 20+
- Docker（本地 PostgreSQL）
- Neon 账号（生产数据库）

### 启动

```bash
cp .env.example .env              # 配置环境变量
docker compose up -d              # 启动本地 PostgreSQL
npm install                       # 安装依赖
npx prisma db push                # 创建数据库表
npx prisma generate               # 生成 Prisma Client
npx prisma db seed                # 创建种子数据
npm run dev                       # 启动开发服务器 → http://localhost:3000
```

## 测试账号

| 角色 | 手机号 | 密码 | 权限 |
|------|--------|------|------|
| 管理员 | 13900000000 | — | 管理后台全部功能（品牌审核/商品质检/订单管理/用户管理/质检模板/邀请码管理/数据看板） |
| 普通用户 | 13800138000 | 123456 | 浏览商品、购物车、下单、支付、退款、销毁订单 |
| 品牌方 | 13888888888 | — | 品牌后台（提交商品/查看订单/品牌资料/数据看板） |

> **获取验证码：** 短信模块尚未接入真实 SDK，当前为**演示模式回显** —— 未配置短信时，`POST /api/auth/send-code` 响应携带 `demoCode`，登录/注册表单页面直接提示显示验证码（配好真实短信后自动停止回显）。本地另可从 `grep "\[SMS\]" .next/dev/logs/next-development.log` 查看终端日志回退

## 本地开发工作流

### 日常命令

```bash
npm run dev                       # 启动 Next.js 开发服务器
npm run inngest:dev               # 启动 Inngest 本地调试面板（http://localhost:8288）
npx prisma studio                 # 可视化浏览/编辑数据库（http://localhost:5555）
npx vitest                        # 运行单元测试（watch 模式）
npx playwright test --ui          # Playwright 交互式调试
```

> **Inngest 本地调试**：`npm run inngest:dev` 对应 `inngest-cli dev --env-file .env.local`，显式加载 `.env.local` 环境变量。Inngest CLI **不会**自动注入 Next.js 的环境文件，使用裸 `npx inngest-cli dev` 将导致 `DATABASE_URL` 等变量缺失。Inngest Dev Server 需在**另一个终端**运行，它会自动读取 `./inngest/` 目录下的函数定义，提供可视化的执行日志和重放功能。

### 数据库重置

```bash
npx prisma db push --force-reset   # 清空所有数据并重建表结构
npx prisma db seed                 # 重新填充种子数据
```

### Mock 数据策略

- **开发环境**：使用 `prisma/seed.ts` 生成的种子数据（含三个角色测试账号 + 示例商品 + 种子邀请码 `INVITE-BRAND-101/102` + **8 笔覆盖全部状态的演示订单** + **5 个大类质检模板**，可直接用于入驻演示与后台验收）
- **短信 Mock**：未配置阿里云短信时，验证码输出到终端日志（`grep "\[SMS\]"` 获取）
- **支付 Mock**：使用支付宝沙箱环境，测试用买家账号付款不会产生真实资金流转
- **Inngest 本地**：`npx inngest-cli dev` 提供完整的本地函数执行环境，无需连接 Inngest Cloud

### 推荐 IDE 插件

| 插件 | 用途 | 配置说明 |
|------|------|---------|
| ESLint | 模块边界 + 代码规范检查 | 项目已配置 `eslint-plugin-boundaries` |
| Prisma | `.prisma` 文件语法高亮 + 自动补全 | 自动识别 `prisma/schema.prisma` |
| Tailwind CSS IntelliSense | Tailwind 类名补全 + 预览 | 开箱即用 |
| Playwright | E2E 测试运行 + 录制 | `.vscode/launch.json` 中配置 Playwright runner |
| Error Lens | 行内显示 ESLint/TS 错误 | 提升 DX |

### Windows 开机自启（仅限本地演示环境）

- 将 `start.vbs` 复制到 `shell:startup` 启动文件夹
- 重启后自动后台启动服务
- **注意**：此方式仅适用于个人电脑上的本地演示，生产环境请使用 Vercel 部署

## 功能全景

### MVP（一期）

| 模块 | 功能 |
|------|------|
| **用户认证** | 短信验证码登录/注册、密码登录/注册、JWT 双 Token 鉴权、角色分级 |
| **用户商城** | 商品浏览/搜索/两级类目筛选/价格排序、商品详情 |
| **购物车** | 添加/修改/删除（服务端同步） |
| **订单系统** | 创建订单（乐观锁防超卖）、支付查询、取消订单、申请退款、一键销毁 |
| **隐私保护** | 年龄确认门禁、匿名包装、订单销毁、AES-256-GCM 加密、手机号哈希 |
| **移动端** | 底部导航栏、PWA 可安装到桌面、安全区域适配 |

### 二期

| 模块 | 状态 | 功能 | 技术实现 |
|------|------|------|---------|
| **管理后台** | ✅ 已完成 | 数据看板（统计卡可跳转 + 近 7 天销售/状态分布/品类分布图表；**商品数=在售口径仅 APPROVED**，下架/拒绝/撤回不计入，已下架独立卡片）、品牌审核（待审/已拒绝状态筛选，可重审通过或删除）、商品质检（详情含品类质检清单 + 已提交证书「已交/缺」对照）、订单管理（发货/送达/完成/退款，行展示买家/收货人脱敏/件数）、用户管理（改角色/禁用启用/解锁/重置密码/清除年龄验证）、质检模板增删改 | `features/admin/`；所有状态变更用 `updateMany` 状态守卫（防并发重复操作），与审计日志在同一 `$transaction`（审计失败整体回滚，不留「状态已变但无审计」的账）；重复审核返回 409 区分「不存在」404；用户管理禁止操作自己（403）；看板品类商品数分布图与「在售商品」卡同口径（仅 APPROVED），图卡不矛盾 |
| **品牌方后台** | ✅ 已完成 | 品牌概览、提交新商品（随附检测证书）、商品列表、订单查看、品牌资料 | `features/brand/`；品牌订单/销售额只聚合本品牌商品行（`OrderItem.price` 行总额之和，**price 已含 ×qty 不可再乘**），混合品牌订单不整单全额重复计入；品牌无商品时直接返回零统计，绝不查询全平台数据（防跨租户泄漏）；提交/编辑商品按品类 `CategoryAuditTemplate.requiredDocs` 展示必交材料清单，可上传证书（图片/PDF）随商品提交 |
| **订单超时自动取消** | ✅ 已完成 | 下单 30 分钟未支付自动取消并回补库存 | `inngest/functions/order-timeout-cancel.ts`：`order/created` 事件 → `step.sleep(30min)` → `cancelExpiredOrder`（**updateMany 状态守卫先于回补库存**，防并发双重回补）；下单时用 `next/server` 的 `after()` 保证 serverless 中事件投递完成 |
| **品牌入驻** | ✅ 已完成 | 管理员生成邀请码 → 品牌方激活 → 提交资料 → 审核 | `features/invite/`：激活=单事务原子消耗邀请码（`updateMany` 状态守卫含过期判断）+ 创建 PENDING 品牌；管理员审核通过时同事务将负责人升级为 BRAND 角色（品牌已过但角色未升是笔错账）；邀请码列表 EXPIRED 由 `expiresAt` 即时推导不落库。**REJECTED 非死胡同**：品牌审核状态筛选含「已拒绝」，管理员可**重审通过**（改判错杀，`reviewBrand` 守卫放行 `PENDING`/`REJECTED` 的 APPROVED，但 REJECTED 不可再拒 409）或**删除品牌**（`DELETE /api/admin/brands/[id]`，仅 REJECTED 可删，其余状态 409 `BRAND_NOT_DELETABLE`）；删除后商家可用新邀请码重新入驻 |
| **OSS 图片上传** | ✅ 已完成 | 商品/品牌图片 + 检测证书上传至阿里云 OSS（后端中转） | `features/upload/`：POST `/api/upload`（multipart + MIME 白名单，`purpose` 枚举 `product`/`brand`/`cert`；图片 ≤4MB、证书 PDF ≤10MB；未配置 OSS 返回 503）。`purpose=product`/`brand` 只收图片，`purpose=cert` 收图片 + PDF；`shared/adapters/oss.adapter.ts` 仿 payment 懒初始化 + 纯函数；`shared/ui/Image` 双源（OSS URL + base64）+ 统一占位图。Vercel 请求体上限 4.5MB → 图片限 ≤4MB；更大文件走 OSS 预签名直传（三期） |
| **商品两级类目** | ✅ 已完成 | 大类+子类两级选择与筛选 | `shared/constants/product-categories.ts` 预设清单为唯一来源（改常量即可调整）；Product 增加 `subCategory` 字段（可空兼容旧数据）；品牌提交商品改为大类→子类级联下拉；首页两级筛选；详情/品牌后台/管理后台展示「大类/子类」 |
| **商品生命周期** | ✅ 已完成 | 撤回待审 / 下架 / 重新上架 / 编辑（双方同状态机）+ 管理员完整审核详情 | `features/brand` 与 `features/admin` 同一套状态机（status 为 String 无需迁移）：`PENDING`→`WITHDRAWN`（品牌撤回）；`APPROVED`⇄`DELISTED`（品牌/管理员可做，重新上架不重质检）；编辑商品「基本信息变更→回 `PENDING` 重审、仅改运营信息（价格/库存）→直改」。**检测证书（`certificates`）属基本信息，仅改证书也会触发重审**。所有变更用 `updateMany` 状态守卫（含品牌侧 `brandId` 归属守卫，越权 403）+ `version:{increment:1}` + AuditLog（snapshot 存 before/after）；守卫 0 行二次 `findUnique` 区分 404/403/409。公开商品详情仅放行 `APPROVED`（DB 层过滤，下架/待审深链 404）。管理端 `GET /api/admin/products/[id]` 返回完整信息 + 品类质检清单 + 已提交证书，审核决策信息闭环 |
| **微信支付** | ⏳ 待开发 | 接入微信支付 SDK | `shared/adapters/payment.adapter.ts` 定义 `PaymentAdapter` 接口，微信支付实现同一接口；回调幂等逻辑直接复用 `payment.callback.ts` 的 `updateMany` 模式 |
| **实名认证** | ⏳ 待开发 | 对接实名认证服务 | 新增 `shared/adapters/realname.adapter.ts`；用户表增加 `realNameVerified` 字段，不影响现有登录流程 |

> **技术债预警原则**：每个二期功能的 `features/` 模块是独立的，不跨模块修改，只通过现有 Public API 或新增 Adapter 扩展。如果某个功能需要修改现有模块的内部实现，说明边界设计需要调整。

> **迁移提醒（品牌入驻）**：本版本新增 `InviteCode` 表，迁移 SQL 已提交（`prisma/migrations/20260812155959_add_invite_code_model/`）。已有数据库（含 Neon 生产库）部署前需执行 `npx prisma migrate dev` 应用迁移；全新数据库可直接 `npx prisma db push` 建表后 `npx prisma db seed` 获得种子邀请码。

## 目录结构

```
src/
├── middleware.ts                    # Edge Middleware（年龄验证门禁 + 路由权限守卫）
├── features/                        # 业务模块（按领域划分，index.ts 为唯一 Public API）
│   ├── auth/                        # 认证模块
│   │   ├── index.ts
│   │   ├── auth.routes.tsx          #   登录/注册页面（支持 ?redirect= 回跳）
│   │   ├── auth.api.ts              #   Route Handlers
│   │   ├── auth.service.ts         #   双 Token 签发/验证/Refresh Rotation + 爆破防护 + 短信接线
│   │   ├── auth.queries.ts         #   验证码/用户查询
│   │   └── auth.components.tsx     #   登录表单、验证码输入框
│   │
│   ├── products/                    # 商品模块
│   │   ├── index.ts
│   │   ├── products.routes.tsx      #   首页/商品详情/搜索
│   │   ├── products.api.ts
│   │   ├── products.service.ts     #   查询/搜索/分页
│   │   └── products.components.tsx #   商品卡片、筛选器
│   │
│   ├── cart/                        # 购物车模块
│   │   ├── index.ts
│   │   ├── cart.routes.tsx
│   │   ├── cart.api.ts
│   │   ├── cart.service.ts
│   │   └── cart.components.tsx
│   │
│   ├── orders/                      # 订单模块（核心）
│   │   ├── index.ts
│   │   ├── orders.routes.tsx
│   │   ├── orders.api.ts
│   │   ├── orders.service.ts       #   领域服务（$transaction 业务流程 + 优惠分摊 + cancelExpiredOrder）
│   │   ├── orders.queries.ts       #   订单列表/详情查询
│   │   ├── orders.state-machine.ts #   纯函数状态流转规则
│   │   ├── order-events.ts         #   订单事件发布（order/created → Inngest，调用方用 after() 包裹）
│   │   └── orders.components.tsx
│   │
│   ├── payment/                     # 支付模块
│   │   ├── index.ts
│   │   ├── payment.api.ts
│   │   ├── payment.service.ts      #   支付宝对接 + 幂等校验
│   │   └── payment.callback.ts     #   回调签名校验
│   │
│   ├── user/                        # 用户模块
│   │   ├── index.ts
│   │   ├── user.api.ts              #   GET/PATCH /api/user/profile
│   │   ├── user.service.ts          #   修改昵称
│   │   └── user.queries.ts          #   个人信息 + 订单统计
│   │
│   ├── admin/                       # 管理后台模块
│   │   ├── index.ts
│   │   ├── admin.api.ts             #   品牌审核/商品质检/订单管理/用户管理/看板/质检模板
│   │   ├── admin.service.ts        #   状态变更（updateMany 守卫 + 审计同事务）+ 用户操作（角色/禁用/解锁/重置密码）
│   │   └── admin.queries.ts        #   后台查询 + 看板统计（7 天销售/状态分布/品类分布）
│   │
│   ├── brand/                       # 品牌方后台模块
│   │   ├── index.ts
│   │   ├── brand.api.ts             #   概览/提交商品/商品列表/质检模板/订单
│   │   ├── brand.service.ts        #   提交商品（价格转分存储 + 证书透传/重审判定）
│   │   ├── brand.queries.ts        #   品牌概览（跨租户防泄漏）+ 归属校验 + 品类质检模板
│   │   └── brand.routes.tsx        #   品牌后台页面
│   │
│   ├── invite/                      # 品牌入驻激活模块
│   │   ├── index.ts
│   │   ├── invite.routes.tsx        #   入驻激活页（/invite：邀请码+品牌资料）
│   │   ├── invite.api.ts            #   POST /api/invite/activate
│   │   └── invite.service.ts        #   原子消耗邀请码 + 创建 PENDING 品牌
│   │
│   ├── upload/                      # 上传模块（商品/品牌图片 + 检测证书）
│   │   ├── index.ts
│   │   ├── upload.api.ts            #   POST /api/upload（multipart，任意登录用户；purpose=product/brand/cert）
│   │   └── upload.service.ts        #   文件 → OSS → URL（未配置抛 503）
│   │
│   └── audit/                       # 审计模块（AuditLog 表访问，后台操作同事务写日志）
│
├── shared/                          # 共享基础设施（所有模块可引用，禁引用 feature 内部文件）
│   ├── api/
│   │   ├── auth.ts                  #   服务端 authenticate（各模块 API 层复用）
│   │   └── client.ts                #   前端 apiFetch（401 自动刷新 Access Token）
│   ├── auth/
│   │   └── middleware.ts           #   getAuthUser + 路由权限
│   ├── db/
│   │   └── client.ts               #   Prisma Client 单例
│   ├── errors/
│   │   └── errors.ts               #   AppError 类 + 错误码枚举
│   ├── constants/
│   │   ├── product-categories.ts   #   商品两级类目（平台预设，唯一来源）
│   │   └── upload.ts               #   上传预检常量（MIME 白名单 / 图片≤4MB / 证书 PDF≤10MB / 图片·证书上限）
│   ├── utils/
│   │   ├── crypto.ts               #   AES-256-GCM + scrypt 密码哈希 + 手机号哈希
│   │   ├── money.ts                #   金额处理（整数分，避免浮点精度）
│   │   ├── format.ts               #   展示格式化
│   │   ├── api.ts                  #   withValidation HOF + apiError 包装器
│   │   └── api-errors.ts           #   客户端解析 422 details（firstFieldError）
│   ├── validation/
│   │   └── schemas.ts              #   Zod schemas（全局共享）
│   ├── adapters/
│   │   ├── sms.adapter.ts          #   阿里云短信（未配置回退日志）
│   │   ├── payment.adapter.ts      #   支付宝沙箱封装
│   │   └── oss.adapter.ts          #   阿里云 OSS（懒初始化，未配置返回失败标记）
│   └── ui/                         #   自定义 UI（非 shadcn 源，可改）
│       ├── Image.tsx               #   双源图片（OSS URL + base64）+ 统一占位图
│       ├── image-source.ts         #   resolveImageSource 纯函数
│       └── SiteHeader.tsx          #   登录态感知全局导航（按角色显示购物车/入驻/后台）
│
├── app/                             # Next.js App Router 入口
│   ├── layout.tsx                   #   根布局（PWA Manifest）
│   ├── manifest.ts                  #   Web App Manifest（图标 public/icons/）
│   ├── page.tsx                     #   首页 = 商品列表
│   ├── age-gate/                    #   年龄验证门禁（拒绝 → 硬性阻止页）
│   ├── (auth)/                      #   登录/注册
│   ├── admin/ brand/ cart/ checkout/ orders/ products/
│   └── api/                         #   Route Handlers（薄转发层，逻辑在 features/）
│       ├── auth/ ... orders/ cart/ user/ products/ pay/ admin/ brand/ inngest/
│       └── user/profile/            #   个人信息路由（GET/PATCH）
│
└── inngest/
    ├── client.ts                    #   Inngest 客户端单例（eventKey）
    ├── index.ts                     #   函数注册中心（serve 端点 + Dev Server 自动发现）
    └── functions/
        └── order-timeout-cancel.ts  #   订单支付超时自动取消（order/created → sleep 30min → 取消+回补库存）
```

## 模块通信规则

```
✅ 允许                              ❌ 禁止
features/orders/                   features/orders/
  → features/payment/index.ts        → features/payment/payment.service.ts  (绕过 Public API)
  → shared/errors/errors.ts          → features/cart/cart.service.ts         (跨模块直接调用)
  → shared/db/client.ts              → ../../prisma/schema.prisma            (跨模块直接访问数据表)
```

> 以上规则由 `eslint-plugin-boundaries` 在 ESLint 阶段强制检查。

## 数据模型

| 模型 | 关键字段 | 说明 | Trade-off 备注 |
|------|---------|------|---------------|
| User | phoneHash, passwordHash, role, **status**, ageVerified, **failedLoginAttempts, lockUntil** | 用户（角色: USER/BRAND/ADMIN）| 手机号不存明文，仅存 `pepper + SHA-256` 哈希；密码存 **scrypt 慢哈希**（格式 `scrypt.salt.hash`，旧 SHA-256 兼容并在登录成功时自动升级）；`failedLoginAttempts`/`lockUntil` 实现密码爆破防护（连续失败 ≥5 次锁定 15 分钟）；`status`（`ACTIVE`/`DISABLED`）供管理员禁用/启用，**禁用用户登录直接 403**，不逐请求查库（access token 15min 内仍有效，可接受）；角色用枚举约束避免权限越界 |
| RefreshToken | userId, tokenHash, expiresAt | JWT Refresh Token Rotation | 存 SHA-256 Hash 而非原文——即使 DB 泄露也无法伪造 Token；定时清理过期记录 |
| VerificationCode | phoneHash, code, expiresAt, **attempts** | 短信验证码（手机号哈希关联）| 不存明文手机号（同 User.phoneHash 规则）；`attempts` 验证码错误尝试计数，≥5 次删除记录（防爆破）；索引 `(phoneHash, createdAt)` 支持滑动窗口查询 |
| Brand | name, status, inviteCode, ownerId | 品牌（归属用户 + 邀请码）| ownerId 指向 User，一个用户只能拥有一个品牌，防止品牌方多账号绕审核 |
| InviteCode | code(unique), status, createdBy, usedBy, expiresAt | 品牌入驻邀请码 | `code` 为自然键（大写，剔除 0/O/1/I 混淆字符）；`EXPIRED` 为推导态（UNUSED + 过期）不落库，读取时即时推导；消耗用 `updateMany` 状态守卫（含过期判断）防并发重复激活；激活侧对无效码一律返回 400，防枚举探测码存在性 |
| Product | brandId, category, **subCategory**, status, images, **certificates**, specs, **version, stock** | 商品（两级类目 + version 乐观锁防超卖 + 生命周期状态 + 检测证书）| `version` 字段配合 `updateMany` 实现乐观锁；specs 用 JSONB 存储灵活扩展；`subCategory` 可空（兼容旧数据），新提交商品必填且需与大类组合合法（`isValidCategoryPair`）；`certificates`（JSON 数组 `[{url, name, mime}]`）随商品提交的检测证书（图片/PDF），schema 层校验 OSS host + MIME 白名单；**status** 为 String 枚举：`PENDING`（待质检）→ `APPROVED`（已上架）/ `REJECTED`（已拒绝）；品牌可 `WITHDRAWN`（撤回待审）；双方可 `DELISTED`（下架）→ `APPROVED`（重新上架，不重质检）。改基本信息/证书→回 `PENDING` 重审，仅改价格/库存→直改不重审。所有状态变更均 `version:{increment:1}` + AuditLog 留痕 |
| CartItem | userId, productId, productName, price, qty | 购物车（唯一约束 userId+productId）| ⚠️ **资损关键点**：`productName` 和 `price` 为展示冗余，**下单时对最新价格进行实时校验并快照到 OrderItem**，不依赖于购物车缓存。商品调价后购物车中的旧价格仅作参考 |
| Order | userId, total, status, privacy, shippingAddress, **outTradeNo** | 订单（outTradeNo 支付回调幂等）| `total` 为下单时快照的快照总价，不可后续修改；发货地址单独加密存储 |
| OrderItem | orderId, productName, price, qty | 订单行项目 | **下单时从 Product 表快照**，不引用外键。商品下架或调价不影响历史订单的可追溯性。⚠️ **`price` 为行总额 = 实付分摊单价 × qty**（已含优惠券/满减按比例分摊），**退款金额 = `price` 行总额**，消费端/品牌侧/看板聚合均**不得再乘 qty**。优惠分摊逻辑在 `orders.service.ts` 的 `calculateOrderItems` 中实现，单元测试覆盖边界 case（全部退款、部分退款、跨优惠门槛退款） |
| CategoryAuditTemplate | categoryId, requiredDocs, checkPoints | 品类质检模板 | checkPoints 用 JSONB 数组存储，支持不同品类差异化质检项 |
| AuditLog | targetType, targetId, action, snapshot | 操作审计日志 | snapshot 为操作前数据快照（JSONB），用于回溯和合规审计 |

> **商品类目树（两级）**：类目为平台预设清单，代码常量 `src/shared/constants/product-categories.ts` 为唯一来源（C 端筛选 / 品牌提交下拉 / 后端校验均引用，调整类目只需改该常量）。当前清单：**成人计生用品**（避孕套、润滑液）、**情趣用品**（震动器具、男用器具、女用器具、情趣内衣、情趣玩具套装）、**智能设备**（智能健康监测、智能情趣设备）、**身体护理**（身体乳/润体、私密护理）、**其他**（其他）。`CategoryAuditTemplate.categoryId` 仍为自由文本键，未与类目树绑定。

### 核心安全机制

**防超卖（乐观锁）**：
```typescript
const [stockResult] = await prisma.$transaction([
  prisma.product.updateMany({
    where: { id: productId, stock: { gte: qty }, version: currentVersion },
    data: { stock: { decrement: qty }, version: { increment: 1 } },
  }),
  prisma.order.create({ data: { ... } }),
]);
// stockResult.count === 0 → 库存不足或并发冲突
```

**支付回调幂等性**：
```typescript
const result = await prisma.order.updateMany({
  where: { id, status: 'PENDING' },
  data: { status: 'PAID', outTradeNo, paidAt: new Date() },
});
// result.count === 0 → 已处理（幂等），检查是否异常状态
```

### 密钥管理生命周期

**ENCRYPTION_KEYS 格式**：`v{N}:{key}`，多个密钥逗号分隔，如 `v2:a1b2...,v1:oldkey`。前缀 `v1` 标识密钥版本，最左 `v2` 为当前加密密钥。

| 操作 | 方法 | 说明 |
|------|------|------|
| 加密新数据 | 始终使用最新版本密钥 | `encrypt(plaintext, latestKey)` |
| 解密旧数据 | 根据密文中存储的版本前缀选择对应密钥 | `decrypt(ciphertext, keys[ciphertext.prefix])` |
| 密钥轮换 | 生成新版本密钥 (`v2:...`)，追加到 `ENCRYPTION_KEYS` 环境变量（逗号分隔） | 旧密钥保留不解密，新密钥用于加密 |
| 历史数据迁移 | 后台 Job 逐步用新密钥重加密旧数据（可选，非紧急） | 读取时自动匹配版本 → 写入时用最新版本覆盖 |

> **原则**：解密时永远向后兼容（支持所有历史版本），加密时永远用最新版本。密钥泄漏时，立即轮换并标记旧版本为"泄漏"，通知受影响用户。

## JWT 双 Token 机制

| Token | TTL | 存储 | Cookie |
|-------|-----|------|--------|
| Access Token (JWT) | 15 分钟 | 不存 DB | `httpOnly Secure SameSite=Strict` |
| Refresh Token (随机 32B) | 7 天 | DB 存 SHA-256 Hash | `httpOnly Secure SameSite=Strict Path=/api/auth` |

- **Refresh**：Access 过期 → `POST /api/auth/refresh` → 验证 Refresh Hash → **检查 `User.status`（禁用即吊销全部 Refresh Token + 403 USER_DISABLED）** → 签发新 Access + 新 Refresh（Rotation）→ 旧 Refresh 删除
- **Logout**：删除 DB RefreshToken → 清除 Cookies → Access 15 分钟后自然失效
- **禁用/重置密码会话吊销**：管理端禁用用户或重置密码时，同事务删除该用户全部 Refresh Token——已登录会话在 Access 15 分钟 TTL 内失效，之后无法续期（Access 为无状态 JWT，不逐请求查库，短 TTL 即吊销窗口）

## 订单状态流转

```
PENDING ──→ PAID ──→ SHIPPED ──→ DELIVERED ──→ COMPLETED
   │
   └──→ CANCELLED（仅 PENDING 可取消；已发货/完成/退款的订单不可直接取消，
                   实物已出库需走退款/售后流程）

REFUND_REQUESTED ←── PAID（用户申请退款）
   │
   └──→ REFUNDED（管理员同意退款）
```

> **超时自动取消**：下单 30 分钟（`ORDER_PAYMENT_TIMEOUT_MS`）未支付，由 Inngest `order-timeout-cancel` 自动将 PENDING 订单置为 CANCELLED 并回补库存（`updateMany` 状态守卫先于回补，防与手动取消/支付回调并发冲突）。

> **销毁（destroy）不改变 status**，而是写入 `destroyedAt` 列（非空 = 已销毁）：用户/品牌侧查询层按 `destroyedAt IS NULL` 过滤，销毁后订单在用户与品牌方列表中消失、详情返回 404（视为不存在）；平台管理后台保留全部数据（仍读 `privacy.destroyed` 显示「已销毁」标记）供审计与退款核验。故不在状态图中。

## 同步 vs 异步策略

| 场景 | 实现 | 原因 |
|------|------|------|
| 下单（扣库存+建订单） | Prisma `$transaction` 同步 | 强一致性，必须同时成功或同时回滚 |
| 支付回调（状态更新） | Prisma `$transaction` 同步 | 幂等性需和状态更新在同一事务 |
| 后台状态变更 + 审计日志 | Prisma `$transaction` 同步 | 审计与状态变更必须同生共死——审计失败则整体回滚，杜绝「状态已变但无审计留痕」 |
| 发送短信 | `shared/adapters/sms.adapter.ts` 同步 | 认证流程强依赖验证码送达，失败直接报错；未配置短信服务时回退终端日志（`[SMS]`） |
| 订单超时取消 | Inngest `order/created` → `step.sleep(30min)` → 取消+回补库存 | 无需自建定时任务；下单时用 `next/server` 的 `after()` 保证 serverless 中事件投递完成 |
| 通知品牌方（下单/新商品） | ⏳ 待开发 | 预留 Inngest `notify-brand` |

## API 路由

### 认证
| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/auth/send-code` | 发送短信验证码 |
| POST | `/api/auth/verify-code` | 验证码登录（新用户自动注册） |
| POST | `/api/auth/login` | 密码登录 |
| POST | `/api/auth/register` | 密码注册 |
| POST | `/api/auth/set-password` | 短信登录后设置密码 |
| GET | `/api/auth/me` | 当前登录用户信息（登录态导航/前端状态；安全字段，不含 phoneHash） |
| POST | `/api/auth/refresh` | 刷新 Access Token（Rotation） |
| POST | `/api/auth/logout` | 退出登录（吊销 Refresh Token） |

### 订单
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/orders` | 我的订单列表 |
| POST | `/api/orders` | 创建订单（乐观锁防超卖） |
| GET | `/api/orders/[id]` | 订单详情 |
| POST | `/api/orders/[id]/check-paid` | 查询支付状态 |
| POST | `/api/orders/[id]/cancel` | 取消订单（仅 PENDING） |
| POST | `/api/orders/[id]/refund` | 申请退款（仅 PAID） |
| POST | `/api/orders/[id]/destroy` | 销毁订单记录（隐私保护；销毁后用户/品牌侧不可见，管理后台保留） |
| POST | `/api/orders/[id]/paid` | 支付宝异步回调（幂等） |

### 购物车
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/cart` | 获取购物车 |
| POST | `/api/cart` | 添加商品 |
| PATCH | `/api/cart` | 修改数量 |
| DELETE | `/api/cart` | 删除商品 |

### 用户
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/user/profile` | 个人信息 + 订单统计 |
| PATCH | `/api/user/profile` | 修改昵称 |

### 商品
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/products` | 商品列表（搜索/分类/排序/分页） |
| GET | `/api/products/[id]` | 商品详情 |
| GET | `/api/products/categories` | 品类列表（两级结构 `{category, subcategories[]}`，平台预设清单） |

### 支付
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/pay/[orderId]` | 支付请求（生成支付宝跳转 URL） |

### 管理后台（ADMIN）
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/admin/dashboard` | 数据看板（统计卡 + 近 7 天销售/订单状态分布/品类分布，卡片跳转预置筛选） |
| GET | `/api/admin/brands` | 品牌列表 |
| POST | `/api/admin/brands/[id]/review` | 品牌审核（PENDING → APPROVED/REJECTED，重复审核 409） |
| GET | `/api/admin/products` | 商品列表（可按 status 筛选） |
| GET | `/api/admin/products/[id]` | 商品详情（完整信息 + 品类质检清单 requiredDocs/checkPoints + 已提交证书 certificates，无模板返回 null） |
| POST | `/api/admin/products/[id]/review` | 商品质检（PENDING → APPROVED/REJECTED，重复质检 409） |
| POST | `/api/admin/products/[id]/delist` | 下架（APPROVED → DELISTED，守卫非该状态 409） |
| POST | `/api/admin/products/[id]/relist` | 重新上架（DELISTED → APPROVED，不重质检） |
| PATCH | `/api/admin/products/[id]` | 编辑商品（改基本信息→回 PENDING 重审；仅改价格/库存→直改；至少传一个字段） |
| GET | `/api/admin/orders` | 订单列表（可按 status 筛选；行含买家昵称/收货人脱敏/件数） |
| POST | `/api/admin/orders/[id]/ship` | 发货（PAID → SHIPPED） |
| POST | `/api/admin/orders/[id]/deliver` | 标记送达（SHIPPED → DELIVERED） |
| POST | `/api/admin/orders/[id]/complete` | 标记完成（DELIVERED → COMPLETED） |
| POST | `/api/admin/orders/[id]/refund-confirm` | 确认退款（REFUND_REQUESTED → REFUNDED） |
| GET | `/api/admin/users` | 用户列表（含角色/状态/锁定/年龄验证） |
| PATCH | `/api/admin/users/[id]` | 用户管理操作（`action`: `setRole`/`setStatus`/`unlock`/`resetPassword`/`clearAgeVerification`；禁止操作自己 403；`resetPassword` 返回一次临时密码；未锁定解锁 409） |
| GET | `/api/admin/audit-templates` | 质检模板列表 |
| PUT | `/api/admin/audit-templates` | 新增/更新质检模板（categoryId 为键 upsert） |
| DELETE | `/api/admin/audit-templates?categoryId=` | 删除质检模板（不存在 404） |
| GET | `/api/admin/invite-codes` | 邀请码列表（分页，状态含推导态 EXPIRED） |
| POST | `/api/admin/invite-codes` | 批量生成邀请码（INV-XXXX-XXXX，逐码审计留痕） |

### 品牌入驻（激活）
| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/invite/activate` | 激活邀请码创建品牌（需登录；单事务原子消耗，无效/已用/过期分别返回 400/409/410） |

### 图片上传（任意登录用户）
| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/upload` | 上传文件到 OSS，返回公开 URL（multipart；`purpose` 枚举 `product`/`brand`/`cert`；`product`/`brand` 只收图片 JPG/PNG/WebP ≤4MB，`cert` 收图片 + PDF ≤10MB；未配置 OSS 返回 503 STORAGE_NOT_CONFIGURED；key 内嵌 userId 按人归属） |

### 品牌方（BRAND）
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/brand/overview` | 品牌概览（商品/订单/销售额，只聚合本品牌数据） |
| GET | `/api/brand/products` | 品牌商品列表（含 description/images/certificates，供编辑预填） |
| POST | `/api/brand/products` | 提交新商品（价格转分存储，待平台质检；需传 `category`+`subCategory` 合法组合；可带 images 至多 5 张 OSS URL + certificates 至多 5 份 `{url, name, mime}`） |
| POST | `/api/brand/products/[id]/withdraw` | 撤回待审提交（PENDING → WITHDRAWN，仅本品牌商品；越权/状态不符分别 403/409） |
| POST | `/api/brand/products/[id]/delist` | 下架（APPROVED → DELISTED，仅本品牌商品） |
| POST | `/api/brand/products/[id]/relist` | 重新上架（DELISTED → APPROVED，不重质检，仅本品牌商品） |
| PATCH | `/api/brand/products/[id]` | 编辑商品（规则同管理端：改基本信息/证书→回 PENDING；仅改价格/库存→直改；拒绝/撤回任意改→重新提交） |
| GET | `/api/brand/audit-template` | 该大类质检模板（`?category=`；返回 requiredDocs/checkPoints，无模板 null；品牌提交页据此展示必交材料清单） |
| GET | `/api/brand/orders` | 品牌订单（仅含本品牌商品的行） |
| PUT | `/api/brand/profile` | 更新品牌资料（名称/logo，logo 需 OSS URL） |

> **商品生命周期对 C 端与订单的影响**：商品下架/撤回/重审后 `status !== "APPROVED"`，购物车与结算的既有 `status` 守卫自动隐藏该行 / 拦截结算（消费侧零改动）；下单是订单快照（OrderItem 存商品名/价格），历史订单不受下架影响；公开商品详情 `GET /api/products/[id]` 仅放行 `APPROVED`，下架/待审商品深链返回 404。
>
> **页面宽度与观感**：SiteHeader 与所有带 header 的内页统一 `max-w-6xl` frame，body 底色 `#f3f4f6` 让白色 app 列在桌面端显形。二期后管理后台/用户中心/订单/购物车等内容容器不再收敛到手机式 `max-w-lg`：管理后台提为 `max-w-5xl`、用户中心 `max-w-2xl`、订单列表/详情 `max-w-3xl`、商品详情 `max-w-2xl`，字号整体上调一档，统计卡数值放大并渐变，适配桌面专业观感。首页为商城风彩色渐变（hero 横幅 + 类目 emoji + 激活渐变 pill + 销量角标）。

### Inngest
| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/inngest` | Inngest 函数入口 |

### API 集成指南

**OpenAPI 生成**：项目集成了 `@asteasolutions/zod-to-openapi`，Zod Schema 即为 API 契约的单一真相来源。运行 `npm run openapi` 生成 `openapi.json`，可直接导入 Postman、Swagger Editor 或用于前端类型生成。

**类型安全前端消费**：API 返回类型从 Zod Schema 自动推导，前端无需手动维护接口类型定义。

#### 请求/响应示例：POST /api/orders（创建订单）

**Request**:
```json
{
  "items": [
    { "productId": "cuid-001", "qty": 2 }
  ],
  "shippingAddress": {
    "name": "张三",
    "phone": "138****8000",
    "province": "广东省",
    "city": "深圳市",
    "district": "南山区",
    "detail": "科技园路1号",
    "zipCode": "518000"
  },
  "privacy": {
    "anonymousPackaging": true,
    "hideProductName": true
  }
}
```

**Response (201)**:
```json
{
  "orderId": "ord_abc123",
  "total": 29900,
  "currency": "CNY",
  "status": "PENDING",
  "payUrl": "https://openapi-sandbox.dl.alipaydev.com/gateway.do?...",
  "expiresAt": "2026-08-08T12:30:00Z"
}
```

**Response (409 — 库存冲突)**:
```json
{
  "error": "STOCK_CONFLICT",
  "message": "商品「XX001」库存不足或存在并发冲突，请重试",
  "conflictProductId": "cuid-001"
}
```

**Response (422 — 参数校验失败)**:
```json
{
  "error": "VALIDATION_ERROR",
  "message": "请求参数不符合预期",
  "details": {
    "items.0.productId": "必填",
    "shippingAddress.name": "长度需在 2-50 之间"
  }
}
```

## 权限模型

| 角色 | 前端路由 | API 权限 |
|------|---------|---------|
| 游客 | `/` `/products/*` `/login` `/register` `/invite` | 无 |
| USER | 上面 + `/cart` `/checkout` `/orders/*` `/account` | 下单、查看/取消/退款/销毁自己的订单、购物车、个人信息 |
| 品牌方 | USER + `/brand/*` | 提交商品、查看品牌数据 |
| ADMIN | 全部 + `/admin/*` | 管理所有品牌/商品/订单/用户/质检模板 |

> 路由保护由 `middleware.ts` 实现：`/admin/*` 要求 ADMIN 角色，`/brand/*` 要求登录且 BRAND 角色，API 层二次校验归属。

> **品牌入驻流程**：游客/USER 在 `/invite` 用管理员发放的邀请码激活品牌（激活只创建 PENDING 品牌，不升级角色）→ 管理员在 `/admin` 审核 → **审核通过时**负责人才升级为 BRAND 角色。当前 access token 15min 内仍携带 USER 角色，需**重新登录**后才可进入 `/brand`。被拒绝的品牌不可再次提交入驻，需联系管理员重新发放邀请码。

## 部署

### Vercel（免费，全球 CDN）
```bash
npm i -g vercel
vercel login
vercel --prod
```
需在 Vercel Dashboard → Project Settings → Environment Variables 配置环境变量。

### 本地生产模式
```bash
npm run build
npm start
```

### 手机端访问
1. 电脑和手机连接同一 WiFi
2. 查看电脑 IP：`ipconfig`（找 WLAN 的 IPv4）
3. 手机浏览器访问：`http://电脑IP:3000`
4. 生产模式下 JS 完整打包，交互正常

### 开机自启（Windows）
- 将 `start.vbs` 复制到 `shell:startup` 启动文件夹
- 重启后自动后台启动服务

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DATABASE_URL` | 是 | PostgreSQL 连接串（本地 Docker 或 Neon） |
| `DIRECT_URL` | 否 | Prisma 迁移用直连 URL（Neon 需要） |
| `JWT_SECRET` | 是 | JWT 签名密钥（生产环境更换为 32+ 字符随机值） |
| `SMS_ACCESS_KEY_ID` | 否 | 阿里云短信 AccessKey |
| `SMS_ACCESS_KEY_SECRET` | 否 | 阿里云短信 Secret |
| `SMS_SIGN_NAME` | 否 | 短信签名名称 |
| `SMS_TEMPLATE_CODE` | 否 | 短信模板 CODE |
| `ALIPAY_APP_ID` | 否 | 支付宝应用 ID |
| `ALIPAY_PRIVATE_KEY` | 否 | 支付宝应用私钥（PEM 格式） |
| `ALIPAY_PUBLIC_KEY` | 否 | 支付宝公钥（PEM 格式） |
| `ALIPAY_GATEWAY` | 否 | 支付宝网关（沙箱/正式） |
| `OSS_ACCESS_KEY_ID` | 否 | 阿里云 OSS AccessKey ID |
| `OSS_ACCESS_KEY_SECRET` | 否 | 阿里云 OSS AccessKey Secret |
| `OSS_BUCKET` | 否 | OSS Bucket 名称 |
| `OSS_REGION` | 否 | OSS 区域代码，如 `oss-cn-hangzhou` |
| `OSS_PUBLIC_DOMAIN` | 否 | OSS 自定义公开访问域名/CDN（如 `https://img.example.com`）；同时供 next.config 图片白名单与 OSS URL 校验。未配置时图片白名单回退通配（生产务必设置） |
| `NEXT_PUBLIC_BASE_URL` | 是 | 回调基础 URL |
| `ENCRYPTION_KEYS` | 否 | AES-256-GCM 加密密钥（优先级从左到右，最左侧为当前加密密钥。格式：`v2:newkey,v1:oldkey`）。旧密钥仅在所有历史数据重加密完成后才可移除 |
| `PEPPER` | 否 | 手机号哈希 pepper（生产环境未配置时 fail-fast 拒绝启动/计算，绝不使用默认值） |
| `INNGEST_EVENT_KEY` | 否 | Inngest Event Key |
| `INNGEST_SIGNING_KEY` | 否 | Inngest Signing Key |
| `SENTRY_DSN` | 否 | Sentry DSN |
| `REDIS_URL` | 否 | Redis 连接（预留） |

## 测试

### 测试金字塔

```
        ┌──────┐
        │ E2E  │  ← 核心闭环：注册→浏览→加购→下单→支付回调→退款
        │ 3 条 │     （Playwright）
        └──────┘
     ┌───────────┐
     │  集成测试  │  ← Service + Prisma 事务（测试数据库），下单/退款/支付回调
     │  ~15 条   │     （Vitest + Docker 本地 PG）
     └───────────┘
  ┌─────────────────┐
  │    单元测试       │  ← 状态机纯函数、金额/加密工具、订单/支付/认证（登录/验证码/补设密码/禁用门禁/Refresh Rotation 吊销）/管理（用户操作/退款回补库存/品牌重审与删除/看板在售口径）/品牌（证书）/邀请码/上传（PDF）/OSS 适配器服务层
  │    ~268 条        │     （Vitest，mock Prisma 与 $transaction）
  └─────────────────┘
```

### 覆盖率阈值

| 层 | 覆盖目标 | 重点 |
|----|---------|------|
| 状态机 (`*.state-machine.ts`) | **100%** | 每个状态转换路径必须覆盖，包括异常路径 |
| 金额工具 (`shared/utils/money.ts`) | **100%** | 边界值：0、负数、`Number.MAX_SAFE_INTEGER`、小数点精度 |
| 加密工具 (`shared/utils/crypto.ts`) | **100%** | 加密/解密往返、空字符串、Unicode、长文本 |
| Service 层 (`*.service.ts`) | **≥80%** | 核心业务分支、事务回滚、异常处理路径 |
| UI 组件 (`*.components.tsx`) | 不强制 | E2E 覆盖关键交互即可 |

### E2E 核心闭环（3 条）

| 测试 | 路径 | 覆盖点 |
|------|------|--------|
| 完整下单链路 | 首页 → 商品详情 → 加购 → 结算 → 下单 → 支付跳转 | 乐观锁库存扣减、支付单创建 |
| 退款链路 | 下单 → 支付 → 申请退款 → 管理员确认退款 | 状态机流转、退款幂等 |
| 订单销毁 | 下单 → 支付 → 完成 → 一键销毁 → 用户/品牌侧列表消失、详情 404 | AES 加密、`destroyedAt` 过滤、管理后台保留 |

### 明确不测试的内容

- **shadcn/ui 组件内部样式**：第三方库自带测试，我们不做冗余验证
- **支付宝 SDK 内部逻辑**：集成测试只验证 adapter 返回值，不测试支付宝服务端
- **Prisma 生成的类型**：ORM 层不需要额外类型测试
- **Tailwind 样式**：E2E 截图对比仅做首页 + 商品详情页，不做全量像素级回归

### CI 中的测试失败排查链路

1. **单元测试失败** → 查看 Vitest 输出的具体断言 → 修改代码或更新测试
2. **E2E 失败** → Playwright Trace Viewer（`npx playwright show-trace test-results/.../trace.zip`）→ 定位到失败的 DOM 快照
3. **构建失败** → 对比 Turbopack 和 Webpack 两个构建日志，定位是否 Turbopack 特有 bug → 如果是，临时切 `--webpack` 回退

```bash
npx vitest run                    # 单元测试（CI 模式，无 watch）
npx vitest run --coverage         # 带覆盖率报告
npx playwright test               # E2E 核心链路
npm run build                     # Turbopack 生产构建
npm run build --webpack           # Webpack 回退构建
```

## 运维与监控

### 国内访问优化

默认部署在 Vercel（全球边缘节点），但中国大陆访问可能受影响。推荐以下优化方案：

| 层级 | 方案 | 适用场景 |
|------|------|---------|
| 轻量加速 | Vercel + 国内 CDN 回源（阿里云全站加速 DCDN / 腾讯云 CDN），静态资源缓存到国内节点 | 小规模运营 |
| 中度优化 | Neon PG 开启 Edge 模式，数据库查询从最近的边缘节点返回 | 配合 Vercel 使用 |
| 完全国内部署 | Railway（新加坡节点，国内访问较快）/ 阿里云 ECS 或 SAE（Serverless 应用引擎）作为备选部署目标 | 流量主要在国内 |
| 企业级 | 阿里云 ACK + 专有网络，前端 CDN + 后端多可用区 | 规模运营后 |

> **建议**：MVP 阶段用 Vercel + Neon 默认部署，国内用户体验可接受。若用户量增长后延迟成为瓶颈，优先开启阿里云全站加速 CDN 回源（配置成本低，收益明显）。

### 日志与监控

| 工具 | 查看位置 | 关注内容 |
|------|---------|---------|
| **Sentry** | Sentry Dashboard → Issues | 未捕获异常的堆栈、`AppError` 中的自定义错误码、支付回调异常状态（如 `CANCELLED` 状态收到支付成功通知） |
| **Inngest** | Inngest Dashboard → Function Runs | 每次异步函数的执行状态（`COMPLETED` / `FAILED` / `CANCELLED`）、重试次数、执行耗时 |
| **Neon** | Neon Console → Monitoring → Query Stats | 慢查询（>100ms）、连接池使用率、数据库 CPU / IOPS |
| **Vercel** | Vercel Dashboard → Functions → Logs | API Route 的 P50/P95 延迟、冷启动次数、函数错误率 |

### 告警规则（建议配置）

| 指标 | 阈值 | 通知渠道 |
|------|------|---------|
| Sentry Error Rate | >5 errors/min | Slack / 飞书 / 钉钉 |
| Inngest Function Failure | 连续 3 次重试失败 | 同上 |
| 支付回调 CANCELLED 告警 | 任何 1 次 | 同上（支付成功但订单已取消，需人工退款） |
| Neon CPU 使用率 | >80% 持续 5 分钟 | 同上（考虑升级套餐或优化查询） |

## 前端约定

1. **`shared/ui/` 下 shadcn 组件只读**，通过组合/包装扩展业务组件；所有源码修改记录在 `shared/ui/README.md`（组件名/原因/日期）
2. **`features/*/index.ts` 是模块唯一 Public API**，禁止跨模块直接 import 内部文件或数据表
3. **PWA 缓存策略**：`/api/*` 严格 Network Only，静态资源 Stale-While-Revalidate，构建版本 `build-id.json` 校验，检测到新版本主动弹条提示刷新
4. **版本管理**：Next.js / React / React DOM 精确版本锁定（不用 `^`），每次升级前跑全量 Playwright E2E
