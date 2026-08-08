/**
 * Lightweight client-side `.ics` generation for the public embed.
 *
 * Integration note: Ops owns the canonical `.ics` generation in `lib/calendar/*`
 * and `/api/comms/*`. This is a self-contained fallback so the public embed can
 * offer calendar export before that endpoint lands; swap `downloadIcs` to hit the
 * comms endpoint when available.
 */
import type { SlotModel } from "@/lib/fixtures";

function toIcsDate(iso: string): string {
  // Preserve the local wall-clock time from the offset-bearing ISO string.
  return iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "T");
}

function escape(text: string): string {
  return text.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

export function buildIcs(slots: SlotModel[], eventName: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sessionboard//Embed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escape(eventName)}`,
  ];
  for (const s of slots) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.id}@sessionboard`,
      `DTSTART:${toIcsDate(s.startsAt)}`,
      `DTEND:${toIcsDate(s.endsAt)}`,
      `SUMMARY:${escape(s.title)}`,
      `DESCRIPTION:${escape(`Speaker: ${s.speakers}`)}`,
      `LOCATION:${escape(s.roomId)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export function downloadIcs(slots: SlotModel[], eventName: string, filename: string): void {
  const blob = new Blob([buildIcs(slots, eventName)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
