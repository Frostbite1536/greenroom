import { redirect } from "next/navigation";
import { getResolvedSession, homeForRole } from "@/lib/auth";

export default async function HomePage() {
  const session = await getResolvedSession();
  redirect(session ? homeForRole(session.role) : "/login");
}
