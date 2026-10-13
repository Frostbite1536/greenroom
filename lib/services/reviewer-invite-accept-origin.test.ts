import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "@/app/api/auth/reviewer-invites/accept/route";

/**
 * SEC-02: the invite-accept route issues a session, so a cross-site page must not
 * be able to drive it. These requests run the real handler; a refused request
 * returns before the body is read, so no database is involved.
 */

const URL_BASE = "http://127.0.0.1:3000/api/auth/reviewer-invites/accept";

function accept(headers: Record<string, string>, body = JSON.stringify({ token: "v1.not-a-real-token" })) {
  return POST(new Request(URL_BASE, { method: "POST", headers, body }));
}

async function errorCode(response: Response): Promise<string | undefined> {
  const payload = (await response.json()) as { error?: { code?: string } };
  return payload.error?.code;
}

test("SEC-02: a cross-origin text/plain accept is refused without issuing a session", async () => {
  const response = await accept({ Origin: "https://evil.example", "Content-Type": "text/plain" });
  assert.equal(response.status, 403);
  assert.equal(await errorCode(response), "CROSS_ORIGIN_REFUSED");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("SEC-02: an accept with neither Origin nor Referer is refused", async () => {
  const response = await accept({ "Content-Type": "application/json" });
  assert.equal(response.status, 403);
  assert.equal(await errorCode(response), "CROSS_ORIGIN_REFUSED");
});

test("SEC-02: a same-origin accept passes the origin gate and reaches invite validation", async () => {
  const response = await accept({ Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" });
  assert.notEqual(response.status, 403);
  assert.notEqual(await errorCode(response), "CROSS_ORIGIN_REFUSED");
  assert.equal(response.headers.get("set-cookie"), null);
});
