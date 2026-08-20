import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import boundaries from "eslint-plugin-boundaries";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const baseConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // 开发阶段降低 TS 严格度，正式上线前收紧
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
    },
  },
];

const boundariesConfig = {
  plugins: {
    boundaries,
  },
  settings: {
    // 处理整个 src 目录（此前只 include index.ts 导致规则形同虚设）
    "boundaries/include": ["src/**/*.{ts,tsx}"],
    "boundaries/elements": [
      // 每个 feature 三个 Public seam（M14）：
      //  ① feature-public（index.ts）— 跨 feature 服务逻辑（server）经 index 消费
      //  ② feature-api（*.api.ts）— HTTP route handlers 直连，server-only
      //  ③ feature-client（*.routes.tsx / *.components.tsx）— 页面组件，client 安全
      //     约束来自 Next.js：client 组件若经 index barrel 导入，会把 index 重导出的
      //     server 依赖（如 orders.service → payment → alipay-sdk → fs）编进 client 包
      {
        type: "feature-public",
        pattern: "src/features/*/index.ts",
        capture: ["featureName"],
        mode: "full",
      },
      {
        type: "feature-api",
        pattern: "src/features/*/*.api.ts",
        capture: ["featureName"],
        mode: "full",
      },
      {
        type: "feature-client",
        pattern: [
          "src/features/*/*.routes.tsx",
          "src/features/*/*.components.tsx",
        ],
        capture: ["featureName"],
        mode: "full",
      },
      {
        // feature-internal 未指定 mode → FOLDER 模式，插件会自动追加 /**/*
        // pattern 只需 `src/features/*`（feature 目录），capture[0]=featureName
        // 注意顺序：必须在 feature-api / feature-client 之后（同文件命中时取先匹配者）
        type: "feature-internal",
        pattern: "src/features/*",
        capture: ["featureName"],
      },
      { type: "shared", pattern: "src/shared" },
      { type: "app", pattern: "src/app" },
    ],
  },
  rules: {
    "boundaries/no-unknown-files": "off",
    "boundaries/no-ignored": "off",
    // L10：warn → error。此前全 warn 且 CI 无 lint 门槛，跨模块违规永不阻断发布；
    // 收紧后 `npm run lint` / eslint 直接失败，README「index.ts 唯一 Public API」成硬约束
    "boundaries/element-types": [
      "error",
      {
        default: "allow",
        rules: [
          {
            // ① shared 层不得引用任何 feature 的内部文件（必须走 feature 的 Public API）
            //    例：shared/api/auth.ts 只能 import "@/features/auth"，不能 import ".../auth.service"
            from: ["shared"],
            disallow: ["feature-internal"],
          },
          {
            // ② feature 内部文件（含 api / client / public 三个 seam）不得跨模块引用其他 feature 的内部文件
            //    同模块引用二者 captured featureName 相同 → "!{{from.featureName}}" 不匹配 → 放行
            //    注1：模板必须是 Handlebars 双大括号 `{{from.x}}`——单大括号 `{from.x}` 会被当字面 glob，
            //         `micromatch.isMatch(name, "!{from.x}")` 恒真 → 把所有同模块引用误判为跨模块
            //    注2：ESLint schema 只接受 tuple 形式 ["type", {captured}]，对象形式会被插件 runtime 支持但被 ESLint 校验拒绝
            from: ["feature-internal", "feature-api", "feature-client", "feature-public"],
            disallow: [["feature-internal", { featureName: "!{{from.featureName}}" }]],
          },
          {
            // ③ app 层不得直连 feature 内部文件（.service/.queries/.components/.routes/.state-machine 等），
            //    只允许三个 Public seam（M14）：
            //      feature-public（index.ts）— 服务端页面/组件经 "@<m>" 导入
            //      feature-api（*.api.ts）— route handlers 经 "@/<m>/<m>.api" 直连（api 不经 index 重导出，
            //                               阻断 server 依赖如 alipay-sdk 进入页面图）
            //      feature-client（*.routes.tsx/*.components.tsx）— "use client" 页面直连（不能走 index barrel，
            //                               否则被 index 重导出的 server 依赖编进 client 包）
            from: ["app"],
            disallow: ["feature-internal"],
          },
        ],
      },
    ],
  },
};

const config = [
  // 全局忽略：eslint 9 flat config 中只有「无 files/rules 键的独立配置对象」才作为全局 ignores；
  // 此前放在带 rules 的 baseConfig 里，导致 .next/**、coverage/** 未被忽略，`eslint .` 扫出 9000+ 产物问题。
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "coverage/**",
      "postgres-data/**",
      "tmp/**",
      "*.bak",
      "next-env.d.ts",
    ],
  },
  ...baseConfig,
  // boundaries 仅在 lint 时启用，不阻断 build
  // 注意：src/shared、src/app 必须纳入检查（rules ①③ 分别依赖 shared/app 被处理）；
  // app 层走 "@/features/<m>"（rule ③ 强制 feature-public），composition root 模式由该入口承载
  // 用 files 负向模式（!pattern）排除不适用 boundaries 的文件；scripts/tests/prisma 不在 src，
  // 本就不匹配任何 element（no-unknown-files: off），保留负向仅作防御
  {
    ...boundariesConfig,
    files: [
      "!src/middleware.ts",
      "!src/inngest/**",
      "!scripts/**",
      "!tests/**",
      "!prisma/**",
    ],
  },
];

export default config;
