import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

// 加载本地 .env（globalSetup / 测试依赖数据库与登录环境）
dotenv.config({ path: ".env" });

export default defineConfig({
  testDir: "./tests/e2e",
  // 每次运行前重置数据库 + 重新 seed，保证种子订单状态正确（E2E 依赖三角色账号 + 全状态种子订单）
  globalSetup: "./tests/e2e/global-setup.ts",
  // 核心闭环共享同一数据库（退款/销毁会消耗种子订单），单文件内串行执行，避免状态竞争
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // 只跑桌面 Chrome：E2E 是功能闭环验证，移动端由真实设备/手动回归覆盖；
    // 两个 project 并行会同时操作同一数据库，导致退款/销毁等有状态测试互相冲突。
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
