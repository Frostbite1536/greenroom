import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api/http";
import { PUBLIC_JSON_MAX_BYTES, parseBoundedJson } from "./bounded-json";

function requestFromChunks(chunks: Uint8Array[], headers?: HeadersInit): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://localhost/api/cfp/submissions", {
    method: "POST",
    headers,
    body: stream,
    // Node's Fetch implementation requires this for a streaming request body.
    duplex: "half",
  } as RequestInit);
}

test("bounded JSON rejects an over-limit Content-Length before parsing", async () => {
  const req = requestFromChunks([new TextEncoder().encode("{}")], {
    "content-length": String(PUBLIC_JSON_MAX_BYTES + 1),
  });
  await assert.rejects(
    parseBoundedJson(req),
    (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === "REQUEST_TOO_LARGE",
  );
});

test("bounded JSON rejects streamed overflow before JSON.parse", async () => {
  const req = requestFromChunks([
    new Uint8Array(PUBLIC_JSON_MAX_BYTES),
    new Uint8Array([123]),
  ]);
  await assert.rejects(
    parseBoundedJson(req),
    (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === "REQUEST_TOO_LARGE",
  );
});

test("bounded JSON preserves valid and malformed JSON contracts", async () => {
  assert.deepEqual(await parseBoundedJson(requestFromChunks([new TextEncoder().encode('{"ok":true}')])), { ok: true });
  await assert.rejects(
    parseBoundedJson(requestFromChunks([new TextEncoder().encode("{")])),
    (error: unknown) => error instanceof ApiError && error.status === 400 && error.code === "INVALID_JSON",
  );
});
