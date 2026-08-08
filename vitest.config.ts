import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    coverage: {
      include: [
        "src/features/**/*.state-machine.ts",
        "src/features/**/*.service.ts",
        "src/shared/utils/**/*.ts",
      ],
      thresholds: {
        // 状态机、金额、加密要求 100%
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
