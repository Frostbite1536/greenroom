/**
 * One-shot persisted golden-path run against PRODUCTION, then reports ids for
 * cleanup via reseed. Writes to demo-event — run only inside an announced
 * Architect write window, and reseed afterward.
 */
const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) { console.error("usage: node scripts/_prod-e2e.mjs <url>"); process.exit(2); }
const enc = (s) => Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
const ev = { id: "demo-event", name: "Forward 2026", slug: "forward-2026" };
const admin = { user: { id: "demo-admin", name: "Maya Chen", email: "maya@greenroom.demo" }, event: ev, role: "ADMIN" };
const evalr = { user: { id: "demo-evaluator", name: "Ravi Patel", email: "ravi@greenroom.demo" }, event: ev, role: "EVALUATOR" };
const j = async (m, p, body, sess) => {
  const r = await fetch(BASE + p, { method: m, headers: { "content-type": "application/json", ...(sess ? { cookie: `sb_session=${enc(sess)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
};
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };

// 1. Find the live CFP form (public list is admin; use known seeded form via public read of forms list as admin)
const forms = await j("GET", "/api/cfp/forms", null, admin);
const cfp = forms.data?.data?.find((f) => f.isPublished && f.kind !== "TASK") ?? forms.data?.data?.[0];
check("live CFP form found + published", !!cfp?.id, cfp?.id);

// 2. Public form read (logged out) — window open
const pub = await j("GET", `/api/cfp/public/${cfp.id}`);
check("public form open for submissions (window)", pub.status === 200, pub.status);

// 3. Submit an abstract from the public surface (logged out)
const required = Object.fromEntries((pub.data?.data?.fields ?? []).filter((f) => f.isRequired ?? f.required).map((f) => [f.key, f.type === "select" ? (f.options?.[0]?.value ?? f.options?.[0] ?? "General") : "E2E verification value"]));
const sub = await j("POST", "/api/cfp/submissions", {
  formConfigId: cfp.id, title: "E2E: Persisted golden-path verification", abstract: "Submitted by the architect prod E2E run.",
  speakers: [{ email: "e2e-speaker@greenroom.demo", name: "E2E Speaker", isPrimary: true }],
  answers: required, intent: "submit",
});
check("public submit persisted (201 SUBMITTED)", sub.status === 201 && sub.data?.data?.status === "SUBMITTED", `${sub.status} ${JSON.stringify(sub.data?.error ?? "")}`);
const abstractId = sub.data?.data?.id;

// 4. Appears in admin pipeline
const list = await j("GET", "/api/cfp/submissions?status=SUBMITTED", null, admin);
check("abstract visible in /admin/abstracts data", list.data?.data?.some((a) => a.id === abstractId));

// 5. Accept + convert to session
const dec = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "ACCEPTED" }, admin);
check("admin accepts", dec.status === 200 || dec.status === 201, dec.status);
const conv = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 30 }, admin);
check("converted to session", (conv.status === 200 || conv.status === 201) && conv.data?.data?.sessionId, conv.status);
const sessionId = conv.data?.data?.sessionId;

// 6. Schedule it without conflicts (find a free room/time via agenda read)
const ag = await j("GET", "/api/agenda", null, admin);
const room = ag.data?.data?.rooms?.[0];
const slot = await j("POST", "/api/agenda/slots", {
  eventId: "demo-event", sessionId, roomId: room?.id,
  startsAt: "2026-05-13T22:00:00.000Z", endsAt: "2026-05-13T22:30:00.000Z",
}, admin);
check("scheduled without conflict", slot.status === 200 || slot.status === 201, `${slot.status} ${JSON.stringify(slot.data?.error?.fieldErrors ?? "")}`);

// 7. Shows up on the public embed data + page (logged out)
const pubAg = await j("GET", "/api/agenda/public");
check("public agenda includes it (Neon read)", pubAg.data?.data?.sessions?.some?.((s) => s.id === sessionId) || JSON.stringify(pubAg.data).includes(sessionId));
const embed = await fetch(`${BASE}/embed/schedule`).then((r) => r.text());
check("/embed/schedule HTML renders the session", embed.includes("E2E: Persisted golden-path verification"));

console.log(failed === 0 ? "\n=== PROD E2E: ALL PASS ===" : `\n=== PROD E2E: ${failed} FAILED ===`);
console.log("cleanup: reseed demo-event to remove E2E rows");
process.exit(failed === 0 ? 0 : 1);
