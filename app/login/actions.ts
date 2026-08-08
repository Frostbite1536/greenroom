"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  DEMO_EVENT,
  DEMO_PERSONAS,
  SESSION_COOKIE,
  encodeSession,
  type DemoSession,
  type PersonaKey,
} from "@/lib/auth";

const HOME_BY_ROLE: Record<DemoSession["role"], string> = {
  ADMIN: "/admin/forms",
  EVALUATOR: "/admin/evaluations",
  SPEAKER: "/portal",
};

async function establish(session: DemoSession): Promise<never> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  redirect(HOME_BY_ROLE[session.role]);
}

export async function loginAsPersona(formData: FormData): Promise<void> {
  const key = formData.get("persona");
  if (typeof key !== "string" || !(key in DEMO_PERSONAS)) redirect("/login");
  await establish(DEMO_PERSONAS[key as PersonaKey]);
}

export async function loginWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/login");
  const name = email
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
  await establish({
    user: { id: `email:${email}`, name: name || email, email },
    event: DEMO_EVENT,
    role: "SPEAKER",
  });
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
