import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuestControl — CRM для квест-комнат",
  description: "Бронирования, комнаты, локальные панели, камеры и устройства в одном центре управления.",
  openGraph: {
    title: "QuestControl",
    description: "CRM & Control Center для реальных и VR-квестов",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "QuestControl dashboard" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
