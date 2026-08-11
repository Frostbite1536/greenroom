/**
 * Source contract for the B7 `/admin` dashboard.
 *
 * The folds themselves are covered by `dashboard/metrics.test.ts`. What is
 * pinned here is the wiring a unit test cannot see: that the page is a server
 * component with no client island, that it reads once through one batched
 * function rather than per card, that each card's number comes from the linked
 * page's own definition instead of a local reimplementation, and that the links
 * carry the parameters those pages actually read.
 *
 * Every regex is written newline-agnostically (`[\s\S]` rather than `.` across
 * lines, no `\n` literals) so a CRLF checkout does not fail these.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = () => source("app/(app)/admin/page.tsx");
const reads = () => source("lib/data/reads.ts");
const shell = () => source("components/app-shell.tsx");
const abstractsPage = () => source("app/(app)/admin/abstracts/page.tsx");
const abstractsTable = () => source("components/abstracts-table.tsx");

/**
 * The `getAdminDashboard` body, so assertions cannot match a neighbouring read.
 *
 * Bounded at the next `// ---- ` section marker rather than running to the end
 * of the file: `getAdminReports` was added directly below (D-C5-16 #4) and an
 * unbounded slice counted its awaits as the dashboard's.
 */
function dashboardRead(): string {
  const file = reads();
  const start = file.indexOf("export async function getAdminDashboard()");
  assert.notEqual(start, -1, "getAdminDashboard must exist in lib/data/reads.ts");
  const next = file.indexOf("// ---- ", start);
  return next === -1 ? file.slice(start) : file.slice(start, next);
}

test("the dashboard page is a server component with no client island", () => {
  const component = page();
  assert.equal(component.includes('"use client"'), false);
  // Counts and links are not interactive; no hook may sneak in.
  assert.equal(/\buseState\b|\buseEffect\b|\buseMemo\b|\buseRouter\b/.test(component), false);
  assert.match(component, /export default async function AdminDashboardPage\(\)/);
  assert.match(component, /export const dynamic = "force-dynamic";/);
});

test("the page reads once, through the one batched data function", () => {
  const component = page();
  assert.match(component, /const view = await getAdminDashboard\(\);/);
  // Exactly one await in the page body: a second would be a per-card waterfall.
  assert.equal((component.match(/await /g) ?? []).length, 1);
  // The page never reaches for Prisma itself.
  assert.equal(/@\/lib\/prisma|prisma\./.test(component), false);
});

test("getAdminDashboard batches its reads and is ADMIN-only", () => {
  const read = dashboardRead();
  assert.match(read, /const ctx = await pageContext\(\["ADMIN"\]\);/);
  assert.match(read, /\] = await Promise\.all\(\[/);
  // One batch, not a chain: the only awaits are the context and the batch.
  assert.equal((read.match(/await /g) ?? []).length, 2);
});

test("every read in the dashboard batch is event-scoped (INV-EVENT-001)", () => {
  const read = dashboardRead();
  const batchStart = read.indexOf("] = await Promise.all([");
  const batch = read.slice(batchStart, read.indexOf("  ]);", batchStart));
  const queries = batch.match(/prisma\.\w+\.\w+\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(queries.length >= 7, `expected the batched prisma reads, found ${queries.length}`);
  for (const query of queries) {
    assert.ok(
      /eventId/.test(query) || /plan: \{ eventId \}/.test(query) || /abstractWhere/.test(query),
      `a batched read is not event-scoped: ${query.slice(0, 90)}`,
    );
  }
  // The two nested reads carry their own scoping and their own inner batch.
  assert.match(read, /getAgendaData\(\),/);
  assert.match(read, /readSpeakerRoster\(eventId\),/);
});

test("the funnel reuses the abstracts page's own filter and grouping", () => {
  const read = dashboardRead();
  // The same where-clause getAdminAbstracts counts its metric strip from.
  assert.match(read, /const abstractWhere = adminAbstractListWhere\(\{ eventId \}\);/);
  assert.match(read, /prisma\.abstract\.groupBy\(\{ by: \["status"\], where: abstractWhere/);
  assert.match(read, /funnel: summarizeAbstractFunnel\(funnelGroups\)/);
});

test("conflicts come from the agenda's own detector, never reimplemented here", () => {
  const read = dashboardRead();
  assert.match(read, /findConflicts\(agenda\.sessions, roomName\)\.length/);
  // No local overlap maths anywhere in the dashboard read or its page.
  for (const [name, text] of [["reads", dashboardRead()], ["page", page()]] as const) {
    assert.equal(
      /startsAt[\s\S]{0,40}<[\s\S]{0,40}endsAt/.test(text),
      false,
      `${name} must not recompute interval overlap`,
    );
  }
  // The pure fold takes a conflict count as a parameter; it never calls the
  // detector itself (the name appears only in its prose, explaining why).
  assert.equal(/findConflicts\(/.test(source("lib/dashboard/metrics.ts")), false,
    "the pure fold takes a conflict count, it does not derive one");
  assert.match(source("lib/dashboard/metrics.ts"), /conflicts: number,/);
});

test("round progress uses the evaluation screen's own fold, withdrawn excluded", () => {
  const read = dashboardRead();
  // The dashboard excludes withdrawn work inside the groupBy itself — a
  // materialized id set would need a cap, and a capped set consumed as
  // complete silently counts withdrawn assignments as active above the cap.
  assert.match(read, /abstract: \{ status: \{ not: "WITHDRAWN" \} \}/);
  assert.match(read, /summarizeRoundTotals\(assignmentGroups, \(\) => false\)/);
  // getEvaluationSetup must fold the same rows through the same helper, or the
  // two screens can drift. It already holds every abstract row, so its skip
  // predicate is the id set it materialized anyway.
  const setup = reads();
  assert.match(setup, /const planTotals = summarizeRoundTotals\(byAbstract, \(id\) => withdrawnAbstractIds\.has\(id\)\);/);
});

test("\"unscheduled accepted\" means the abstracts table's own programme rule", () => {
  const read = dashboardRead();
  // No confirmed talk yet, OR a talk holding no slot — both gaps counted, which
  // is what `sessionScheduled` reports on the abstracts row.
  assert.match(
    read,
    /status: "ACCEPTED",[\s\S]{0,160}OR: \[\{ session: \{ is: null \} \}, \{ session: \{ scheduleSlot: \{ is: null \} \} \}\]/,
  );
});

test("speaker numbers come from the roster read the roster page uses", () => {
  const read = dashboardRead();
  assert.match(read, /readSpeakerRoster\(eventId\)/);
  assert.match(read, /onboardingComplete: roster\.summary\.onboardingComplete/);
  assert.match(read, /overdue: roster\.summary\.speakersOverdue/);
  // The roster page must be on the same read, or the two can disagree.
  const roster = source("app/(app)/admin/speakers/page.tsx");
  assert.match(roster, /readSpeakerRoster\(eventId\),/);
  // Matched by key rather than against the whole destructure, so the shared read
  // may gain a field only one screen needs (`decks`) without this test having to
  // be edited to keep passing. The property asserted is that these four are
  // taken from the shared read and NOT re-derived on the page.
  const destructure = roster.match(/const \{([^}]*)\} = roster;/);
  assert.ok(destructure, "the roster page must destructure the shared read");
  const keys = destructure[1].split(",").map((key) => key.trim());
  for (const key of ["rows", "summary", "awaitingSession", "truncated"]) {
    assert.ok(keys.includes(key), `${key} must come from the shared roster read`);
  }
});

test("recent activity is bounded and deep-links through the canonical permalink", () => {
  const read = dashboardRead();
  assert.match(reads(), /export const DASHBOARD_ACTIVITY_TAKE = 5;/);
  assert.equal((read.match(/take: DASHBOARD_ACTIVITY_TAKE,/g) ?? []).length, 2);
  // Newest first, with a stable tie-break so two rows sharing an instant cannot
  // reshuffle between renders.
  assert.match(read, /orderBy: \[\{ submittedAt: "desc" \}, \{ id: "desc" \}\]/);
  assert.match(read, /orderBy: \[\{ decidedAt: "desc" \}, \{ id: "desc" \}\]/);
  // `?abstract=` (PR #88) rather than a hand-built query string. The row
  // projection sits just above `getAdminDashboard`, so this looks at the file.
  assert.match(reads(), /href: abstractPermalink\(row\.id\)/);
  assert.equal(/\?abstractId=/.test(read), false);
  assert.equal(/\?abstract(Id)?=/.test(page()), false, "the page must not hand-build a permalink");
});

test("the funnel's links preselect a chip the abstracts page really reads", () => {
  // Rendered from the segment's own href, not a string built at the call site.
  assert.match(page(), /<Link href=\{segment\.href\}>/);
  // The page resolves `?status=` server-side and hands it to the table, so the
  // FIRST response already carries the pressed chip.
  assert.match(abstractsPage(), /const initialStatusFilter = parseAbstractStatusFilter\(params\.status\);/);
  assert.match(abstractsPage(), /initialStatusFilter=\{initialStatusFilter\}/);
  assert.match(abstractsTable(), /const \[tab, setTab\] = useState<AbstractStatusFilter>\(initialStatusFilter\);/);
  // One vocabulary: the table renders the shared chips rather than its own copy.
  assert.match(abstractsTable(), /const TABS = ABSTRACT_STATUS_TABS;/);
});

test("the sidebar entry is ADMIN-only and leads the admin group", () => {
  const nav = shell();
  const start = nav.indexOf("const navigation:");
  const list = nav.slice(start, nav.indexOf("];", start));
  assert.match(list, /\{ href: "\/admin", label: "Dashboard", icon: Gauge, roles: \["ADMIN"\], group: "overview" \}/);
  // First entry in the list, ahead of every workspace it links into, and first
  // inside the first group the sidebar renders.
  assert.match(shell(), /\{ key: "overview", label: "Overview" \}/);
  const entries = list.match(/href: "[^"]+"/g) ?? [];
  assert.equal(entries[0], 'href: "/admin"');
});

test("a fresh event gets an actionable empty state per card, not a wall of zeroes", () => {
  const component = page();
  for (const title of ["No CFP form yet", "No review round yet", "No talks yet", "No speakers yet"]) {
    assert.ok(component.includes(title), `missing zero-state: ${title}`);
  }
  // Each empty state names the thing to create and links to where to create it.
  assert.match(component, /<Link href="\/admin\/forms">Create your first form<\/Link>/);
  assert.match(component, /<Link href="\/admin\/evaluations">Create the first round<\/Link>/);
  assert.match(component, /<Link href="\/admin\/speakers">add one to the roster<\/Link>/);
  // A published-form check, so "no proposals" distinguishes an unopened call
  // from an open one nobody has answered.
  assert.match(component, /forms\.published === 0 \? \(/);
});

test("bounded programme figures are rendered as floors, never as totals", () => {
  const component = page();
  assert.match(component, /import \{ boundedCount, boundedCountLabel \} from "@\/lib\/bounded-count";/);
  assert.match(component, /boundedCount\(programme\.scheduled, programme\.truncated\)/);
  assert.match(component, /boundedCountLabel\(programme\.conflicts, programme\.truncated, "scheduling conflict"\)/);
  // And the page says so in words when the read was cut.
  assert.match(component, /\{programme\.truncated \? \([\s\S]{0,400}is a floor/);
});
