import type { UserRole } from "@prisma/client";
import { cache } from "react";

export type MockSession = {
  user: { id: string; name: string; email: string };
  event: { id: string; name: string; slug: string };
  role: UserRole;
};

export const getMockSession = cache(async (): Promise<MockSession> => ({
  user: { id: "demo-admin", name: "Maya Chen", email: "maya@sessionboard.demo" },
  event: { id: "demo-event", name: "Forward 2026", slug: "forward-2026" },
  role: "ADMIN",
}));
