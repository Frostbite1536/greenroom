import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUploadedTaskArtifact,
  taskArtifactHref,
  taskArtifactLabel,
  taskArtifactSubmission,
} from "./task-artifact";
import { taskUpdateWithResponsesSchema } from "./task-form";

/**
 * A task deliverable is one column filled two ways, and both of this module's
 * decisions are the seam where that could go wrong:
 *
 *   - which request key a save uses, because a served `/api/files/<id>` path
 *     cannot travel through a `z.string().url()` key at all; and
 *   - whether a stored value may become an `href`, because nothing rendered
 *     `artifactUrl` before and `.url()` accepts non-HTTP schemes (GRA2-07).
 *
 * Both are pure, so both are pinned here rather than discovered on a screen.
 */

test("an uploaded file travels as an id, so the client never names the stored string", () => {
  assert.deepEqual(
    taskArtifactSubmission("/api/files/clx1234567890"),
    { artifactFileId: "clx1234567890" },
  );
  // Surrounding whitespace is a paste artifact, not a different value.
  assert.deepEqual(
    taskArtifactSubmission("  /api/files/clx1234567890  "),
    { artifactFileId: "clx1234567890" },
  );
});

test("a pasted link still travels as the URL key it always did", () => {
  assert.deepEqual(
    taskArtifactSubmission("https://drive.example.test/signed-release.pdf"),
    { artifactUrl: "https://drive.example.test/signed-release.pdf" },
  );
  assert.deepEqual(taskArtifactSubmission("  https://x.test/a  "), { artifactUrl: "https://x.test/a" });
});

test("an empty field sends no artifact key at all, rather than an empty string", () => {
  // Sending "" would fail the contract's `.url()` and turn an otherwise valid
  // save into a 422. Omitting the key preserves the stored value, which is what
  // the route has always done for an absent key — this is deliberately NOT a
  // way to clear the artifact, and does not pretend to be one.
  for (const empty of ["", "   ", null, undefined]) {
    assert.deepEqual(taskArtifactSubmission(empty), {}, `${JSON.stringify(empty)} must send nothing`);
  }
});

test("a near-miss stored path is a link, never an id — the id branch is exact", () => {
  // Anything that is not this app's own exact `/api/files/<id>` shape falls to
  // the URL branch, where the server's own validation applies. Nothing that
  // could point off-origin or at another route can become a file id.
  for (const value of [
    "https://evil.test/api/files/x",
    "//evil.test/api/files/x",
    "/api/files/x/../../admin",
    "/api/files/x?download=1",
    "/api/files/",
    "/api/filesx",
  ]) {
    const submission = taskArtifactSubmission(value);
    assert.equal("artifactFileId" in submission, false, `${value} must not become a file id`);
  }
});

test("exactly one artifact key is ever produced, so the schema's refusal is unreachable from the portal", () => {
  for (const value of ["/api/files/clx1234567890", "https://x.test/a", "", "not a url"]) {
    assert.ok(Object.keys(taskArtifactSubmission(value)).length <= 1, value);
  }
});

test("only an app path or an http(s) URL may become a link", () => {
  assert.equal(taskArtifactHref("/api/files/clx1234567890"), "/api/files/clx1234567890");
  assert.equal(taskArtifactHref("https://x.test/a.pdf"), "https://x.test/a.pdf");
  assert.equal(taskArtifactHref("http://x.test/a.pdf"), "http://x.test/a.pdf");

  // The reason this filter exists: `z.string().url()` accepted these, so a
  // stored row can hold one and this is the first surface that would render it.
  for (const hostile of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "mailto:someone@x.test",
    "not a url at all",
    "/portal/tasks/x",
    "",
    "   ",
    null,
    undefined,
  ]) {
    assert.equal(taskArtifactHref(hostile), null, `${String(hostile)} must not become an href`);
  }
});

test("an uploaded artifact and a pasted link are labelled as the different things they are", () => {
  assert.equal(isUploadedTaskArtifact("/api/files/clx1234567890"), true);
  assert.equal(isUploadedTaskArtifact("https://x.test/a.pdf"), false);
  assert.equal(isUploadedTaskArtifact(null), false);
  assert.equal(taskArtifactLabel("/api/files/clx1234567890"), "Uploaded file");
  assert.equal(taskArtifactLabel("https://x.test/a.pdf"), "Link");
});

/**
 * The body schema, checked from the same file, because what the client may send
 * and what it does send have to agree — a submission shape the schema rejects
 * is a 422 on a valid save, which is the whole failure this pairing prevents.
 */
const parse = (body: Record<string, unknown>) =>
  taskUpdateWithResponsesSchema.safeParse({ taskId: "clx1111111111", status: "IN_PROGRESS", ...body });

test("every submission this module produces is accepted by the task body schema", () => {
  for (const value of ["/api/files/clx1234567890", "https://x.test/a.pdf", ""]) {
    const result = parse(taskArtifactSubmission(value));
    assert.equal(
      result.success,
      true,
      `${value}: ${JSON.stringify(result.success ? {} : result.error.flatten().fieldErrors)}`,
    );
  }
});

test("the schema refuses both artifact keys at once rather than picking one", () => {
  const both = parse({ artifactUrl: "https://x.test/a.pdf", artifactFileId: "clx1234567890" });
  assert.equal(both.success, false, "both keys address one column and must not be guessed between");

  // Either alone is fine.
  assert.equal(parse({ artifactUrl: "https://x.test/a.pdf" }).success, true);
  assert.equal(parse({ artifactFileId: "clx1234567890" }).success, true);
  assert.equal(parse({}).success, true, "neither key is still a valid status-only save");
});

test("a relative path is still not accepted through the URL key", () => {
  // The stored-file path reaches the column only via the id key, so the locked
  // `z.string().url()` contract is unchanged and unwidened.
  assert.equal(parse({ artifactUrl: "/api/files/clx1234567890" }).success, false);
  assert.equal(parse({ artifactUrl: "" }).success, false);
});

test("a file id is bounded and trimmed, like every other id this app accepts", () => {
  assert.equal(parse({ artifactFileId: "  clx1234567890  " }).success, true);
  const trimmed = parse({ artifactFileId: "  clx1234567890  " });
  assert.equal(trimmed.success && trimmed.data.artifactFileId, "clx1234567890");
  assert.equal(parse({ artifactFileId: "" }).success, false);
  assert.equal(parse({ artifactFileId: "   " }).success, false);
  assert.equal(parse({ artifactFileId: "x".repeat(192) }).success, false);
  assert.equal(parse({ artifactFileId: 12345 }).success, false);
});
