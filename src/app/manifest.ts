import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "赛夫严选",
    short_name: "赛夫严选",
    description: "成人用品品牌聚合严选电商平台 · 隐私配送 · 正品保障",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1a1a2e",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icons/icon-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
