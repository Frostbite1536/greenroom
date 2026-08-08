import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicSpeakers, PUBLIC_SPEAKER_LIMITS, safePublicImageUrl } from "./public-speakers";

const event = {
  id: "event-1",
  name: "Forward 2026",
  slug: "forward-2026",
  timezone: "America/Los_Angeles",
  startsAt: new Date("2026-05-12T07:00:00.000Z"),
  endsAt: new Date("2026-05-14T07:00:00.000Z"),
};

test("buildPublicSpeakers projects distinct speakers and exposes only public profile fields", () => {
  const profile = {
    bio: "Builds reliable systems.",
    company: "CloudScale",
    jobTitle: "Principal Engineer",
    headshotUrl: "https://images.example.test/elena.jpg",
  };
  const user = {
    id: "user-1",
    name: "Elena Rodriguez",
    avatarUrl: null,
    speakerProfile: profile,
    sessionSpeakers: [
      {
        session: {
          id: "session-1",
          title: "Scaling to 10M",
          scheduleSlot: { track: { name: "Engineering" } },
        },
      },
      {
        session: {
          id: "session-2",
          title: "Operating at the edge",
          scheduleSlot: { track: { name: "Architecture" } },
        },
      },
    ],
  };

  const gallery = buildPublicSpeakers(event, [user]);

  assert.equal(gallery.speakers.length, 1);
  assert.deepEqual(gallery.tracks.map((track) => track.name), ["Engineering", "Architecture"]);
  assert.deepEqual(gallery.speakers[0], {
    name: "Elena Rodriguez",
    bio: profile.bio,
    company: profile.company,
    jobTitle: profile.jobTitle,
    headshotUrl: "https://images.example.test/elena.jpg",
    sessions: [
      { id: "session-1", title: "Scaling to 10M", track: { name: "Engineering" } },
      { id: "session-2", title: "Operating at the edge", track: { name: "Architecture" } },
    ],
    sessionsTruncated: false,
  });
  assert.equal("id" in gallery.speakers[0]!, false);
  assert.equal("email" in gallery.speakers[0]!, false);
  assert.equal("id" in gallery.event, false);
  assert.equal(gallery.truncated, false);
});

test("safePublicImageUrl allows web images and rejects credentialed or executable URLs", () => {
  assert.equal(safePublicImageUrl("https://cdn.example.test/headshot.png"), "https://cdn.example.test/headshot.png");
  assert.equal(safePublicImageUrl("https://user:secret@cdn.example.test/headshot.png"), null);
  assert.equal(safePublicImageUrl("javascript:alert(1)"), null);
  assert.equal(safePublicImageUrl("not a url"), null);
});

test("buildPublicSpeakers returns a graceful sentinel summary for oversized lineups", () => {
  const sources = Array.from({ length: PUBLIC_SPEAKER_LIMITS.speakers + 1 }, (_, index) => ({
    id: `user-${index}`,
    name: `Speaker ${String(index).padStart(3, "0")}`,
    avatarUrl: null,
    speakerProfile: null,
    sessionSpeakers: [{
      session: {
        id: `session-${index}`,
        title: `Session ${index}`,
        scheduleSlot: { track: null },
      },
    }],
  }));

  const gallery = buildPublicSpeakers(event, sources);

  assert.equal(gallery.speakers.length, PUBLIC_SPEAKER_LIMITS.speakers);
  assert.equal(gallery.truncated, true);
});
