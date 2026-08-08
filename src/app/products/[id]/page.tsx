"use client";

import { use } from "react";
import { ProductDetailPage } from "@/features/products/products.routes";

export default function ProductDetailWrapper({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ProductDetailPage id={id} />;
}
