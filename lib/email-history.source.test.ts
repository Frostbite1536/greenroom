/**
 * Source contract for the `/admin/emails` filter, search and pager (EML-01).
 *
 * The composition itself is covered by `lib/comms/email-history.test.ts`. What
 * is pinned here is the wiring the unit tests cannot see: that the whole
 * surface is a server-rendered GET form with no client fetch behind it, that
 * every control carries the other controls' state, that the narrowings reach
 * the database rather than an already-read page, and that the status list the
 * chips are derived from still covers everything the send path can write.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = () => source("app/(app)/admin/emails/page.tsx");
/** The rendered surface only — the comments explain the bans they'd trip. */
const pageCode = () =>
  page()
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const fold = () => source("lib/comms/email-history.ts");
const reads = () => source("lib/data/reads.ts");

test("the chip list covers every status the send path and the schema can write", () => {
  // `EmailDispatch.status` is a `String`, not an enum, so no schema check can
  // fail when a new outcome appears. This is that check: the delivery modes
  // `lib/comms/send.ts` writes, plus the column default the schema stamps
  // before an attempt reports back, must all be in the list the chips derive
  // from — otherwise a stored status is rendered and reachable by no filter,
  // which is the exact gap the abstracts chips closed for WITHDRAWN.
  const send = source("lib/comms/send.ts");
  const modes = send.match(/export type DeliveryMode = ([^;]+);/);
  assert.ok(modes, "DeliveryMode is no longer declared where this contract reads it");
  const written = [...modes[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(written.sort(), ["failed", "mocked", "sent"]);

  const schema = source("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model EmailDispatch {"));
  const columnDefault = model.match(/status\s+String\s+@default\("([a-z]+)"\)/);
  assert.ok(columnDefault, "the dispatch status column no longer declares a default");

  const statuses = fold().match(/export const EMAIL_DISPATCH_STATUSES = \[([^\]]+)\]/);
  assert.ok(statuses, "the status list moved");
  const listed = [...statuses[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  for (const status of [...written, columnDefault[1]]) {
    assert.ok(listed.includes(status), `${status} can be stored but has no filter chip`);
  }
  // The chips are derived from that list rather than restated, so the bijection
  // cannot be broken by editing one of two copies.
  assert.match(fold(), /\.\.\.EMAIL_DISPATCH_STATUSES\.map\(\(status\) => \(\{/);
});

test("the filter surface is a real GET form with no client fetch behind it", () => {
  const component = page();
  // A server component: no "use client", so none of this can become a fetch.
  assert.equal(component.includes("use client"), false);
  assert.match(component, /method="get" action=\{EMAIL_HISTORY_PATH\}/);
  assert.match(component, /const params = await searchParams;/);
  assert.match(component, /const history = await getEmailHistory\(params\);/);
  // Search and the template select are named inputs the server reads back.
  assert.match(component, /name=\{EMAIL_HISTORY_PARAMS\.query\}/);
  assert.match(component, /name=\{EMAIL_HISTORY_PARAMS\.template\}/);
  assert.match(component, /maxLength=\{EMAIL_RECIPIENT_SEARCH_MAX_LENGTH\}/);
  assert.match(component, /<button className="ghost-button" type="submit">Filter<\/button>/);
  // Nothing on this page may reach the network or the router.
  const code = pageCode();
  assert.equal(/router\.(push|refresh)|useRouter|apiPost|apiPatch|fetch\(|onChange|onClick/.test(code), false);
  // Chips are links with aria-current, never anchors carrying aria-pressed
  // (axe: aria-allowed-attr), matching the roster.
  assert.match(component, /aria-current=\{active \? "page" : undefined\}/);
  assert.equal(/aria-pressed/.test(code), false);
});

test("every control carries the other controls' state rather than dropping it", () => {
  const component = page();
  // The form carries the active chip, or submitting a search would silently
  // widen the status filter back to All.
  assert.match(
    component,
    /\{query\.status === EMAIL_STATUS_ALL \? null : \(\s*<input type="hidden" name=\{EMAIL_HISTORY_PARAMS\.status\} value=\{query\.status\} \/>/,
  );
  // And it deliberately carries no anchor: a position inside the previous view
  // names no position in the one being searched for.
  assert.equal(/name=\{EMAIL_HISTORY_PARAMS\.cursor\}/.test(component), false);
  // Chips and pager links are built by the shared href helpers, which is where
  // "carry every other narrowing" is unit-tested.
  assert.match(component, /href=\{emailHistoryStatusHref\(query, option\.value\)\}/);
  assert.match(component, /rel="prev" href=\{emailHistoryNewerHref\(query, history\.newerCursor\)\}/);
  assert.match(component, /rel="next" href=\{emailHistoryOlderHref\(query, history\.olderCursor\)\}/);
  // Each pager link is offered only with an anchor the page actually observed,
  // and "Newest" is always reachable so a stale link is never a dead end.
  assert.match(component, /\{history\.hasNewer && history\.newerCursor \? \(/);
  assert.match(component, /\{history\.hasOlder && history\.olderCursor \? \(/);
  assert.match(component, /href=\{emailHistoryNewestHref\(query\)\}/);
  // No hand-built query strings anywhere: one builder, one encoding.
  assert.equal(/href=\{`\/admin\/emails\?/.test(component), false);
});

test("paging is anchored to a row, never to an offset", () => {
  // The review defect: `skip` counts from the top of a set that changes while
  // it is read, so one insert between two requests repeats or drops a row.
  const read = reads();
  const body = read.slice(
    read.indexOf("export async function getEmailHistory("),
    read.indexOf("// ---- Embeds"),
  );
  assert.equal(/\bskip\b/.test(body), false, "the dispatch read must not offset");
  assert.equal(/emailHistorySkip|query\.page/.test(body), false);
  assert.match(body, /orderBy: emailHistoryOrderByFor\(query\.direction\)/);

  // The predicate is a tuple comparison on (createdAt, id), not a bare
  // createdAt one: a bulk send writes many rows inside one millisecond, so
  // `createdAt` alone skips every tied row after the anchor.
  const module = fold();
  const keyset = module.slice(
    module.indexOf("export function emailHistoryKeysetWhere("),
    module.indexOf("export function emailHistoryOrderByFor("),
  );
  assert.match(keyset, /OR: \[\s*\{ createdAt: \{ lt: createdAt \} \},\s*\{ createdAt, id: \{ lt: cursor\.id \} \},\s*\]/);
  assert.match(keyset, /OR: \[\s*\{ createdAt: \{ gt: createdAt \} \},\s*\{ createdAt, id: \{ gt: cursor\.id \} \},\s*\]/);
  // Each direction keeps its id tie-break — a lone createdAt term is exactly
  // the regression this pins.
  for (const operator of ["lt", "gt"]) {
    const terms = keyset.match(new RegExp(`id: \\{ ${operator}: cursor\\.id \\}`, "g")) ?? [];
    assert.equal(terms.length, 1, `the ${operator} branch lost its id tie-break`);
  }
  // It is ANDed in as its own clause so a future OR cannot overwrite it.
  assert.match(module, /if \(keyset\) where\.AND = \[keyset\];/);
  // Nothing in the module builds an offset any more.
  assert.equal(/emailHistorySkip|EMAIL_HISTORY_MAX_PAGE|clampEmailHistoryPage/.test(module), false);
});

test("the cursor is bounded and opaque, and a bad one is the newest page", () => {
  const module = fold();
  assert.match(module, /token\.length > EMAIL_HISTORY_CURSOR_MAX_LENGTH\) return null;/);
  assert.match(module, /if \(!\/\^\[A-Za-z0-9_-\]\+\$\/\.test\(token\)\) return null;/);
  // The instant must round-trip, not merely parse: `new Date` coerces plenty of
  // strings this page never issued, and a coerced anchor pages elsewhere.
  assert.match(module, /parsed\.toISOString\(\) !== createdAt\) return null;/);
  // Refusal is a fallback, never a throw — a stale link must not 500 the panel.
  const decoder = module.slice(
    module.indexOf("export function decodeEmailHistoryCursor("),
    module.indexOf("export function parseEmailHistoryDirection("),
  );
  assert.equal(/throw /.test(decoder), false);
});

test("the narrowings are applied by the database, not to an already-read page", () => {
  const read = reads();
  const body = read.slice(
    read.indexOf("export async function getEmailHistory("),
    read.indexOf("// ---- Embeds"),
  );
  assert.match(body, /where: emailHistoryWhere\(ctx\.eventId, query\)/);
  assert.match(body, /take: EMAIL_HISTORY_PAGE_TAKE/);
  assert.match(body, /orderBy: emailHistoryOrderByFor\(query\.direction\)/);
  // A chip that filtered rows already fetched would mean "failed among the
  // newest 50", which is not what the chip says.
  assert.equal(/\.filter\(|\.slice\(0, EMAIL_HISTORY_PAGE_SIZE\)/.test(body), false);
  // Still no second, differently-snapshotted volume statement.
  assert.equal(/\.count\(/.test(body), false);
  // The template filter is only accepted against keys this event really has.
  assert.match(body, /parseEmailHistoryQuery\(searchParams, templateKeys\)/);
  assert.match(body, /take: OPERATOR_QUERY_LIMITS\.templates \+ 1/);

  // The order is total, so a page boundary cannot reshuffle between requests:
  // `createdAt desc` alone ties inside a bulk send's millisecond, and `id` is
  // unique, so the pair is a strict total order over the log.
  assert.match(fold(), /export const emailHistoryOrderBy = \[\s*\{ createdAt: "desc" \},\s*\{ id: "desc" \},/);
});

test("the panel still refuses to overstate delivery or volume", () => {
  const component = page();
  // The mock-mode honesty this page exists for is untouched by the filters.
  assert.match(component, /<strong>Mocked<\/strong> rows were recorded but never handed to a provider/);
  assert.match(component, /the status column, not the timestamp, is the only\s+statement about delivery/);
  // The metrics describe this page, and say so in their own label.
  assert.match(component, /<span>On this page<\/span><strong>\{history\.shown\}<\/strong>/);
  assert.match(component, /\{emailHistoryRangeLabel\(history\)\}/);
  // No page count and no lifetime total may appear on the surface.
  assert.equal(/history\.(total|pages|pageCount)/.test(component), false);
  // The empty state is the fold's, so a filtered miss cannot be phrased as an
  // empty log by the component.
  assert.match(component, /const empty = emailHistoryEmptyState\(query\);/);
  assert.match(component, /title=\{empty\.title\}/);
  assert.equal(/No emails have been attempted for this event yet/.test(component), false);
});
