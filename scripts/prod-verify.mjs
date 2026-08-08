/**
 * Production verification against the deployed Vercel URL.
 *
 * Usage:
 *   node scripts/prod-verify.mjs https://your-deployment.vercel.app
 *   PROD_URL=https://... node scripts/prod-verify.mjs
 *
 * Read-only: performs no writes. The one write-capable endpoint it touches
 * (/api/admin/reset) is expected to be REFUSED in production.
 */
import { PrismaClient } from "@prisma/client";

const BASE = (process.argv[2] ?? process.env.PROD_URL ?? "").replace(/\/$/, "");
if (!BASE) {
  console.error("Usage: node scripts/prod-verify.mjs <https://deployment-url>");
  process.exit(2);
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function isSsoWall(res, body) {
  const loc = res.headers.get("location") ?? "";
  return loc.includes("vercel.com/sso-api") || (body ?? "").includes("Authentication Required");
}

// Look up a published form id from the same database the deployment uses.
const prisma = new PrismaClient();
let formId;
try {
  const form = await prisma.formConfig.findFirst({
    where: { eventId: "demo-event", published: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  formId = form?.id;
} finally {
  await prisma.$disconnect();
}

console.log(`Verifying ${BASE}\n`);

// 0. Gate check — everything below is meaningless behind the SSO wall.
{
  const res = await fetch(`${BASE}/login`, { redirect: "manual" });
  const body = await res.text().catch(() => "");
  if (isSsoWall(res, body)) {
    console.error(
      "BLOCKED: Vercel Deployment Protection (SSO) is still enabled.\n" +
        "Vercel → greenroom → Settings → Deployment Protection → Vercel Authentication → Disabled.\n" +
        "Judges cannot reach the site until this is off.",
    );
    process.exit(3);
  }
}

// 1. /login renders for a logged-out visitor.
{
  const res = await fetch(`${BASE}/login`);
  const html = await res.text();
  check("/login renders for a logged-out visitor", res.status === 200 && html.includes("Greenroom"), `status ${res.status}`);
}

// 2. Public routes work with NO session. Authenticated personas are covered by
// local smoke runs because production cookies cannot and must not be forged.
{
  const res = await fetch(`${BASE}/embed/schedule`);
  check("/embed/schedule renders logged out", res.status === 200, `status ${res.status}`);
}
if (formId) {
  const res = await fetch(`${BASE}/cfp/${formId}`);
  check(`/cfp/${formId} renders logged out`, res.status === 200, `status ${res.status}`);
} else {
  check("/cfp/[formId] renders logged out", false, "no published form found in the database");
}

// 3. Demo reset must be REFUSED in production (ALLOW_DEMO_RESET unset).
{
  const res = await fetch(`${BASE}/api/admin/reset`, { method: "POST" });
  const body = await res.json().catch(() => null);
  check(
    "/api/admin/reset is refused in production",
    res.status === 403 && body?.error?.code === "RESET_DISABLED",
    `status ${res.status} code ${body?.error?.code}`,
  );
}

// 4. Calendar export works publicly (golden path step 7).
{
  const res = await fetch(`${BASE}/api/comms/calendar?eventId=demo-event`);
  const text = await res.text();
  check(
    "public .ics export works logged out",
    res.status === 200 && text.startsWith("BEGIN:VCALENDAR"),
    `status ${res.status}`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} production checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
