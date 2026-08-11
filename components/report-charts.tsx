import type { BarChart } from "@/lib/reports/charts";

/**
 * The one renderer for every chart on `/admin/reports`.
 *
 * A plain server component — no client directive, no hook, no measurement — and
 * therefore no chart library: `lib/reports/charts.ts` has already decided every
 * rectangle, so this file only maps them onto `<rect>` elements. That is also
 * why there is no dependency to add; a charting package would ship a client
 * bundle to draw what the server can emit as markup.
 *
 * The layout is deliberately half HTML and half SVG. The bar track is SVG with
 * a `0 0 100 h` viewBox and `preserveAspectRatio="none"`, so widths are
 * percentages that stretch to whatever the card is wide — but the names and
 * values stay HTML text, because text inside a stretched viewBox scales with it
 * and would render at a few pixels on a phone. Only rectangles are in the
 * viewBox, and a rectangle is exactly what should stretch.
 *
 * Accessibility: the row group is one `role="img"` with a summarizing label —
 * the same pattern the page's existing `.progress-bar` cells already use — and
 * the precise figures are in the table or list rendered directly below every
 * chart. The chart is an enhancement; the table is the source of truth.
 */

/** Track height in viewBox units. Only rects live here, so the unit is free. */
const TRACK_HEIGHT = 10;

export function ReportChart({
  chart,
  heading,
  caption,
}: {
  chart: BarChart;
  /** Names the slice a chart covers — the day, for the per-day room charts. */
  heading?: string;
  caption?: string;
}) {
  return (
    <figure className="report-chart">
      {heading ? <p className="report-chart-heading">{heading}</p> : null}
      <div className="report-chart-rows" role="img" aria-label={chart.ariaLabel}>
        {chart.bars.map((bar) => (
          <div className="report-chart-row" key={bar.key}>
            <span className="report-chart-name" title={bar.truncated ? bar.label : undefined}>
              {bar.display}
            </span>
            <svg
              className="report-chart-track"
              viewBox={`0 0 100 ${TRACK_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              {bar.segments.map((segment) => (
                <rect
                  key={segment.key}
                  className={`report-chart-fill chart-${segment.tone}`}
                  x={segment.x}
                  y={0}
                  width={segment.width}
                  height={TRACK_HEIGHT}
                >
                  <title>{segment.title}</title>
                </rect>
              ))}
            </svg>
            <span className="report-chart-value">
              {bar.value}
              {bar.note ? <em className="report-chart-note">{bar.note}</em> : null}
            </span>
          </div>
        ))}
      </div>
      {chart.legend.length > 0 ? (
        <ul className="report-chart-legend">
          {chart.legend.map((item) => (
            <li key={item.key}>
              <span className={`report-chart-swatch chart-${item.tone}`} aria-hidden="true" />
              {item.label}
              {item.value ? <strong>{item.value}</strong> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {caption ? <figcaption className="report-chart-caption">{caption}</figcaption> : null}
    </figure>
  );
}
