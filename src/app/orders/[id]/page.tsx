"use client";

import { use } from "react";
import { OrderDetailPage } from "@/features/orders/orders.routes";

export default function OrderDetailWrapper({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <OrderDetailPage id={id} />;
}
