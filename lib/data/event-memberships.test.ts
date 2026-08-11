import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_WORKSPACE_LIST,
  WORKSPACE_LIST_TAKE,
  compareWorkspaces,
  readUserWorkspaces,
  selectWorkspaces,
  type WorkspaceCandidate,
  type WorkspaceReaderClient,
} from "@/lib/data/event-memberships";

/**
 * D-C5-16 item 1. This projection decides what the sidebar switcher offers; the
 * switch route re-checks the membership before anything moves, so the contract
 * here is ordering, bounding, and — above all — that the read is keyed on one
 * user id and can never widen past it.
 */

function candidate(id: string, name: string, role: WorkspaceCandidate["role"] = "ADMIN"): WorkspaceCandidate {
  return { role, event: { id, name, slug: name.toLowerCase().replace(/\s+/g, "-") } };
}

test("workspaces order by name, then id, and never by row order", () => {
  const { workspaces } = selectWorkspaces([
    candidate("z-id", "Sidetrack 2027"),
    candidate("b-id", "Forward 2026"),
    candidate("a-id", "Forward 2026"),
  ]);
  assert.deepEqual(
    workspaces.map((workspace) => workspace.id),
    ["a-id", "b-id", "z-id"],
  );
});

test("ordering is codepoint-based, so two servers in different locales agree", () => {
  // A locale-collating comparator would sort these by a language's rules; this
  // one must not.
  const names = ["Zurich", "apple", "Ápex", "Apex"];
  const sorted = [...names].sort((left, right) =>
    compareWorkspaces(
      { id: "x", name: left, slug: "s", role: "ADMIN" },
      { id: "x", name: right, slug: "s", role: "ADMIN" },
    ),
  );
  assert.deepEqual(sorted, [...names].sort());
});

test("a role is carried per event, so the same person can hold different ones", () => {
  const { workspaces } = selectWorkspaces([
    candidate("a-id", "Alpha", "ADMIN"),
    candidate("b-id", "Beta", "SPEAKER"),
  ]);
  assert.deepEqual(
    workspaces.map((workspace) => [workspace.id, workspace.role]),
    [["a-id", "ADMIN"], ["b-id", "SPEAKER"]],
  );
});

test("the list is bounded and reports truncation rather than dropping silently", () => {
  const many = Array.from({ length: 5 }, (_, index) => candidate(`id-${index}`, `Event ${index}`));
  const bounded = selectWorkspaces(many, 3);
  assert.equal(bounded.workspaces.length, 3);
  assert.equal(bounded.truncated, true);
  const whole = selectWorkspaces(many, 5);
  assert.equal(whole.truncated, false);
});

test("the read asks for one past the bound so truncation is observed, not guessed", async () => {
  const asked: { userId: string; take: number }[] = [];
  const client: WorkspaceReaderClient = {
    async listMemberships(query) {
      asked.push(query);
      return [candidate("a-id", "Alpha")];
    },
  };
  await readUserWorkspaces("user-1", client);
  assert.deepEqual(asked, [{ userId: "user-1", take: WORKSPACE_LIST_TAKE + 1 }]);
});

test("the read is keyed on exactly the user id it was given", async () => {
  const asked: string[] = [];
  const client: WorkspaceReaderClient = {
    async listMemberships(query) {
      asked.push(query.userId);
      return [];
    },
  };
  await readUserWorkspaces("user-1", client);
  await readUserWorkspaces("user-2", client);
  assert.deepEqual(asked, ["user-1", "user-2"]);
});

test("an absent user id yields nothing and never reaches the database", async () => {
  let called = false;
  const client: WorkspaceReaderClient = {
    async listMemberships() {
      called = true;
      return [candidate("a-id", "Alpha")];
    },
  };
  assert.deepEqual(await readUserWorkspaces("", client), EMPTY_WORKSPACE_LIST);
  assert.equal(called, false);
});

test("the projection exposes only id, name, slug and the caller's own role", () => {
  const { workspaces } = selectWorkspaces([candidate("a-id", "Alpha")]);
  assert.deepEqual(Object.keys(workspaces[0]!).sort(), ["id", "name", "role", "slug"]);
});
