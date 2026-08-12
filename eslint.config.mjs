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
    ignores: [
      "node_modules/**",
      ".next/**",
      "postgres-data/**",
      "*.bak",
    ],
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
      // 每个 feature 模块：index.ts 是唯一 Public API，其余为模块内部文件
      {
        type: "feature-public",
        pattern: "src/features/*/index.ts",
        capture: ["featureName"],
        mode: "full",
      },
      {
        // feature-internal 未指定 mode → FOLDER 模式，插件会自动追加 /**/*
        // pattern 只需 `src/features/*`（feature 目录），capture[0]=featureName
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
    "boundaries/element-types": [
      "warn",
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
            // ② feature 内部文件不得跨模块引用其他 feature 的内部文件
            //    同模块引用二者 captured featureName 相同 → "!{from.featureName}" 不匹配 → 放行
            //    app 层为 composition root（route handlers 由 feature 导出），按 default:allow 放行
            //    注：ESLint schema 只接受 tuple 形式 ["type", {captured}]，对象形式会被插件 runtime 支持但被 ESLint 校验拒绝
            from: ["feature-internal"],
            disallow: [["feature-internal", { featureName: "!{from.featureName}" }]],
          },
        ],
      },
    ],
  },
};

const config = [
  ...baseConfig,
  // boundaries 仅在 lint 时启用，不阻断 build
  // 注意：src/shared、src/app 必须纳入检查（rules ① 依赖 shared 被处理）；
  // app 层 import feature 内部是 composition root 的文档化模式，由 default:allow 放行
  {
    ...boundariesConfig,
    ignores: [
      "src/middleware.ts",
      "src/inngest/**",
      "scripts/**",
      "tests/**",
      "prisma/**",
    ],
  },
];

export default config;
