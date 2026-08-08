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
    "boundaries/include": ["src/features/*/index.ts"],
    "boundaries/elements": [
      {
        mode: "full",
        type: "feature-public",
        pattern: "src/features/*/index.ts",
        capture: ["featureName"],
      },
      {
        mode: "full",
        type: "feature-internal",
        pattern: "src/features/*/**/*",
      },
    ],
  },
  rules: {
    // 仅禁止模块间直接 import 内部文件（绕过 Public API）
    "boundaries/no-unknown-files": "off",
    "boundaries/no-ignored": "off",
    "boundaries/element-types": [
      "warn",
      {
        default: "allow",
        rules: [
          {
            // 不允许任何文件直接引用 features 模块的内部文件
            from: ["*"],
            disallow: ["feature-internal"],
          },
          {
            // 但允许同一模块内部的互相引用
            from: ["feature-internal"],
            allow: ["feature-internal"],
          },
        ],
      },
    ],
  },
};

const config = [
  ...baseConfig,
  // boundaries 仅在 lint 时启用，不阻断 build
  {
    ...boundariesConfig,
    ignores: [
      "src/app/**",
      "src/shared/**",
      "src/middleware.ts",
      "src/inngest/**",
      "scripts/**",
      "tests/**",
      "prisma/**",
    ],
  },
];

export default config;
