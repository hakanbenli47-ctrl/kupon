import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kupon Analiz | Gol Tahmin Paneli",
  description: "15 günlük fikstür ve 1.5, 2.5, 3.5 Alt/Üst olasılık analizi.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
