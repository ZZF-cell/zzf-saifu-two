// Inngest Client 单例
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "saife-yanxuan",
  eventKey: process.env.INNGEST_EVENT_KEY,
});
