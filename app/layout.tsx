import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Greenroom", template: "%s | Greenroom" },
  description: "Speaker, CFP, review, and agenda operations in one workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
