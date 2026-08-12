import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Overflow → MinistryPlatform preview",
  description:
    "Read-only preview of the giving data that would transfer from Overflow into MinistryPlatform.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
