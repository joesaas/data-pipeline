import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "./nav";

export const metadata = {
  title: "data-pipeline · 清洗结果",
  description: "LLM 清洗后的结构化资讯条目",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
