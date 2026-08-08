// OpenAPI 文档生成器
// 运行: npm run openapi
// 从 Zod Schema 自动生成 openapi.json，可直接导入 Postman/Swagger

import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { writeFileSync } from "fs";
import path from "path";

// TODO: 在各 feature 模块的 Schema 定义后导入并注册
// import { createOrderSchema } from "@/features/orders/orders.api";

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "cookieAuth", {
  type: "apiKey",
  in: "cookie",
  name: "access_token",
});

// TODO: 注册每个 API 端点
// registry.registerPath({
//   method: "post",
//   path: "/api/orders",
//   summary: "创建订单",
//   request: { body: { content: { "application/json": { schema: createOrderSchema } } } },
//   responses: {
//     201: { description: "订单创建成功" },
//     409: { description: "库存冲突" },
//     422: { description: "参数校验失败" },
//   },
// });

const generator = new OpenApiGeneratorV3(registry.definitions);
const doc = generator.generateDocument({
  openapi: "3.0.3",
  info: { title: "赛夫严选 API", version: "1.0.0" },
  servers: [{ url: process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000" }],
});

const outputPath = path.resolve(process.cwd(), "public/openapi.json");
writeFileSync(outputPath, JSON.stringify(doc, null, 2));
console.log(`✅ OpenAPI 文档已生成: ${outputPath}`);
