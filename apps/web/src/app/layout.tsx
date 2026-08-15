import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ToolMint Video Editor",
  description: "A browser-based, scene-first video editor from ToolMint.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
