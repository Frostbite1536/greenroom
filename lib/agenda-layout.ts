/**
 * Pure geometry for the agenda grids (day / week).
 *
 * Kept out of the client component so it can be unit-tested without a DOM.
 * None of this is authoritative: the server re-checks every placement
 * transactionally (`POST /api/agenda/slots`); this only decides pixels.
 */

/** Default visible window, in minutes from midnight: 08:00 – 19:00. */
export const DEFAULT_GRID_START = 8 * 60;
export const DEFAULT_GRID_END = 19 * 60;

export type Interval = { startMin: number; endMin: number };

/**
 * The default window keeps the grid a familiar shape, but a session outside it
 * must never be clipped or drawn at a negative offset — the window only ever
 * expands, snapped out to whole hours.
 */
export function gridBounds(
  intervals: Interval[],
  start = DEFAULT_GRID_START,
  end = DEFAULT_GRID_END,
): { start: number; end: number } {
  let lo = start;
  let hi = end;
  for (const { startMin, endMin } of intervals) {
    lo = Math.min(lo, Math.floor(startMin / 60) * 60);
    hi = Math.max(hi, Math.ceil(endMin / 60) * 60);
  }
  return { start: lo, end: Math.max(hi, lo + 60) };
}

/** Whole hour marks covering `bounds`, inclusive of both ends. */
export function hourMarks(bounds: { start: number; end: number }): number[] {
  const count = Math.max(1, (bounds.end - bounds.start) / 60 + 1);
  return Array.from({ length: count }, (_, i) => bounds.start + i * 60);
}

/**
 * Interval-graph lane packing. A week column folds every room into one column,
 * so simultaneous sessions have to sit side by side instead of on top of each
 * other. Each interval takes the first lane whose previous booking has already
 * ended; touching intervals (`previous.end === next.start`) share a lane.
 *
 * `intervals` must be sorted by `startMin` ascending for a stable result.
 */
export function packLanes(intervals: Interval[]): { lanes: number[]; laneCount: number } {
  const laneEnds: number[] = [];
  const lanes = intervals.map(({ startMin, endMin }) => {
    const free = laneEnds.findIndex((laneEnd) => laneEnd <= startMin);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = endMin;
    return lane;
  });
  return { lanes, laneCount: Math.max(1, laneEnds.length) };
}
