import assert from "node:assert/strict";
import test from "node:test";
import {
  NEVER_EXPORTED,
  SCHEDULE_EXPORT_HEADER,
  SESSION_EXPORT_HEADER,
  SPEAKER_EXPORT_HEADER,
  buildScheduleExportCsv,
  buildSessionExportCsv,
  buildSpeakerExportCsv,
  scheduleExportFilename,
  sessionExportFilename,
  speakerExportFilename,
  type ScheduleExportRow,
  type SessionExportRow,
  type SpeakerExportRow,
} from "@/lib/services/reports-export-csv";
import { csvCell, csvDocument, csvRow } from "@/lib/services/csv";
import { csvCell as decisionCsvCell } from "@/lib/services/decision-export-csv";

function lines(csv: string): string[] {
  return csv.split("\r\n").filter((line) => line.length > 0);
}

// ---- the shared writer -----------------------------------------------------

test("there is one escaper: the decision export re-exports this module's cell", () => {
  // If these ever diverge, one export is safe and the other is not.
  assert.equal(decisionCsvCell, csvCell);
});

test("the shared document assembler ends every record with CRLF", () => {
  const csv = csvDocument(["a", "b"], [["1", "2"]]);
  assert.equal(csv, "a,b\r\n1,2\r\n");
  assert.equal(csvRow(["x,y"]), '"x,y"');
});

// ---- speakers --------------------------------------------------------------

const speakerRows: SpeakerExportRow[] = [
  {
    name: "Ada Lovelace",
    email: "ada@example.test",
    company: "Analytical, Inc",
    jobTitle: "Engineer",
    status: "CONFIRMED",
    sessionCount: 2,
    scheduledCount: 1,
    sessionTitles: ["Engines", "Numbers"],
    profilePercent: 100,
    profileMissing: [],
    tasksDone: 3,
    tasksTotal: 4,
    requiredOutstanding: ["Headshot"],
    nextRequiredDueAt: "2026-04-01T12:00:00.000Z",
    overdueRequired: 1,
    onboardingComplete: false,
  },
  {
    name: "=cmd|calc",
    email: "grace@example.test",
    company: null,
    jobTitle: null,
    status: "INVITED",
    sessionCount: 0,
    scheduledCount: 0,
    sessionTitles: [],
    profilePercent: 0,
    profileMissing: ["Bio", "Company"],
    tasksDone: 0,
    tasksTotal: 0,
    requiredOutstanding: [],
    nextRequiredDueAt: null,
    overdueRequired: 0,
    onboardingComplete: true,
  },
];

test("the speakers header row is the documented column contract", () => {
  assert.equal(
    lines(buildSpeakerExportCsv({ rows: speakerRows, truncated: false }))[0],
    "name,email,company,job_title,confirmation_status,sessions_total,sessions_scheduled,session_titles,"
      + "profile_percent,profile_missing,tasks_complete,tasks_total,required_tasks_open,next_required_due_at,"
      + "overdue_required_tasks,onboarding_complete",
  );
  assert.equal(SPEAKER_EXPORT_HEADER.length, 16);
});

test("a speaker row carries the roster's own values, multi-values semicolon-joined", () => {
  const [, first] = lines(buildSpeakerExportCsv({ rows: speakerRows, truncated: false }));
  assert.equal(
    first,
    'Ada Lovelace,ada@example.test,"Analytical, Inc",Engineer,CONFIRMED,2,1,Engines; Numbers,100,,3,4,'
      + "Headshot,2026-04-01T12:00:00.000Z,1,no",
  );
});

test("onboarding completeness exports as yes/no, never a locale-dependent boolean", () => {
  const csv = buildSpeakerExportCsv({ rows: speakerRows, truncated: false });
  assert.ok(!/,(TRUE|FALSE|true|false)(,|\r)/.test(csv), csv);
  assert.ok(lines(csv)[2]!.endsWith(",yes"));
});

test("a formula-shaped speaker name is neutralized in the speakers export", () => {
  const csv = buildSpeakerExportCsv({ rows: speakerRows, truncated: false });
  assert.ok(csv.includes("'=cmd|calc"));
  assert.ok(!/(^|\r\n)=cmd/.test(csv));
});

test("the speakers export carries the contact fields and nothing more revealing", () => {
  // Email is in, deliberately: the roster prints it under every name and this
  // is the CRM-parity export. Bio and headshot are out — narrower than the
  // screen is always allowed, wider never is.
  assert.ok(SPEAKER_EXPORT_HEADER.includes("email"));
  for (const forbidden of ["bio", "headshot", "headshot_url", "slide_deck_url"]) {
    assert.ok(!SPEAKER_EXPORT_HEADER.some((column) => column === forbidden), forbidden);
  }
});

// ---- sessions --------------------------------------------------------------

const sessionRows: SessionExportRow[] = [
  {
    id: "ses-1",
    title: "Scaling, safely",
    contentStatus: "PUBLISHED",
    format: "TALK",
    durationMinutes: 45,
    categoryName: "Platform",
    trackName: "Main track",
    roomName: "Main hall",
    startsAt: "2026-05-12T16:00:00.000Z",
    endsAt: "2026-05-12T16:45:00.000Z",
    speakerNames: ["Ada Lovelace", "Grace Hopper"],
  },
  {
    id: "ses-2",
    title: "-1 unplaced talk",
    contentStatus: "DRAFT",
    format: null,
    durationMinutes: 30,
    categoryName: null,
    trackName: null,
    roomName: null,
    startsAt: null,
    endsAt: null,
    speakerNames: [],
  },
];

test("the sessions header row is the documented column contract", () => {
  assert.equal(
    lines(buildSessionExportCsv({ rows: sessionRows, truncated: false }))[0],
    "session_id,title,content_status,format,duration_minutes,category,track,room,starts_at,ends_at,scheduled,speakers",
  );
  assert.equal(SESSION_EXPORT_HEADER.length, 12);
});

test("an unplaced talk is exported with empty placement columns and scheduled=no", () => {
  const [, placed, unplaced] = lines(buildSessionExportCsv({ rows: sessionRows, truncated: false }));
  assert.equal(
    placed,
    'ses-1,"Scaling, safely",PUBLISHED,TALK,45,Platform,Main track,Main hall,'
      + "2026-05-12T16:00:00.000Z,2026-05-12T16:45:00.000Z,yes,Ada Lovelace; Grace Hopper",
  );
  assert.equal(unplaced, "ses-2,'-1 unplaced talk,DRAFT,,30,,,,,,no,");
});

test("the sessions export carries speaker names and no speaker email", () => {
  assert.ok(SESSION_EXPORT_HEADER.includes("speakers"));
  assert.ok(!SESSION_EXPORT_HEADER.some((column) => column.includes("email")));
  assert.ok(!buildSessionExportCsv({ rows: sessionRows, truncated: false }).includes("@"));
});

// ---- schedule --------------------------------------------------------------

const scheduleRows: ScheduleExportRow[] = [
  {
    startsAt: "2026-05-12T17:00:00.000Z",
    endsAt: "2026-05-12T17:45:00.000Z",
    roomName: "Main hall",
    trackName: "Main track",
    sessionTitle: "Scaling, safely",
    speakerNames: ["Ada Lovelace"],
  },
];

test("the schedule header row is the documented column contract", () => {
  assert.equal(
    lines(buildScheduleExportCsv({ rows: scheduleRows, truncated: false, timezone: "UTC" }))[0],
    "day,starts_at_local,ends_at_local,room,track,session_title,speakers,duration_minutes,starts_at_utc,ends_at_utc",
  );
  assert.equal(SCHEDULE_EXPORT_HEADER.length, 10);
});

test("local day and clock come from the EVENT's zone, and the instants ride along", () => {
  const la = lines(buildScheduleExportCsv({
    rows: scheduleRows, truncated: false, timezone: "America/Los_Angeles",
  }))[1]!;
  // 17:00Z on 12 May is 10:00 AM the same day in Los Angeles.
  assert.ok(la.startsWith("2026-05-12,10:00 AM,10:45 AM,Main hall,Main track,"), la);
  assert.ok(la.endsWith(",45,2026-05-12T17:00:00.000Z,2026-05-12T17:45:00.000Z"), la);

  // The same slot read in Tokyo is the following calendar day, and the export
  // must say so rather than printing the server's idea of the date.
  const tokyo = lines(buildScheduleExportCsv({
    rows: scheduleRows, truncated: false, timezone: "Asia/Tokyo",
  }))[1]!;
  assert.ok(tokyo.startsWith("2026-05-13,2:00 AM,2:45 AM,"), tokyo);
});

test("the schedule export holds only placed slots, so every row has a time", () => {
  const csv = buildScheduleExportCsv({ rows: [], truncated: false, timezone: "UTC" });
  assert.equal(lines(csv).length, 1);
  assert.ok(csv.startsWith("day,"));
});

// ---- shared contract across all three --------------------------------------

const ALL_EXPORTS = [
  ["speakers", SPEAKER_EXPORT_HEADER, buildSpeakerExportCsv({ rows: speakerRows, truncated: true })],
  ["sessions", SESSION_EXPORT_HEADER, buildSessionExportCsv({ rows: sessionRows, truncated: true })],
  ["schedule", SCHEDULE_EXPORT_HEADER, buildScheduleExportCsv({ rows: scheduleRows, truncated: true, timezone: "UTC" })],
] as const;

test("no export carries an evaluator identity, a score, or a review comment", () => {
  for (const [name, header, csv] of ALL_EXPORTS) {
    for (const forbidden of NEVER_EXPORTED) {
      assert.ok(
        !header.some((column) => column.includes(forbidden)),
        `${name} header contains ${forbidden}`,
      );
      assert.ok(!new RegExp(forbidden, "i").test(csv), `${name} document contains ${forbidden}`);
    }
  }
});

test("every export ends with CRLF and states its own truncation in a comment row", () => {
  for (const [name, , csv] of ALL_EXPORTS) {
    assert.ok(csv.endsWith("\r\n"), name);
    const last = lines(csv).at(-1)!;
    // Unquoted, so a spreadsheet shows it as the comment it is rather than as
    // a data cell — which means the notice may not contain a comma.
    assert.ok(last.startsWith("# Truncated:"), `${name}: ${last}`);
    assert.ok(!last.includes(","), `${name} notice would be quoted: ${last}`);
    assert.ok(last.includes("not the complete list"), `${name}: ${last}`);
    // Names the limit; recommends no control these routes do not have.
    assert.ok(!/\bfilter\b|try again|narrow/i.test(last), `${name}: ${last}`);
  }
});

test("an untruncated export adds no comment row", () => {
  for (const csv of [
    buildSpeakerExportCsv({ rows: speakerRows, truncated: false }),
    buildSessionExportCsv({ rows: sessionRows, truncated: false }),
    buildScheduleExportCsv({ rows: scheduleRows, truncated: false, timezone: "UTC" }),
  ]) {
    assert.ok(!csv.includes("# Truncated"));
  }
});

test("every export renders a usable header-only document for an empty event", () => {
  for (const csv of [
    buildSpeakerExportCsv({ rows: [], truncated: false }),
    buildSessionExportCsv({ rows: [], truncated: false }),
    buildScheduleExportCsv({ rows: [], truncated: false, timezone: "UTC" }),
  ]) {
    assert.equal(lines(csv).length, 1);
  }
});

test("filenames are dated, distinct, and free of anything user-supplied", () => {
  const at = new Date("2026-08-11T09:00:00.000Z");
  const names = [
    speakerExportFilename(at),
    sessionExportFilename(at),
    scheduleExportFilename(at),
  ];
  assert.deepEqual(names, [
    "greenroom-speakers-2026-08-11.csv",
    "greenroom-sessions-2026-08-11.csv",
    "greenroom-schedule-2026-08-11.csv",
  ]);
  assert.equal(new Set(names).size, 3);
  for (const name of names) assert.ok(!/["\r\n;]/.test(name), name);
});
