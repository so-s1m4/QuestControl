import type { Metadata } from "next";
import { headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/checkin-og.png`;

  return {
    title: "Reception Check-in — QuestControl",
    description: "Self-service guest check-in for Escapers_Peolten.",
    openGraph: {
      title: "Reception Check-in — QuestControl",
      description: "Self-service guest check-in for Escapers_Peolten.",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "QuestControl Reception Check-in" }],
    },
    twitter: { card: "summary_large_image", images: [imageUrl] },
  };
}

export default function CheckinLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
