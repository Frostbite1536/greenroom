/**
 * Source contract for the `/admin/reports` page and its three CSV exports
 * (D-C5-16 #4).
 *
 * The folds are covered by `reports/metrics.test.ts` and the documents by
 * `services/reports-export-csv.test.ts`. What is pinned here is the wiring a
 * unit test cannot see: that the page is a server component reading once
 * through one batched function, that every number borrows a definition its
 * owning screen already enforces instead of reimplementing it, that the page is
 * a *different* report from the `/admin` dashboard rather than a second copy of
 * it, and that each export route is ADMIN-only, bounded, and projects nothing
 * wider than the screen it exports.
 *
 * Every regex is written newline-agnostically (`[\s\S]` rather than `.` across
 * lines, no `\n` literals) so a CRLF checkout does not fail these.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));
/** Comment text stripped, so "this file never says X" is asserted against code. */
const code = (path: string) =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");
const page = () => source("app/(app)/admin/reports/page.tsx");
const reads = () => source("lib/data/reads.ts");
const shell = () => source("components/app-shell.tsx");
const metrics = () => source("lib/reports/metrics.ts");

const EXPORT_ROUTES = [
  "app/api/admin/speakers/export/route.ts",
  "app/api/admin/sessions/export/route.ts",
  "app/api/admin/schedule/export/route.ts",
];

/**
 * The `getAdminReports` body, so assertions cannot match a neighbouring read.
 * Bounded at the next `// ---- ` section marker, like the dashboard's own
 * source test: a slice running to the end of the file silently absorbs the next
 * read that gets appended below it.
 */
function reportsRead(): string {
  const file = reads();
  const start = file.indexOf("export async function getAdminReports()");
  assert.notEqual(start, -1, "getAdminReports must exist in lib/data/reads.ts");
  const next = file.indexOf("// ---- ", start);
  return next === -1 ? file.slice(start) : file.slice(start, next);
}

// ---- the page --------------------------------------------------------------

test("the reports page is a server component with no client island", () => {
  const component = page();
  assert.equal(component.includes('"use client"'), false);
  assert.equal(/\buseState\b|\buseEffect\b|\buseMemo\b|\buseRouter\b/.test(component), false);
  assert.match(component, /export default async function AdminReportsPage\(\)/);
  assert.match(component, /export const dynamic = "force-dynamic";/);
});

test("the page reads once, through the one batched data function", () => {
  const component = page();
  assert.match(component, /const view = await getAdminReports\(\);/);
  // Exactly one await in the page body: a second would be a per-section waterfall.
  assert.equal((component.match(/await /g) ?? []).length, 1);
  assert.equal(/@\/lib\/prisma|prisma\./.test(component), false);
});

test("no loading boundary is introduced for the new segment", () => {
  // D-C5-11 #4 as amended: a segment loading boundary streams 200 before the
  // page's redirect() runs, which would break this page's own 307 refusal.
  assert.equal(exists("app/(app)/admin/reports/loading.tsx"), false);
});

test("getAdminReports batches its reads and is ADMIN-only", () => {
  const read = reportsRead();
  assert.match(read, /const ctx = await pageContext\(\["ADMIN"\]\);/);
  assert.match(read, /\] =[\s\S]{0,40}await Promise\.all\(\[/);
  // One batch, not a chain: the only awaits are the context and the batch.
  assert.equal((read.match(/await /g) ?? []).length, 2);
});

test("every read in the reports batch is event-scoped (INV-EVENT-001)", () => {
  const read = reportsRead();
  const batchStart = read.indexOf("await Promise.all([");
  const batch = read.slice(batchStart, read.indexOf("    ]);", batchStart));
  const queries = batch.match(/prisma\.\w+\.\w+\(\{[\s\S]*?\n      \}\)/g) ?? [];
  assert.ok(queries.length >= 4, `expected the batched prisma reads, found ${queries.length}`);
  for (const query of queries) {
    assert.ok(
      /eventId/.test(query) || /plan: \{ eventId \}/.test(query) || /abstractWhere/.test(query),
      `a batched read is not event-scoped: ${query.slice(0, 90)}`,
    );
  }
  // The two nested reads carry their own scoping and their own inner batch.
  assert.match(read, /readAgendaData\(eventId\),/);
  assert.match(read, /readSpeakerRoster\(eventId\),/);
});

test("the category funnel counts the abstracts table's own population", () => {
  const read = reportsRead();
  assert.match(read, /const abstractWhere = adminAbstractListWhere\(\{ eventId \}\);/);
  assert.match(read, /by: \["categoryId", "status"\],[\s\S]{0,60}where: abstractWhere/);
  assert.match(read, /funnel: summarizeCategoryFunnel\(categoryGroups, categories\)/);
  // Chip labels and order come from the shared vocabulary, not a local list.
  assert.match(metrics(), /from "@\/lib\/abstract-status"/);
  assert.match(page(), /FUNNEL_COLUMNS\.map/);
});

test("review load excludes withdrawn work, exactly as the evaluations screen does", () => {
  const read = reportsRead();
  assert.match(
    read,
    /where: \{ plan: \{ eventId \}, abstract: \{ status: \{ not: "WITHDRAWN" \} \} \}/,
  );
  // The same clause getEvaluationSetup applies to its own per-evaluator groupBy.
  assert.match(
    reads(),
    /where: \{ plan: \{ eventId: ctx\.eventId \}, abstract: \{ status: \{ not: "WITHDRAWN" \} \} \}/,
  );
});

test("the review section exposes no score and no per-abstract identity", () => {
  // The blind-review boundary: a reviewer may be counted, never linked.
  for (const [name, text] of [["read", reportsRead()], ["page", page()], ["fold", metrics()]] as const) {
    for (const leak of [/reviewScore/, /rubric/i, /myScores/, /abstractId/]) {
      assert.doesNotMatch(text, leak, `${name} must not reach for review detail`);
    }
  }
  // Not even the evaluator's email enters the projection.
  assert.doesNotMatch(reportsRead(), /user: \{ select: \{ name: true, email: true \} \}/);
  assert.match(reportsRead(), /select: \{ userId: true, user: \{ select: \{ name: true \} \} \}/);
});

test("schedule utilization rides the agenda's own read and day keys", () => {
  const read = reportsRead();
  assert.match(read, /readAgendaData\(eventId\)/);
  assert.match(read, /placementDayKeys\(event\?\.startsAt \?\? null, event\?\.endsAt \?\? null, timezone\)/);
  // No interval maths on the page: the fold owns it, and it is unit-tested.
  assert.equal(
    /startsAt[\s\S]{0,40}<[\s\S]{0,40}endsAt/.test(page()),
    false,
    "the page must not recompute slot intervals",
  );
  assert.match(read, /agendaTruncated: agenda\.truncated/);
});

test("readiness is the roster's own cohort, folded by the roster's own rules", () => {
  const read = reportsRead();
  assert.match(read, /summarizeSpeakerReadiness\(roster\.rows, roster\.confirmed\)/);
  // The ladder reads the stored row's flags rather than restating the rules.
  assert.match(metrics(), /if \(row\.onboardingComplete\) return "ready";/);
  assert.match(metrics(), /row\.requiredOutstanding\.length > 0 \? "onboarding" : "profile"/);
  assert.match(read, /rosterTruncated: roster\.truncated/);
});

test("the reports page is a different report, not a second dashboard", () => {
  const component = page();
  const dashboard = source("app/(app)/admin/page.tsx");
  // Every card heading on the dashboard, none of which may reappear here.
  for (const heading of [
    ">Call for proposals<", ">Review progress<", ">Programme<", ">Speakers<",
    "Latest submissions", "Latest decisions",
  ]) {
    assert.ok(dashboard.includes(heading), `dashboard heading moved: ${heading}`);
    assert.ok(!component.includes(heading), `reports duplicates the dashboard card: ${heading}`);
  }
  // And it does not re-read the dashboard's own batched projection.
  assert.equal(/getAdminDashboard/.test(component), false);
});

test("bounded reads are reported as floors rather than silently short", () => {
  const component = page();
  for (const flag of ["view.reviewersTruncated", "view.agendaTruncated", "view.rosterTruncated"]) {
    assert.ok(component.includes(flag), `missing truncation notice for ${flag}`);
  }
  assert.match(reportsRead(), /assertEventQueryBound\(categories, OPERATOR_QUERY_LIMITS\.settingsCategories/);
  assert.match(reportsRead(), /take: OPERATOR_QUERY_LIMITS\.reviewerSetupMembers \+ 1/);
});

test("a fresh event gets an actionable empty state per section, not a wall of zeroes", () => {
  const component = page();
  for (const title of ["No proposals yet", "No reviewers yet", "Nothing is placed yet", "No speakers yet"]) {
    assert.ok(component.includes(title), `missing zero-state: ${title}`);
  }
  assert.match(component, /<Link href="\/admin\/evaluations">Invite reviewers and assign a round<\/Link>/);
  assert.match(component, /<Link href="\/admin\/agenda">Place a talk in the agenda builder<\/Link>/);
});

test("the charts are an enhancement over the tables, never a replacement", () => {
  const component = page();
  // Every table this page shipped with is still rendered, above them or not.
  assert.equal((component.match(/className="data-table report-table"/g) ?? []).length, 3);
  for (const caption of [
    "Proposals by category and status, with acceptance rate",
    "Assigned, completed and outstanding reviews per reviewer",
    "Slots and minutes booked per room, by event day",
  ]) {
    assert.ok(component.includes(caption), `a table caption was dropped: ${caption}`);
  }
  // And the readiness section's list, which is that section's own table.
  assert.match(component, /<ul className="dashboard-list">[\s\S]*?readiness\.buckets\.map/);
  // The charts are pure geometry built from the folds already read — no second
  // read, no client island, and no chart dependency.
  assert.match(component, /from "@\/lib\/reports\/charts"/);
  assert.equal((component.match(/await /g) ?? []).length, 1);
  const chart = source("components/report-charts.tsx");
  assert.equal(chart.includes('"use client"'), false);
  assert.match(chart, /<svg[\s\S]{0,200}viewBox=\{`0 0 100 \$\{TRACK_HEIGHT\}`\}/);
  assert.match(chart, /role="img"[\s\S]{0,40}aria-label=\{chart\.ariaLabel\}/);
});

test("no charting dependency was added for them", () => {
  const manifest = JSON.parse(source("package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@prisma/client",
    "lucide-react",
    "next",
    "react",
    "react-dom",
    "zod",
  ]);
  // Every fill is a theme token, so a palette change moves the charts with it.
  const styles = source("app/globals.css");
  const palette = styles.slice(styles.indexOf("--chart-strong:"), styles.indexOf("--chart-track:"));
  assert.doesNotMatch(palette, /#[0-9a-f]{3,8}/i, "a chart colour is a literal, not a token");
  assert.doesNotMatch(source("components/report-charts.tsx"), /#[0-9a-f]{3,8}/i);
});

test("the sidebar entry is ADMIN-only and sits directly after the dashboard", () => {
  const nav = shell();
  const start = nav.indexOf("const navigation:");
  const list = nav.slice(start, nav.indexOf("];", start));
  assert.match(list, /\{ href: "\/admin\/reports", label: "Reports", icon: BarChart3, roles: \["ADMIN"\], group: "overview" \}/);
  const entries = list.match(/href: "[^"]+"/g) ?? [];
  assert.equal(entries[0], 'href: "/admin"');
  assert.equal(entries[1], 'href: "/admin/reports"');
});

// ---- the exports -----------------------------------------------------------

test("every export route is ADMIN-only and serves a no-store CSV attachment", () => {
  for (const path of EXPORT_ROUTES) {
    const route = source(path);
    assert.match(route, /const ctx = await requireContext\(\["ADMIN"\]\);/, path);
    assert.match(route, /"content-type": "text\/csv; charset=utf-8"/, path);
    assert.match(route, /"content-disposition": `attachment; filename="\$\{\w+ExportFilename\(\)\}"`/, path);
    assert.match(route, /"cache-control": "no-store"/, path);
    assert.match(route, /export const dynamic = "force-dynamic";/, path);
  }
});

test("no export route builds its own CSV or its own projection", () => {
  for (const path of EXPORT_ROUTES) {
    const route = source(path);
    // One escaper, one document assembler, both in the tested pure module.
    assert.match(route, /from "@\/lib\/services\/reports-export-csv"/, path);
    assert.equal(/join\(","\)/.test(route), false, `${path} assembles a row by hand`);
    assert.equal(/\\r\\n/.test(route), false, `${path} writes its own record separator`);
    // The reads are the screens' own reads, so an export cannot describe a
    // different population than the page an operator exported it from.
    assert.match(route, /readSpeakerRoster\(ctx\.eventId\)|readAgendaData\(ctx\.eventId\)/, path);
    assert.equal(/prisma\./.test(route), false, `${path} must not query directly`);
  }
});

test("only the speakers export carries an email, and it is the roster's own", () => {
  assert.match(source("app/api/admin/speakers/export/route.ts"), /email: row\.email,/);
  for (const path of [
    "app/api/admin/sessions/export/route.ts",
    "app/api/admin/schedule/export/route.ts",
  ]) {
    assert.equal(/email/i.test(code(path)), false, `${path} must not project an email`);
  }
  // And the roster page already prints that email under every speaker's name,
  // so the export widens nothing.
  assert.match(source("app/(app)/admin/speakers/page.tsx"), /\{row\.email\}/);
});

test("the export buttons sit beside their sections, and the ABS-13 one stays discoverable", () => {
  const component = page();
  for (const href of [
    "/api/admin/speakers/export",
    "/api/admin/sessions/export",
    "/api/admin/schedule/export",
    // The pre-existing review-results export, kept reachable from this page.
    "/api/admin/abstracts/export",
  ]) {
    assert.ok(component.includes(`href="${href}"`), `missing export link: ${href}`);
  }
  // Plain anchors with `download`, never a fetch: the server stays the only
  // place that decides what a CSV may contain.
  assert.equal((component.match(/ download$/gm) ?? []).length, 4);
  assert.equal(/fetch\(/.test(component), false);
  // The abstracts table's own export button is untouched.
  assert.match(source("components/abstracts-table.tsx"), /\/api\/admin\/abstracts\/export/);
});
