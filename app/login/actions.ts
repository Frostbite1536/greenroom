"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  DEMO_EVENT,
  DEMO_PERSONAS,
  SESSION_COOKIE,
  encodeSession,
  homeForRole,
  type DemoSession,
  type PersonaKey,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function establish(session: DemoSession): Promise<never> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    secure: process.env.NODE_ENV === "production",
  });
  redirect(homeForRole(session.role));
}

export async function loginAsPersona(formData: FormData): Promise<void> {
  const key = formData.get("persona");
  if (typeof key !== "string" || !(key in DEMO_PERSONAS)) redirect("/login");
  await establish(DEMO_PERSONAS[key as PersonaKey]);
}

export async function loginWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/login");
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { where: { eventId: DEMO_EVENT.id }, select: { role: true }, take: 1 },
    },
  });
  const membership = user?.memberships[0];
  if (!user || !membership) redirect("/login");
  await establish({
    user: { id: user.id, name: user.name, email: user.email },
    event: DEMO_EVENT,
    role: membership.role,
  });
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
