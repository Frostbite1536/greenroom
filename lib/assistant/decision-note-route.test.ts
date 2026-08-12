import assert from "node:assert/strict";
import test from "node:test";
import type { UserRole } from "@prisma/client";
import { ApiError } from "@/lib/api/http";
import type { ApiContext } from "@/lib/api/context";
import type { AssistantRequest, AssistantResult } from "@/lib/assistant/client";
import {
  createDecisionNotePost,
  type DecisionNoteDeps,
  type DecisionNoteQuery,
} from "@/app/api/assistant/decision-note/route";
import {
  DECISION_NOTE_MAX_BODY_BYTES,
  DECISION_NOTE_MAX_DRAFT_CHARS,
  DECISION_NOTE_REQUEST_MAX_OUTPUT_CHARS,
  DECISION_NOTE_SCHEMA_NAME,
  type DecisionNoteAbstract,
} from "./decision-note";

/**
 * The executable runtime matrix for `POST /api/assistant/decision-note`.
 *
 * This drives the REAL handler — the same function the route file exports —
 * with injected collaborators, so what is asserted is behaviour rather than the
 * shape of the source. That matters most for three claims a regex cannot reach:
 * the exact `select` the route hands the database, the exact prompt it hands the
 * provider, and the fact that a refused request never reaches either.
 *
 * Honest scope: `requireContext` is faked, so this proves the route DEMANDS
 * `["ADMIN"]` and that the envelope for a refusal is right. It does not prove
 * session resolution itself, which is `lib/api/context.ts`'s own contract and
 * is exercised end to end by the backend smoke suite.
 */

const ADMIN: ApiContext = {
  userId: "user-admin",
  email: "admin@scratch.test",
  name: "Admin",
  role: "ADMIN" as UserRole,
  eventId: "event-1",
};

const OTHER_EVENT_ABSTRACT: DecisionNoteAbstract = {
  title: "Someone else's talk",
  status: "ACCEPTED",
  event: { name: "Other Conf" },
};

const OWN_ABSTRACT: DecisionNoteAbstract = {
  title: "Backstage: Running a 3,000-Person Conference",
  status: "ACCEPTED",
  event: { name: "Forward 2026" },
};

/**
 * A fake that really enforces scope.
 *
 * The rows carry the ids the route has to match on, and the fake honours the
 * WHOLE where-clause. If the route ever stopped sending `eventId`, the foreign
 * row would come back and the indistinguishability test below would fail rather
 * than quietly keep passing on a fake that ignored the clause.
 */
const SCOPED_ROWS: Array<{ id: string; eventId: string; row: DecisionNoteAbstract }> = [
  { id: "abstract-1", eventId: "event-1", row: OWN_ABSTRACT },
  { id: "abstract-foreign", eventId: "event-2", row: OTHER_EVENT_ABSTRACT },
];

type Recorder = {
  roles: UserRole[][];
  rateCalls: Array<{ userId: string; eventId: string }>;
  abstractQueries: DecisionNoteQuery[];
  commentQueries: Array<DecisionNoteQuery & { orderBy: unknown; take: number }>;
  assistantCalls: AssistantRequest[];
  order: string[];
};

function harness(over: {
  ctx?: ApiContext | null;
  abstract?: DecisionNoteAbstract | null;
  comments?: Array<{ comment: string | null }>;
  assistant?: AssistantResult;
  rateLimit?: ApiError;
} = {}): { post: (req: Request) => Promise<Response>; seen: Recorder } {
  const seen: Recorder = {
    roles: [],
    rateCalls: [],
    abstractQueries: [],
    commentQueries: [],
    assistantCalls: [],
    order: [],
  };

  const deps: DecisionNoteDeps = {
    requireContext: async (roles) => {
      seen.roles.push(roles);
      seen.order.push("auth");
      // The real refusals from `lib/api/context.ts`, reproduced so the envelope
      // this route produces for each is the thing under test.
      const ctx = over.ctx === undefined ? ADMIN : over.ctx;
      if (!ctx) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
      if (!roles.includes(ctx.role)) {
        throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
      }
      return ctx;
    },
    enforceRateLimit: async (input) => {
      seen.rateCalls.push(input);
      seen.order.push("rate");
      if (over.rateLimit) throw over.rateLimit;
    },
    db: {
      findAbstract: async (query) => {
        seen.abstractQueries.push(query);
        seen.order.push("findAbstract");
        if (over.abstract !== undefined) return over.abstract;
        // Honour the whole clause, so dropping `eventId` from the route would
        // surface here as a foreign row rather than as a silent pass.
        const match = SCOPED_ROWS.find(
          (candidate) => candidate.id === query.where.id && candidate.eventId === query.where.eventId,
        );
        return match?.row ?? null;
      },
      findComments: async (query) => {
        seen.commentQueries.push(query);
        seen.order.push("findComments");
        return over.comments ?? [{ comment: "Clear structure and a real war story." }];
      },
    },
    runAssistant: async (request) => {
      seen.assistantCalls.push(request);
      seen.order.push("assistant");
      return over.assistant ?? { ok: true, text: JSON.stringify({ draft: "A warm, specific note." }) };
    },
  };

  return { post: createDecisionNotePost(deps), seen };
}

function request(body: unknown, init: RequestInit = {}): Request {
  return new Request("http://127.0.0.1/api/assistant/decision-note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

const VALID = { abstractId: "abstract-1", includeFeedback: true };

async function envelope(response: Response): Promise<{ ok: boolean; error?: { code: string; message: string }; data?: { draft: string; grounding: unknown } }> {
  return (await response.json()) as never;
}

/* -------------------------------------------------------------------------- */
/* Authorization                                                              */
/* -------------------------------------------------------------------------- */

test("401 for an unauthenticated caller, and nothing downstream runs", async () => {
  const { post, seen } = harness({ ctx: null });
  const response = await post(request(VALID));
  assert.equal(response.status, 401);
  assert.equal((await envelope(response)).error?.code, "UNAUTHENTICATED");
  // Not charged, not read, not sent. A refused caller costs nothing and learns
  // nothing about whether the proposal exists.
  assert.deepEqual(seen.rateCalls, []);
  assert.deepEqual(seen.abstractQueries, []);
  assert.deepEqual(seen.assistantCalls, []);
});

test("403 for an authenticated non-admin, on every non-admin role", async () => {
  for (const role of ["EVALUATOR", "SPEAKER"] as UserRole[]) {
    const { post, seen } = harness({ ctx: { ...ADMIN, role } });
    const response = await post(request(VALID));
    assert.equal(response.status, 403, `${role} must be refused`);
    assert.equal((await envelope(response)).error?.code, "FORBIDDEN");
    assert.deepEqual(seen.assistantCalls, [], `${role} must not reach the provider`);
    assert.deepEqual(seen.abstractQueries, [], `${role} must not reach the database`);
  }
});

test("the route demands exactly ADMIN", async () => {
  const { post, seen } = harness();
  await post(request(VALID));
  assert.deepEqual(seen.roles, [["ADMIN"]]);
});

/* -------------------------------------------------------------------------- */
/* Scope and lifecycle                                                        */
/* -------------------------------------------------------------------------- */

test("an unknown id and another event's id are byte-identical 404s, and neither is read", async () => {
  // No `abstract` override: both go through the scope-honouring fake, so the
  // foreign row is refused by the WHERE clause rather than by a comparison the
  // route makes after loading it.
  const missing = harness();
  const foreign = harness();

  const missingResponse = await missing.post(request({ ...VALID, abstractId: "nope" }));
  const foreignResponse = await foreign.post(request({ ...VALID, abstractId: "abstract-foreign" }));

  // The query really carried both halves of the scope.
  assert.deepEqual(foreign.seen.abstractQueries[0]!.where, {
    id: "abstract-foreign",
    eventId: "event-1",
  });
  assert.deepEqual(missing.seen.abstractQueries[0]!.where, { id: "nope", eventId: "event-1" });

  assert.equal(missingResponse.status, 404);
  assert.equal(foreignResponse.status, 404);
  const left = await missingResponse.text();
  const right = await foreignResponse.text();
  // The whole body, not just the code: a different message would be the oracle
  // the shared status was chosen to avoid.
  assert.equal(left, right);
  assert.match(left, /"ABSTRACT_NOT_FOUND"/);
  // And the foreign event's title never appears in the refusal.
  assert.equal(right.includes("Someone else's talk"), false);
  assert.equal(right.includes("Other Conf"), false);

  // Neither reached the provider, so a cross-event probe cannot even be
  // observed as a cost or a latency difference at the model.
  assert.deepEqual(missing.seen.assistantCalls, []);
  assert.deepEqual(foreign.seen.assistantCalls, []);
  // Both did read the comment table zero times: the refusal precedes it.
  assert.deepEqual(missing.seen.commentQueries, []);
  assert.deepEqual(foreign.seen.commentQueries, []);
});

test("409 for a proposal with no decision yet, on every undecided status", async () => {
  for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE", "WITHDRAWN"]) {
    const { post, seen } = harness({ abstract: { ...OWN_ABSTRACT, status } });
    const response = await post(request(VALID));
    assert.equal(response.status, 409, `${status} must be refused`);
    assert.equal((await envelope(response)).error?.code, "DECISION_NOT_MADE");
    assert.deepEqual(seen.assistantCalls, [], `${status} must not reach the provider`);
  }
  for (const status of ["ACCEPTED", "REJECTED"]) {
    const { post } = harness({ abstract: { ...OWN_ABSTRACT, status } });
    assert.equal((await post(request(VALID))).status, 200, `${status} must be allowed`);
  }
});

/* -------------------------------------------------------------------------- */
/* Body bound, strictness, and ordering                                       */
/* -------------------------------------------------------------------------- */

test("the body is strict, and a smuggled eventId is refused rather than ignored", async () => {
  const { post, seen } = harness();
  const response = await post(request({ ...VALID, eventId: "event-2" }));
  assert.equal(response.status, 422);
  assert.equal((await envelope(response)).error?.code, "VALIDATION_ERROR");
  assert.deepEqual(seen.abstractQueries, []);
  assert.deepEqual(seen.assistantCalls, []);
});

test("a body over the cap is refused with 413 before it is parsed", async () => {
  const { post, seen } = harness();
  const oversize = JSON.stringify({ abstractId: "x".repeat(DECISION_NOTE_MAX_BODY_BYTES), includeFeedback: true });
  assert.ok(oversize.length > DECISION_NOTE_MAX_BODY_BYTES);

  const response = await post(request(oversize));
  assert.equal(response.status, 413);
  assert.equal((await envelope(response)).error?.code, "REQUEST_TOO_LARGE");
  assert.deepEqual(seen.abstractQueries, []);
  assert.deepEqual(seen.assistantCalls, []);

  // A lying content-length is refused up front, before a byte is read.
  const lying = await post(
    request(VALID, { headers: { "Content-Type": "application/json", "Content-Length": String(DECISION_NOTE_MAX_BODY_BYTES + 1) } }),
  );
  assert.equal(lying.status, 413);
});

test("malformed JSON is a 400, not a 500", async () => {
  const { post } = harness();
  const response = await post(request("{ not json"));
  assert.equal(response.status, 400);
  assert.equal((await envelope(response)).error?.code, "INVALID_JSON");
});

test("the throttle is charged after auth and BEFORE the body is read or parsed", async () => {
  // Deliberate ordering: a caller who sends garbage still pays. If the body
  // were validated first, an attacker probing this endpoint could do so for
  // free by sending nothing valid, and the durable budget would never bind.
  const { post, seen } = harness();
  await post(request(VALID));
  assert.deepEqual(seen.order, ["auth", "rate", "findAbstract", "findComments", "assistant"]);

  // Proven, not merely ordered: an invalid body is charged too.
  const invalid = harness();
  const response = await invalid.post(request({ nonsense: true }));
  assert.equal(response.status, 422);
  assert.deepEqual(invalid.seen.rateCalls, [{ userId: ADMIN.userId, eventId: ADMIN.eventId }]);
  assert.deepEqual(invalid.seen.order, ["auth", "rate"]);

  // And a throttled caller never reaches the body, the database, or the model.
  const throttled = harness({ rateLimit: new ApiError(429, "ASSISTANT_RATE_LIMITED", "Too many draft requests.", undefined, 30) });
  const refusal = await throttled.post(request(VALID));
  assert.equal(refusal.status, 429);
  assert.equal(refusal.headers.get("Retry-After"), "30");
  assert.deepEqual(throttled.seen.abstractQueries, []);
  assert.deepEqual(throttled.seen.assistantCalls, []);
});

test("the event comes from the session, never from the request", async () => {
  const { post, seen } = harness();
  await post(request(VALID));
  assert.deepEqual(seen.rateCalls, [{ userId: "user-admin", eventId: "event-1" }]);
  // The lookup is pinned to the session's event, so a foreign row never
  // matches and its content is never read.
  assert.deepEqual(seen.abstractQueries[0]!.where, { id: "abstract-1", eventId: "event-1" });
});

/* -------------------------------------------------------------------------- */
/* The wire: exactly what is read, exactly what is sent                       */
/* -------------------------------------------------------------------------- */

test("the route reads exactly the allowed columns, and no identity column at all", async () => {
  const { post, seen } = harness();
  await post(request(VALID));

  // Asserted against an INLINE literal, not against the exported constant, so
  // widening the constant cannot silently widen the assertion with it.
  assert.deepEqual(seen.abstractQueries[0]!.select, {
    title: true,
    status: true,
    event: { select: { name: true } },
  });
  // Neither identifier is selected. The request already carries the id, and
  // scope is enforced by the where-clause — so "no proposal or event id is
  // selected into the provider projection" is a fact about the query.
  assert.equal("id" in seen.abstractQueries[0]!.select, false);
  assert.equal("eventId" in seen.abstractQueries[0]!.select, false);
  // And the scope really is in the clause instead.
  assert.deepEqual(seen.abstractQueries[0]!.where, { id: "abstract-1", eventId: "event-1" });
  assert.deepEqual(seen.commentQueries[0]!.select, { comment: true });
  assert.equal(seen.commentQueries[0]!.take, 50);
  assert.deepEqual(seen.commentQueries[0]!.where, { abstractId: "abstract-1", comment: { not: null } });

  // Named absences, because these are the columns sitting beside the ones above
  // in the same tables and each would be a real disclosure.
  const selects = JSON.stringify([seen.abstractQueries[0]!.select, seen.commentQueries[0]!.select]);
  for (const column of ["submitter", "speakers", "email", "reviewScores", "reviewerId", "userId", "score", "rubric", "user"]) {
    assert.equal(selects.includes(column), false, `no query may select ${column}`);
  }
});

test("the prompt carries a closed field set and bounded normalized comment excerpts", async () => {
  // A comment that itself contains a name, an address, and a score. The honest
  // claim is NOT that such text cannot reach the provider — it can, and the
  // organizer is told so — but that no SEPARATE identity, address, or score
  // field is ever added alongside it.
  const loaded = "Priya Nadar (priya@evaluators.demo) rated this 4.5/5 and wants more tooling detail.";
  const { post, seen } = harness({ comments: [{ comment: loaded }] });
  await post(request(VALID));

  const sent = seen.assistantCalls[0]!;
  const prompt = sent.input;

  // The closed projection: exactly these keys, nothing else, ever.
  const keys = [...prompt.matchAll(/^([a-z_0-9]+):/gm)].map(([, key]) => key);
  assert.deepEqual(keys, ["event_name", "proposal_title", "decision", "reviewer_comment_1"]);
  assert.match(prompt, /^event_name: Forward 2026$/m);
  assert.match(prompt, /^proposal_title: Backstage: Running a 3,000-Person Conference$/m);
  assert.match(prompt, /^decision: accepted$/m);

  // The normalized comment excerpt is present, including the parts that look like an
  // identity and a score. This is the truth the disclosure now states.
  assert.match(prompt, /reviewer_comment_1: Priya Nadar \(priya@evaluators\.demo\) rated this 4\.5\/5/);

  // What is absent is any field nobody chose to send. The abstract's own id,
  // the event id, and the caller's user id are all in scope in the handler and
  // none of them appears.
  for (const value of ["abstract-1", "event-1", "user-admin", "admin@scratch.test"]) {
    assert.equal(prompt.includes(value), false, `${value} must never reach the provider`);
    assert.equal(sent.instructions.includes(value), false, `${value} must not be in the instructions`);
  }

  // Declining feedback sends no comment at all, however loaded it is.
  const declined = harness({ comments: [{ comment: loaded }] });
  await declined.post(request({ ...VALID, includeFeedback: false }));
  const withoutFeedback = declined.seen.assistantCalls[0]!.input;
  assert.equal(withoutFeedback.includes("reviewer_comment"), false);
  assert.equal(withoutFeedback.includes("priya@evaluators.demo"), false);
  // But availability is still reported honestly.
  const body = await envelope(await harness({ comments: [{ comment: loaded }] }).post(request({ ...VALID, includeFeedback: false })));
  assert.deepEqual(body.data?.grounding, { commentsAvailable: 1, commentIndexesUsed: [] });
});

test("the request opts into the code-owned strict schema, with envelope headroom", async () => {
  const { post, seen } = harness();
  await post(request(VALID));
  const sent = seen.assistantCalls[0]!;

  // Inline literal again: the schema the provider is told to enforce.
  assert.deepEqual(sent.textFormat, {
    type: "json_schema",
    name: DECISION_NOTE_SCHEMA_NAME,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["draft"],
      properties: { draft: { type: "string" } },
    },
  });
  assert.equal(DECISION_NOTE_SCHEMA_NAME, "greenroom_decision_note");

  // Headroom: the ask must exceed the draft cap, or a 1,200-character note
  // would arrive with its closing brace truncated off and read as malformed.
  assert.equal(sent.maxOutputChars, DECISION_NOTE_REQUEST_MAX_OUTPUT_CHARS);
  assert.ok(
    DECISION_NOTE_REQUEST_MAX_OUTPUT_CHARS > DECISION_NOTE_MAX_DRAFT_CHARS + 32,
    "the request must leave room for the JSON envelope and its escaping",
  );
});

/* -------------------------------------------------------------------------- */
/* Structured output validation                                               */
/* -------------------------------------------------------------------------- */

test("a valid structured answer returns only the draft string, with no-store", async () => {
  const { post } = harness({ assistant: { ok: true, text: JSON.stringify({ draft: "  A warm note.  " }) } });
  const response = await post(request(VALID));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await envelope(response);
  assert.equal(body.ok, true);
  assert.equal(body.data?.draft, "A warm note.");
  assert.deepEqual(body.data?.grounding, { commentsAvailable: 1, commentIndexesUsed: [0] });
  // The raw provider text is not forwarded: the response carries the parsed
  // string, not the JSON envelope it arrived in.
  assert.equal(JSON.stringify(body).includes('{\\"draft\\"'), false);
});

test("malformed, empty, extra-key, overlong and MARKUP answers are all invalid_output", async () => {
  const cases: Array<[string, string]> = [
    ["not JSON at all", "A warm note."],
    ["a JSON array", JSON.stringify(["A warm note."])],
    ["a bare string", JSON.stringify("A warm note.")],
    ["null", JSON.stringify(null)],
    ["a missing draft key", JSON.stringify({ note: "A warm note." })],
    ["a non-string draft", JSON.stringify({ draft: 42 })],
    ["an empty draft", JSON.stringify({ draft: "" })],
    ["a whitespace-only draft", JSON.stringify({ draft: "   \n " })],
    ["an extra key", JSON.stringify({ draft: "A warm note.", confidence: 0.9 })],
    ["a truncated envelope", '{"draft":"A warm note.'],
    ["an overlong draft", JSON.stringify({ draft: "x".repeat(DECISION_NOTE_MAX_DRAFT_CHARS + 1) })],
    ["a script tag", JSON.stringify({ draft: '<script>alert(1)</script> Congratulations!' })],
    ["a link", JSON.stringify({ draft: 'Congratulations! <a href="https://evil.test">Confirm here</a>' })],
    ["benign bold", JSON.stringify({ draft: "We loved <strong>the structure</strong> of this one." })],
  ];

  for (const [label, text] of cases) {
    const { post } = harness({ assistant: { ok: true, text } });
    const response = await post(request(VALID));
    assert.equal(response.status, 502, `${label} must be refused`);
    const body = await envelope(response);
    assert.equal(body.error?.code, "ASSISTANT_INVALID_OUTPUT", label);
    assert.match(body.error!.message, /write the note yourself/i);
    // The unusable text never reaches the caller in any form.
    assert.equal(JSON.stringify(body).includes("confidence"), false, label);
  }

  // Exactly at the cap is accepted, so the boundary is a boundary.
  const atCap = harness({ assistant: { ok: true, text: JSON.stringify({ draft: "y".repeat(DECISION_NOTE_MAX_DRAFT_CHARS) }) } });
  const accepted = await atCap.post(request(VALID));
  assert.equal(accepted.status, 200);
  assert.equal((await envelope(accepted)).data?.draft.length, DECISION_NOTE_MAX_DRAFT_CHARS);
});

test("every provider failure reason maps to its own honest refusal", async () => {
  for (const [reason, status, code] of [
    ["disabled", 503, "ASSISTANT_DISABLED"],
    ["timeout", 504, "ASSISTANT_TIMEOUT"],
    ["rate_limited", 429, "ASSISTANT_BUSY"],
    ["provider_error", 502, "ASSISTANT_UNAVAILABLE"],
    ["invalid_output", 502, "ASSISTANT_INVALID_OUTPUT"],
  ] as Array<[string, number, string]>) {
    const { post } = harness({ assistant: { ok: false, reason: reason as never } });
    const response = await post(request(VALID));
    assert.equal(response.status, status, reason);
    const body = await envelope(response);
    assert.equal(body.error?.code, code, reason);
    // No fabricated note on any branch.
    assert.equal(body.data, undefined, reason);
    assert.equal(body.ok, false, reason);
  }
});
