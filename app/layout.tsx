import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Overflow → MinistryPlatform preview",
  description:
    "Preview, and merge, of the giving data waiting to transfer from Overflow into MinistryPlatform.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
