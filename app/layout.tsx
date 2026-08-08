import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { getMockSession } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Sessionboard", template: "%s | Sessionboard" },
  description: "Speaker, CFP, review, and agenda operations in one workspace.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await getMockSession();

  return (
    <html lang="en">
      <body>
        <AppShell session={session}>{children}</AppShell>
      </body>
    </html>
  );
}
