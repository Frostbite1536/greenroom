"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { arePersonaLoginsEnabled } from "@/lib/env";
import {
  DEMO_PERSONAS,
  SESSION_COOKIE,
  encodeSession,
  homeForRole,
  type DemoSession,
  type PersonaKey,
} from "@/lib/auth";

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

/**
 * GRA2-01 — the passwordless demo personas, gated fail-closed in production.
 *
 * The gate is checked HERE, before the persona is even looked up, because
 * hiding the buttons is presentation: this action is a POST endpoint that
 * anyone can call directly, so the server action is the actual boundary. The
 * page hides the buttons off the same helper, but never substitutes for this.
 */
export async function loginAsPersona(formData: FormData): Promise<void> {
  if (!arePersonaLoginsEnabled()) redirect("/login?error=personas-disabled");
  const key = formData.get("persona");
  if (typeof key !== "string" || !(key in DEMO_PERSONAS)) redirect("/login");
  await establish(DEMO_PERSONAS[key as PersonaKey]);
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
