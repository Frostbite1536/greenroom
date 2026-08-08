import { spawn } from "node:child_process";

// Build a demo admin session cookie matching lib/auth.ts encodeSession.
const admin = {
  user: { id: "demo-admin", name: "Maya Chen", email: "maya@sessionboard.demo" },
  event: { id: "demo-event", name: "Forward 2026", slug: "forward-2026" },
  role: "ADMIN",
};
const speaker = { ...admin, user: { id: "demo-speaker", name: "Sofia Marques", email: "sofia@sessionboard.demo" }, role: "SPEAKER" };
const evalr = { ...admin, user: { id: "demo-evaluator", name: "Ravi Patel", email: "ravi@sessionboard.demo" }, role: "EVALUATOR" };
const enc = (s) => Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
const cookie = (s) => `sb_session=${enc(s)}`;

const PORT = process.env.SMOKE_PORT || "3212";
const BASE = `http://127.0.0.1:${PORT}`;
const j = async (method, path, body, sess) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(sess ? { cookie: cookie(sess) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};

const server = spawn("npx", ["next", "start", "-p", PORT], { cwd: process.cwd(), shell: true, stdio: ["ignore", "pipe", "pipe"] });
console.log(`[smoke] server pid ${server.pid} on port ${PORT}`);
let ready = false;
server.stdout.on("data", (d) => { if (/Ready|started server|Local:/i.test(d.toString())) ready = true; });
server.stderr.on("data", (d) => process.stderr.write(d));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/api/agenda/public"); if (r.status) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log(`${cond ? "PASS" : "FAIL"} ${name}`, extra ?? ""); };

try {
  await waitReady();

  // 1. Create + publish a CFP form (admin)
  const formPayload = {
    eventId: "demo-event", name: "Smoke CFP", slug: "smoke-cfp-" + Date.now().toString(36),
    minSpeakers: 1, maxSpeakers: 2, maxBioLength: 500, published: true,
    fields: [
      { key: "title_note", label: "Talk note", type: "SHORT_TEXT", required: true, sortOrder: 0 },
      { key: "bio", label: "Speaker bio", type: "LONG_TEXT", required: false, sortOrder: 1 },
    ],
  };
  const form = await j("POST", "/api/cfp/forms", formPayload, admin);
  check("create form", form.status === 201 && form.data?.ok, form.status);
  const formId = form.data?.data?.id;

  // 2. Public read of the form (null session)
  const pub = await j("GET", `/api/cfp/public/${formId}`);
  check("public form read (no auth)", pub.status === 200 && pub.data?.data?.isOpen === true);

  // 3. Reject submit with missing required field
  const bad = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "My talk", speakers: [{ email: "SPK@x.com", name: "Spk", isPrimary: true }],
    answers: {}, intent: "submit",
  });
  check("submit rejects missing required field", bad.status === 422 && bad.data?.error?.fieldErrors?.title_note, bad.data?.error?.code);

  // 4. Valid submit (public)
  const sub = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "My great talk", abstract: "About stuff",
    speakers: [{ email: "spk@x.com", name: "Spk One", isPrimary: true }, { email: "co@x.com", name: "Co Two", isPrimary: false }],
    answers: { title_note: "hello", bio: "a short bio" }, intent: "submit",
  });
  check("valid submit", sub.status === 201 && sub.data?.data?.status === "SUBMITTED", sub.status);
  const abstractId = sub.data?.data?.id;
  check("co-speaker upserted by email", sub.data?.data?.speakers?.length === 2);

  // 5. Admin lists abstracts
  const list = await j("GET", "/api/cfp/submissions?status=SUBMITTED", null, admin);
  check("admin lists submitted abstracts", list.status === 200 && list.data?.data?.some(a => a.id === abstractId));

  // 6. Create evaluation plan
  const plan = await j("POST", "/api/evaluations/plans", {
    eventId: "demo-event", name: "Round 1 Smoke", ordinal: Math.floor(Math.random()*100000),
    rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 }],
  }, admin);
  check("create plan", plan.status === 201, plan.status);
  const planId = plan.data?.data?.id;

  // 7. Evaluator touches an authed route so context.ts upserts their User +
  // EventMember rows, then admin resolves the real DB id via /evaluators.
  await j("GET", "/api/evaluations/plans", null, evalr);
  const eva = await j("GET", "/api/evaluations/evaluators", null, admin);
  const evaluatorId = eva.data?.data?.find((e) => e.email === evalr.user.email.toLowerCase())?.userId;
  check("resolve evaluator id", eva.status === 200 && !!evaluatorId, evaluatorId);

  // 8. Assign the abstract to the evaluator -> abstract moves to UNDER_REVIEW
  const assign = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [abstractId], evaluatorIds: [evaluatorId],
  }, admin);
  check("create assignment", assign.status === 201 && assign.data?.data?.assignments === 1, assign.status);

  const queue = await j("GET", `/api/evaluations/assignments?planId=${planId}`, null, evalr);
  check("evaluator sees own queue", queue.status === 200 && queue.data?.data?.some(a => a.abstractId === abstractId));

  // 9. Scoring: out-of-range rejected, unassigned evaluator rejected, valid accepted
  const badScore = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 99 }], complete: false,
  }, evalr);
  check("score out of rubric range rejected", badScore.status === 422, badScore.data?.error?.code);

  const unknownKey = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "not_a_criterion", score: 3 }], complete: false,
  }, evalr);
  check("unknown rubric key rejected", unknownKey.status === 422, unknownKey.data?.error?.code);

  const notAssigned = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 4 }], complete: true,
  }, { ...evalr, user: { id: "x", name: "Stranger", email: "stranger@x.com" } });
  check("unassigned evaluator refused", notAssigned.status === 403, notAssigned.data?.error?.code);

  const score = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 5, comment: "strong" }], complete: true,
  }, evalr);
  check("valid score recorded + assignment completed", score.status === 200 && score.data?.data?.complete === true, score.status);

  // 10. Convert before acceptance must fail (INV-DOMAIN-001)
  const early = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("convert before acceptance refused", early.status === 409, early.data?.error?.code);

  // 11. Accept, then convert to a Session
  const decision = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "ACCEPTED" }, admin);
  check("accept abstract", decision.status === 200 && decision.data?.data?.status === "ACCEPTED", decision.status);

  const conv = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("convert to session", conv.status === 201 && conv.data?.data?.created === true, conv.status);
  const sessionId = conv.data?.data?.sessionId;

  const conv2 = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("convert is idempotent", conv2.data?.data?.created === false && conv2.data?.data?.sessionId === sessionId);

  // 12. Agenda: rooms come from the builder read
  const agenda = await j("GET", "/api/agenda", null, admin);
  check("agenda read exposes rooms + backlog", agenda.status === 200 && agenda.data?.data?.rooms?.length > 0, agenda.data?.data?.rooms?.length);
  const rooms = agenda.data?.data?.rooms ?? [];
  const roomA = rooms[0]?.id, roomB = rooms[1]?.id ?? rooms[0]?.id;

  const t0 = new Date(Date.now() + 86400000); t0.setUTCMinutes(0, 0, 0);
  const iso = (d) => new Date(d).toISOString();
  const start = iso(t0), end = iso(t0.getTime() + 45 * 60000);

  // 13. Place the session
  const place = await j("POST", "/api/agenda/slots", {
    eventId: "demo-event", sessionId, roomId: roomA, startsAt: start, endsAt: end,
  }, admin);
  check("place session on schedule", place.status === 200 && !!place.data?.data?.slot?.id, place.status);

  // 14. Room conflict: a second session in the same room at the same time
  const sub2 = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Second talk", abstract: "More stuff",
    speakers: [{ email: "other@x.com", name: "Other Person", isPrimary: true }],
    answers: { title_note: "hi" }, intent: "submit",
  });
  const abstractId2 = sub2.data?.data?.id;
  await j("POST", "/api/evaluations/decisions", { abstractId: abstractId2, decision: "ACCEPTED" }, admin);
  const conv3 = await j("POST", "/api/evaluations/convert", { abstractId: abstractId2, durationMinutes: 45 }, admin);
  const sessionId2 = conv3.data?.data?.sessionId;

  const roomClash = await j("POST", "/api/agenda/slots", {
    eventId: "demo-event", sessionId: sessionId2, roomId: roomA, startsAt: start, endsAt: end,
  }, admin);
  check("room conflict refused (409)", roomClash.status === 409 && /ROOM_OVERLAP/.test(JSON.stringify(roomClash.data)), roomClash.data?.error?.code);

  // 15. Speaker conflict: same speaker, different room, overlapping time
  const sub3 = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Third talk", abstract: "Even more",
    speakers: [{ email: "spk@x.com", name: "Spk One", isPrimary: true }],
    answers: { title_note: "hi" }, intent: "submit",
  });
  const abstractId3 = sub3.data?.data?.id;
  await j("POST", "/api/evaluations/decisions", { abstractId: abstractId3, decision: "ACCEPTED" }, admin);
  const conv4 = await j("POST", "/api/evaluations/convert", { abstractId: abstractId3, durationMinutes: 45 }, admin);
  const speakerClash = await j("POST", "/api/agenda/slots", {
    eventId: "demo-event", sessionId: conv4.data?.data?.sessionId, roomId: roomB,
    startsAt: start, endsAt: end,
  }, admin);
  check("speaker double-booking refused", speakerClash.status === 409 && /SPEAKER_OVERLAP/.test(JSON.stringify(speakerClash.data)), speakerClash.data?.error?.code);

  // 16. Non-overlapping placement succeeds
  const later = iso(t0.getTime() + 60 * 60000), laterEnd = iso(t0.getTime() + 105 * 60000);
  const okPlace = await j("POST", "/api/agenda/slots", {
    eventId: "demo-event", sessionId: sessionId2, roomId: roomA, startsAt: later, endsAt: laterEnd,
  }, admin);
  check("non-overlapping placement succeeds", okPlace.status === 200 && !!okPlace.data?.data?.slot?.id, okPlace.status);

  // 17. Moving a session doesn't conflict with itself
  const move = await j("POST", "/api/agenda/slots", {
    eventId: "demo-event", sessionId: sessionId2, roomId: roomA,
    startsAt: iso(t0.getTime() + 65 * 60000), endsAt: iso(t0.getTime() + 110 * 60000),
  }, admin);
  check("move own slot without self-conflict", move.status === 200, move.status);

  // 18. Public embed shows placed sessions with a null session
  const pubAgenda = await j("GET", "/api/agenda/public?event=forward-2026");
  check("public agenda (no auth) lists placed sessions", pubAgenda.status === 200 && pubAgenda.data?.data?.sessions?.length >= 2, pubAgenda.data?.data?.sessions?.length);

  // 19. Authorization: speaker persona cannot reach admin surfaces
  const forbidden = await j("GET", "/api/agenda", null, speaker);
  check("speaker blocked from admin agenda", forbidden.status === 403, forbidden.status);
  const anon = await j("GET", "/api/agenda");
  check("anonymous blocked from admin agenda", anon.status === 401, anon.status);

  // 20. Cleanup so repeated runs stay conflict-free
  await j("DELETE", `/api/agenda/slots?sessionId=${sessionId}`, null, admin);
  await j("DELETE", `/api/agenda/slots?sessionId=${sessionId2}`, null, admin);

  console.log("IDS", JSON.stringify({ planId, abstractId, formId, sessionId }));
} catch (e) {
  console.error("SMOKE ERROR", e);
} finally {
  const failed = results.filter(r => r.ok === false);
  console.log(`\n=== ${results.filter(r=>r.ok).length} passed, ${failed.length} failed ===`);
  // Kill ONLY the process tree we spawned (never by image name — see STATE.md incident rule).
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
  } else {
    server.kill();
  }
  setTimeout(() => process.exit(failed.length ? 1 : 0), 1500);
}
