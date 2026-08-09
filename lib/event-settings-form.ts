/** Client-side guidance for the paired event-date contract. The server remains authoritative. */
export function validateEventDatePair(startsOn: string, endsOn: string): string | null {
  if ((startsOn === "") !== (endsOn === "")) {
    return "Enter both event dates, or clear both dates together.";
  }
  if (startsOn !== "" && startsOn > endsOn) {
    return "The event must end on or after its start date.";
  }
  return null;
}
