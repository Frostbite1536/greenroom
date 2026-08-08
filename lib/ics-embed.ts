/**
 * Client-side `.ics` generation for the public embed.
 *
 * Integration note: Ops owns canonical `.ics` generation in `lib/calendar/*` and
 * `/api/comms/*`. This stays self-contained so the public embed can offer
 * calendar export with no session and no extra round trip; point `downloadIcs`
 * at the comms endpoint once it is available for public reads.
 */
import type { PublicAgendaSession } from "@/lib/data/reads";

/** UTC timestamp in iCalendar basic format (e.g. 20261012T170000Z). */
function toIcsUtc(iso: string): string {
  return `${new Date(iso).toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function escapeText(text: string): string {
  return text.replace(/([\\;,])/g, "\\$1").replace(/\r?\n/g, "\\n");
}

/** Fold lines to the 75-octet limit RFC 5545 requires. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const chunks: string[] = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    chunks.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  if (rest.length) chunks.push(` ${rest}`);
  return chunks.join("\r\n");
}

export function buildIcs(sessions: PublicAgendaSession[], eventName: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Greenroom//Public Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(eventName)}`,
  ];
  const stamp = toIcsUtc(new Date().toISOString());
  for (const s of sessions) {
    const description = [
      s.speakers.length ? `Speakers: ${s.speakers.join(", ")}` : null,
      s.track ? `Track: ${s.track.name}` : null,
      s.description ?? null,
    ]
      .filter(Boolean)
      .join("\n");

    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.sessionId}@greenroom`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toIcsUtc(s.startsAt)}`,
      `DTEND:${toIcsUtc(s.endsAt)}`,
      fold(`SUMMARY:${escapeText(s.title)}`),
      fold(`LOCATION:${escapeText(s.room.name)}`),
      ...(description ? [fold(`DESCRIPTION:${escapeText(description)}`)] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export function downloadIcs(
  sessions: PublicAgendaSession[],
  eventName: string,
  filename: string,
): void {
  const blob = new Blob([buildIcs(sessions, eventName)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
