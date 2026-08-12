// Inngest Serve 端点 — Inngest Cloud / Dev Server 调度的入口
import { serve } from "inngest/next";
import { inngest, inngestFunctions } from "@/inngest";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: inngestFunctions,
});
