import type { Metadata } from "next";
import "./globals.css";
import "./season-desk.css";

export const metadata: Metadata = {
  title: "Fikstür Lab | 2026–27 Sezonu",
  description: "2026–27 resmî maç fikstürleri, sezon sonuçları, gol istatistikleri ve olasılık analiz merkezi.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
