// Auth 模块 Public API
// 其他模块只能通过此文件访问 auth 模块

export * as authService from "./auth.service";
export * as authQueries from "./auth.queries";
export { LoginPage, RegisterPage } from "./auth.routes";
export type { AuthUser } from "@/shared/auth/middleware";
