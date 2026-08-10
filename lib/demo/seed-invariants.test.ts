import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { unknownTemplateVariables } from "@/lib/comms/template-edit";
import { CFP_SUBMITTED_TEMPLATE_KEY } from "@/lib/comms/notifications";
import {
  DEMO_EMAIL_TEMPLATES,
  DEMO_EVENT,
  DEMO_EVENT_DATES,
  DEMO_REVIEW_COMMENTS,
  DEMO_REVIEW_PROFILES,
  DEMO_RUBRIC_WEIGHTS,
  DEMO_SEED_PERSONAS,
  DEMO_STATUS_PLAN,
  DEMO_TALKS,
  DEMO_TASK_SCHEDULE,
  HEADLINE_SPEAKER_PROFILES,
  demoFormatIndex,
  demoReviewComment,
  demoSchedulePlan,
  demoWeightedMean,
} from "./seed";
import { DEMO_PERSONAS } from "@/lib/auth";
import { zonedParts, zonedToUtcIso } from "@/lib/tz";

const seedSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "seed.ts"),
  "utf8",
);

test("the seeded task schedule is ordered and completes before the May 12–14 event", () => {
  assert.deepEqual(DEMO_EVENT_DATES, { startsOn: "2026-05-12", endsOn: "2026-05-14" });
  assert.equal(DEMO_TASK_SCHEDULE.length, 6);
  assert.deepEqual(
    DEMO_TASK_SCHEDULE.map((task) => task.dueDate),
    ["2026-04-17", "2026-04-24", "2026-05-01", "2026-05-04", "2026-05-06", "2026-05-11"],
  );
  assert.ok(DEMO_TASK_SCHEDULE.every((task) => task.dueDate < DEMO_EVENT_DATES.startsOn));

  const eventStart = zonedParts(zonedToUtcIso(DEMO_EVENT_DATES.startsOn, "00:00", DEMO_EVENT.timezone), DEMO_EVENT.timezone);
  const eventEnd = zonedParts(zonedToUtcIso(DEMO_EVENT_DATES.endsOn, "23:59", DEMO_EVENT.timezone), DEMO_EVENT.timezone);
  assert.deepEqual(eventStart, { dateKey: DEMO_EVENT_DATES.startsOn, hour: 0, minute: 0, minutesOfDay: 0 });
  assert.deepEqual(eventEnd, { dateKey: DEMO_EVENT_DATES.endsOn, hour: 23, minute: 59, minutesOfDay: 23 * 60 + 59 });

  for (const task of DEMO_TASK_SCHEDULE) {
    const local = zonedParts(zonedToUtcIso(task.dueDate, "23:59", DEMO_EVENT.timezone), DEMO_EVENT.timezone);
    assert.equal(local.dateKey, task.dueDate);
    assert.equal(local.minutesOfDay, 23 * 60 + 59);
  }
});

test("the seeded communications include a dedicated submission record and no false global task deadline", () => {
  assert.deepEqual(
    DEMO_EMAIL_TEMPLATES.map((template) => template.key),
    [CFP_SUBMITTED_TEMPLATE_KEY, "cfp-accepted", "cfp-rejected", "task-reminder", "session-scheduled"],
  );
  assert.equal(new Set(DEMO_EMAIL_TEMPLATES.map((template) => template.key)).size, DEMO_EMAIL_TEMPLATES.length);

  for (const template of DEMO_EMAIL_TEMPLATES) {
    assert.deepEqual(unknownTemplateVariables(template.subject, template.htmlBody), [], template.key);
  }
  const reminder = DEMO_EMAIL_TEMPLATES.find((template) => template.key === "task-reminder");
  assert.ok(reminder);
  assert.doesNotMatch(reminder.htmlBody, /{{\s*dueDate\s*}}/);
  assert.match(reminder.htmlBody, /individual deadline/i);
});

test("the seeded persona identities are exactly the auth personas, on the deliverable domain", () => {
  // A signed session resolves to a `User` by email (lib/auth.ts
  // getResolvedSession), so the seed and the cookie must agree byte for byte or
  // every one-click button bounces back to /login with no visible error. Asserted
  // in BOTH directions: an address added on either side alone fails here.
  const seeded = Object.entries(DEMO_SEED_PERSONAS)
    .map(([key, persona]) => [key, persona.email, persona.name] as const)
    .sort();
  const signedIn = Object.entries(DEMO_PERSONAS)
    .map(([key, persona]) => [key, persona.user.email, persona.user.name] as const)
    .sort();
  assert.deepEqual(seeded, signedIn);

  for (const [key, email] of seeded) {
    assert.equal(email, email.toLowerCase(), `${key} must already be normalized`);
    // C5: personas moved off the non-routable `@greenroom.demo` so a live send
    // reaches a real inbox. Every other seeded address stays undeliverable.
    assert.ok(email.endsWith("@greenroom-hq.com"), `${key} must use the deliverable demo domain`);
  }
});

test("every seeded proposal has its own title, and there are still exactly 40 of them", () => {
  // The count is a published contract — the judging docs, the install rehearsal
  // and the reset summary all say "40 abstracts" — so the two must not drift.
  const planned = DEMO_STATUS_PLAN.reduce((total, bucket) => total + bucket.count, 0);
  assert.equal(planned, 40);
  assert.equal(DEMO_TALKS.length, planned, "one authored talk per seeded proposal");

  // The old generator produced 15 distinct strings for 40 rows, so the pipeline
  // showed the same handful of talks over and over.
  const titles = DEMO_TALKS.map((talk) => talk.title);
  assert.equal(new Set(titles).size, titles.length, "no two proposals may share a title");
  assert.equal(new Set(DEMO_TALKS.map((talk) => talk.topic)).size, titles.length);
  for (const talk of DEMO_TALKS) {
    assert.ok(talk.title.trim().length > 12, `${talk.title} is too thin to read as a real talk`);
    assert.equal(talk.topic, talk.topic.trimEnd());
  }
});

test("format does not move in lockstep with category, so every pairing occurs", () => {
  // Category is `index % 4`. When the format was too, every Security & Trust
  // proposal was a ten-minute lightning talk and every Product & Design one a
  // 90-minute workshop.
  const pairs = new Set<string>();
  for (let index = 0; index < DEMO_TALKS.length; index++) {
    pairs.add(`${index % 4}:${demoFormatIndex(index)}`);
  }
  assert.equal(pairs.size, 16, "all four categories must appear in all four formats");
});

test("the seeded rubric scores span a real range and include a split decision", () => {
  // The weights this test averages with must be the weights the seed stores.
  assert.deepEqual([...DEMO_RUBRIC_WEIGHTS], [1.5, 1, 1, 1]);

  const decided = DEMO_STATUS_PLAN
    .filter((bucket) => bucket.status === "ACCEPTED" || bucket.status === "REJECTED")
    .reduce((total, bucket) => total + bucket.count, 0);
  assert.equal(DEMO_REVIEW_PROFILES.length, decided, "one verdict per decided proposal");

  const round = (value: number) => Math.round(value * 100) / 100;
  const summary = DEMO_REVIEW_PROFILES.map((profile) => {
    assert.equal(profile.length, 3, "one row per seeded evaluator");
    const perEvaluator = profile.map((scores) => {
      assert.equal(scores.length, DEMO_RUBRIC_WEIGHTS.length);
      for (const score of scores) {
        assert.ok(Number.isInteger(score) && score >= 1 && score <= 5, `score ${score} is off the rubric`);
      }
      return demoWeightedMean(scores);
    });
    return {
      mean: round(perEvaluator.reduce((a, b) => a + b, 0) / perEvaluator.length),
      spread: Math.max(...perEvaluator) - Math.min(...perEvaluator),
    };
  });

  // Before this table, every accepted proposal scored exactly 4.48 and every
  // rejected one exactly 2.48.
  const means = summary.map((s) => s.mean);
  assert.equal(new Set(means).size, means.length, "no two proposals may score identically");
  assert.ok(Math.min(...means) <= 2.1, `lowest verdict was ${Math.min(...means)}`);
  assert.ok(Math.max(...means) >= 4.7, `highest verdict was ${Math.max(...means)}`);

  // A genuine borderline: the weakest accept scores BELOW the strongest reject,
  // which is what a committee call that went beyond the rubric looks like.
  const accepted = means.slice(0, 12);
  const rejected = means.slice(12);
  assert.ok(
    Math.min(...accepted) < Math.max(...rejected),
    "the accept line must not be a clean score threshold",
  );

  // And at least one proposal where the reviewers genuinely disagreed.
  assert.ok(
    summary.filter((s) => s.spread >= 1.5).length >= 1,
    "at least one decision must show reviewers disagreeing",
  );
});

test("reviewer comments are ten distinct sentences, each matched to its own score", () => {
  const pools = [DEMO_REVIEW_COMMENTS.positive, DEMO_REVIEW_COMMENTS.mixed, DEMO_REVIEW_COMMENTS.critical];
  const all = pools.flat();
  assert.equal(all.length, 10);
  assert.equal(new Set(all).size, 10, "the seed used to write two comments site-wide");
  for (const comment of all) {
    const sentences = comment.split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(sentences.length >= 1 && sentences.length <= 2, `${comment} is not one or two sentences`);
    assert.match(comment, /[.!?]$/);
  }

  // Walk the seed's own loop: every comment gets used, and none is attached to
  // a reviewer whose score contradicts it.
  const used = new Set<string>();
  for (const [decidedIndex, profile] of DEMO_REVIEW_PROFILES.entries()) {
    for (const [evaluatorIndex, scores] of profile.entries()) {
      const comment = demoReviewComment(scores, decidedIndex, evaluatorIndex);
      used.add(comment);
      const mean = demoWeightedMean(scores);
      const expected = mean >= 4 ? DEMO_REVIEW_COMMENTS.positive
        : mean >= 3 ? DEMO_REVIEW_COMMENTS.mixed
          : DEMO_REVIEW_COMMENTS.critical;
      assert.ok(
        (expected as readonly string[]).includes(comment),
        `a reviewer scoring ${mean.toFixed(2)} was given "${comment}"`,
      );
    }
  }
  assert.equal(used.size, 10, "every authored comment must actually appear in the demo");
});

test("every publicly listed speaker has their own title, company and bio", () => {
  // The public gallery shows the speakers on a scheduled session: the keynote
  // plus the first ten accepted proposals, i.e. pool positions 0-9. All ten
  // used to read "Staff Engineer at Acme Labs" with one shared bio sentence.
  const placed = demoSchedulePlan();
  const publicSpeakers = new Set(placed.map((p) => p.speakerPoolIndex));
  assert.equal(HEADLINE_SPEAKER_PROFILES.length, 10);
  for (const poolIndex of publicSpeakers) {
    assert.ok(
      HEADLINE_SPEAKER_PROFILES[poolIndex],
      `pool position ${poolIndex} reaches the public gallery with no authored profile`,
    );
  }

  const fields = ["jobTitle", "company", "bio"] as const;
  for (const field of fields) {
    const values = HEADLINE_SPEAKER_PROFILES.map((profile) => profile[field]);
    assert.equal(new Set(values).size, values.length, `two headline speakers share a ${field}`);
  }
  for (const profile of HEADLINE_SPEAKER_PROFILES) {
    // The bio is rendered as `${name} ${bio}`, so it must continue a sentence.
    assert.match(profile.bio, /^[a-z]/, `"${profile.bio}" does not follow a speaker's name`);
    assert.match(profile.bio, /\.$/);
    assert.ok(!/Acme Labs/.test(profile.company));
  }
});

test("the seeded programme is conflict-free and uses all three event days", () => {
  const plan = demoSchedulePlan();
  assert.equal(plan.length, 11, "the placement count is quoted in the judging docs");

  // Every placement is a real instant inside the event, on the hour.
  const placed = plan.map((placement) => {
    const startIso = zonedToUtcIso(placement.day, `${String(placement.hour).padStart(2, "0")}:00`, DEMO_EVENT.timezone);
    const startsAt = Date.parse(startIso);
    assert.ok(Number.isFinite(startsAt), `${placement.day} ${placement.hour} did not resolve`);
    assert.ok(placement.durationMinutes > 0);
    assert.ok(
      placement.day >= DEMO_EVENT_DATES.startsOn && placement.day <= DEMO_EVENT_DATES.endsOn,
      `${placement.day} is outside the event`,
    );
    return { ...placement, startsAt, endsAt: startsAt + placement.durationMinutes * 60_000 };
  });

  // Day 3 used to be empty on a three-day event.
  const days = new Set(placed.map((p) => p.day));
  assert.equal(days.size, 3, `the programme only covers ${[...days].join(", ")}`);
  assert.ok(days.has(DEMO_EVENT_DATES.endsOn), "the last day must not be empty");

  // The seed used to ship a DELIBERATE room double-booking — the keynote's own
  // slot, re-used. It no longer does, and this is what holds that.
  const overlaps = (a: (typeof placed)[number], b: (typeof placed)[number]) =>
    a.startsAt < b.endsAt && b.startsAt < a.endsAt;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const [a, b] = [placed[i], placed[j]];
      if (!overlaps(a, b)) continue;
      assert.notEqual(a.roomKey, b.roomKey, `${a.roomKey} is double-booked on ${a.day}`);
      assert.notEqual(
        a.speakerPoolIndex, b.speakerPoolIndex,
        `speaker ${a.speakerPoolIndex} is in two rooms at once on ${a.day}`,
      );
    }
  }
  assert.equal(new Set(placed.map((p) => p.sessionIndex)).size, placed.length, "a session is placed once");

  // The walkthrough is scripted against this programme: it schedules into an
  // occupied slot to demonstrate the refusal, then into a free one. Both of
  // those placements are named verbatim in docs/judging/VIDEO-SCRIPT.md.
  assert.ok(
    placed.some((p) => p.day === "2026-05-12" && p.hour === 10 && p.roomKey === "hall-a"),
    "Hall A, 12 May 10:00 must stay occupied — the walkthrough's refusal depends on it",
  );
  assert.ok(
    !placed.some((p) => p.day === DEMO_EVENT_DATES.endsOn && p.roomKey === "ballroom"),
    "the Grand Ballroom must stay free on the last day — the walkthrough places there",
  );
});

test("the persona address migration renames the pre-C5 rows rather than orphaning them", () => {
  // `User.email` is unique, so changing the constant without this rename would
  // create a second row and strand the original with the persona's
  // SpeakerProfile. The rename must therefore stay wired to the live constants.
  assert.match(seedSource, /const PERSONA_EMAIL_MIGRATIONS = \[/);
  for (const [key, email] of Object.entries(DEMO_SEED_PERSONAS).map(([k, p]) => [k, p.email] as const)) {
    const local = email.split("@")[0];
    assert.match(
      seedSource,
      new RegExp(`from: "${local}@greenroom\\.demo", to: PERSONAS\\.\\w+\\.email`),
      `${key} needs a migration off its pre-C5 address`,
    );
  }
  // It runs before the upserts, or the upsert would already have created the
  // duplicate the rename exists to prevent.
  assert.ok(
    seedSource.indexOf("for (const { from, to } of PERSONA_EMAIL_MIGRATIONS)") <
      seedSource.indexOf("const adminId = await upsertUser("),
    "the migration must run before the persona upserts",
  );
  // And it never deletes an identity to resolve a collision.
  assert.doesNotMatch(seedSource, /db\.user\.delete/);
});
