// E2E 全局准备：重置数据库并重新 seed。
// 每次 `playwright test` 运行前执行一次，保证：
//   - 三角色账号存在（管理员 13900000000 / 用户 13800138000 / 品牌方 13888888888）
//   - 全状态种子订单状态正确（退款链路用 seed-order-paid、销毁链路用 seed-order-delivered）
// 否则退款/销毁测试第二次运行会因种子订单状态已被消费而失败。
import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

export default async function globalSetup() {
  // 重建 schema + 清空数据 + 重新 seed（幂等：seed 全用 upsert）
  execSync("npx prisma db push --force-reset --skip-generate", {
    stdio: "inherit",
    env: { ...process.env },
  });
  execSync("npx prisma db seed", {
    stdio: "inherit",
    env: { ...process.env },
  });
}
