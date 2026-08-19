"use client";

import { use } from "react";
import { TicketDetailPage } from "@/features/service/service.routes";

export default function TicketDetailWrapper({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <TicketDetailPage id={id} />;
}
