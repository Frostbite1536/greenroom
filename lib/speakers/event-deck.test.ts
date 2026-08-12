import assert from "node:assert/strict";
import { test } from "node:test";
import {
  indexEventDecks,
  resolveRosterDecks,
  resolveSpeakerDeck,
  speakerDeckSourceHint,
  speakerDeckSourceLabel,
} from "@/lib/speakers/event-deck";

test("the event deck wins over the global profile deck", () => {
  assert.deepEqual(
    resolveSpeakerDeck({
      eventDeckUrl: "/api/files/clx1111111111",
      profileDeckUrl: "https://slides.example.test/global.pdf",
    }),
    { url: "/api/files/clx1111111111", source: "event" },
  );
});

test("the global profile deck is the fallback when this event has no association", () => {
  assert.deepEqual(
    resolveSpeakerDeck({ eventDeckUrl: null, profileDeckUrl: "https://slides.example.test/global.pdf" }),
    { url: "https://slides.example.test/global.pdf", source: "profile" },
  );
  // Undefined is the same absence as null: a caller that did not read the
  // association must not accidentally suppress the fallback.
  assert.deepEqual(
    resolveSpeakerDeck({ profileDeckUrl: "https://slides.example.test/global.pdf" }),
    { url: "https://slides.example.test/global.pdf", source: "profile" },
  );
});

test("neither deck resolves to an explicit nothing, with no source", () => {
  assert.deepEqual(resolveSpeakerDeck({}), { url: null, source: null });
  assert.deepEqual(
    resolveSpeakerDeck({ eventDeckUrl: null, profileDeckUrl: null }),
    { url: null, source: null },
  );
});

test("a blank association falls back rather than resolving to an empty deck", () => {
  assert.deepEqual(
    resolveSpeakerDeck({ eventDeckUrl: "   ", profileDeckUrl: "https://slides.example.test/global.pdf" }),
    { url: "https://slides.example.test/global.pdf", source: "profile" },
  );
  assert.deepEqual(
    resolveSpeakerDeck({ eventDeckUrl: "", profileDeckUrl: "  " }),
    { url: null, source: null },
  );
});

test("surrounding whitespace never reaches the resolved value", () => {
  assert.deepEqual(
    resolveSpeakerDeck({ eventDeckUrl: "  /api/files/clx1111111111  " }),
    { url: "/api/files/clx1111111111", source: "event" },
  );
});

test("the source is always exactly as null as the url", () => {
  const cases = [
    { eventDeckUrl: "a", profileDeckUrl: "b" },
    { eventDeckUrl: null, profileDeckUrl: "b" },
    { eventDeckUrl: "a", profileDeckUrl: null },
    { eventDeckUrl: null, profileDeckUrl: null },
    { eventDeckUrl: " ", profileDeckUrl: " " },
  ];
  for (const input of cases) {
    const resolved = resolveSpeakerDeck(input);
    assert.equal(
      resolved.url === null,
      resolved.source === null,
      `url/source disagree for ${JSON.stringify(input)}`,
    );
  }
});

test("provenance is labelled honestly, and only a fallback carries an explanation", () => {
  assert.equal(speakerDeckSourceLabel("event"), "This event");
  assert.match(speakerDeckSourceLabel("profile"), /fallback/i);
  assert.equal(speakerDeckSourceLabel(null), "No deck");

  assert.equal(speakerDeckSourceHint("event"), null);
  assert.equal(speakerDeckSourceHint(null), null);
  assert.match(String(speakerDeckSourceHint("profile")), /has not set a deck for this event/);
});

test("a bounded association read folds to one entry per user asked for", () => {
  const eventDecks = indexEventDecks([
    { userId: "u-1", deckUrl: "/api/files/clx1111111111" },
    { userId: "u-3", deckUrl: "https://slides.example.test/three.pdf" },
  ]);
  const profileDecks = new Map<string, string | null>([
    ["u-1", "https://slides.example.test/one-global.pdf"],
    ["u-2", "https://slides.example.test/two-global.pdf"],
    ["u-3", null],
  ]);

  const resolved = resolveRosterDecks(["u-1", "u-2", "u-3", "u-4"], eventDecks, profileDecks);

  // Every id asked for is present, so a caller folding over rendered rows never
  // has to guess what a missing key means.
  assert.deepEqual(Object.keys(resolved).sort(), ["u-1", "u-2", "u-3", "u-4"]);
  assert.deepEqual(resolved["u-1"], { url: "/api/files/clx1111111111", source: "event" });
  assert.deepEqual(resolved["u-2"], { url: "https://slides.example.test/two-global.pdf", source: "profile" });
  assert.deepEqual(resolved["u-3"], { url: "https://slides.example.test/three.pdf", source: "event" });
  assert.deepEqual(resolved["u-4"], { url: null, source: null });
});

test("a deck for a user not on the roster is not projected", () => {
  const eventDecks = indexEventDecks([{ userId: "u-other", deckUrl: "/api/files/clx9999999999" }]);
  const resolved = resolveRosterDecks(["u-1"], eventDecks, new Map());
  assert.deepEqual(Object.keys(resolved), ["u-1"]);
  assert.deepEqual(resolved["u-1"], { url: null, source: null });
});
