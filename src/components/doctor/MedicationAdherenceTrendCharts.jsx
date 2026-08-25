import { useId, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import "../../styles/medication-adherence-trends.css";

const chartWidth = 640;
const chartHeight = 280;
const chartMargins = { top: 24, right: 18, bottom: 48, left: 46 };
const plotWidth = chartWidth - chartMargins.left - chartMargins.right;
const plotHeight = chartHeight - chartMargins.top - chartMargins.bottom;
const yTicks = [0, 25, 50, 75, 100];

function getX(index, count) {
  if (count <= 1) return chartMargins.left + plotWidth / 2;
  return chartMargins.left + (index / (count - 1)) * plotWidth;
}

function getBarX(index, count) {
  const slotWidth = plotWidth / Math.max(1, count);
  return chartMargins.left + index * slotWidth + slotWidth / 2;
}

function getY(value) {
  return chartMargins.top + plotHeight - (value / 100) * plotHeight;
}

function shouldShowAxisLabel(index, count) {
  if (count <= 10) return true;
  const interval =
    count <= 20 ? 2 : Math.max(1, Math.ceil((count - 1) / 6));
  return index === 0 || index === count - 1 || index % interval === 0;
}

function buildLineSegments(data) {
  const segments = [];
  let current = [];

  data.forEach((day, index) => {
    if (day.adherenceRate === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push({ day, index });
  });

  if (current.length) segments.push(current);
  return segments;
}

function formatRate(value) {
  return value === null ? "No completed outcomes" : `${value}%`;
}

function formatChange(value) {
  if (value === null) return "Not available";
  if (value === 0) return "No change";
  return `${value > 0 ? "+" : ""}${value} percentage points`;
}

function getRangeLabel(data) {
  if (!data.length) return "No date range";
  if (data.length === 1) return data[0].dateLabel;
  return `${data[0].dateLabel} - ${data.at(-1).dateLabel}`;
}

function TrendTooltip({ day, mode }) {
  const announcement = day
    ? [
        day.dateLabel,
        mode === "rate" ? `Adherence ${formatRate(day.adherenceRate)}` : "",
        `Taken ${day.taken}`,
        `Skipped ${day.skipped}`,
        `Missed ${day.missed}`,
        `Completed outcomes ${day.completedOutcomes}`,
      ]
        .filter(Boolean)
        .join(". ")
    : "";

  return (
    <>
      {day ? (
        <div className="mr-trend-tooltip" aria-hidden="true">
          <strong>{day.dateLabel}</strong>
          {mode === "rate" ? <span>Adherence: {formatRate(day.adherenceRate)}</span> : null}
          <span>Taken: {day.taken}</span>
          <span>Skipped: {day.skipped}</span>
          <span>Missed: {day.missed}</span>
          <span>Completed outcomes: {day.completedOutcomes}</span>
        </div>
      ) : null}
      <div
        className="mr-trend-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </>
  );
}

function DailyAdherenceLineChart({ data }) {
  const [activeDay, setActiveDay] = useState(null);
  const titleId = useId();
  const descriptionId = useId();
  const segments = useMemo(() => buildLineSegments(data), [data]);
  const hasOutcomes = data.some((day) => day.completedOutcomes > 0);

  if (!hasOutcomes) {
    return (
      <article className="mr-trend-chart-card">
        <header>
          <div>
            <h3>Daily Adherence Rate</h3>
            <p>Taken doses as a share of completed outcomes.</p>
          </div>
        </header>
        <div className="mr-trend-chart-empty">
          <Icon icon="solar:chart-2-linear" aria-hidden="true" />
          <span>No completed medication outcomes are available for this date range.</span>
        </div>
      </article>
    );
  }

  return (
    <article className={`mr-trend-chart-card${data.length === 1 ? " is-single-day" : ""}`}>
      <header>
        <div>
          <h3 id={titleId}>Daily Adherence Rate</h3>
          <p>Taken doses as a share of completed outcomes.</p>
        </div>
      </header>
      <TrendTooltip day={activeDay} mode="rate" />
      <div className="mr-trend-svg-wrap">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
        >
          <desc id={descriptionId}>
            Daily medication adherence from zero to one hundred percent. Missing
            points represent dates with no completed outcomes.
          </desc>
          {yTicks.map((tick) => {
            const y = getY(tick);
            return (
              <g key={tick} aria-hidden="true">
                <line
                  className="mr-trend-grid-line"
                  x1={chartMargins.left}
                  x2={chartWidth - chartMargins.right}
                  y1={y}
                  y2={y}
                />
                <text className="mr-trend-y-label" x={chartMargins.left - 9} y={y + 4}>
                  {tick}%
                </text>
              </g>
            );
          })}

          {segments.map((segment) => (
            <path
              key={`${segment[0].day.dateKey}-${segment.at(-1).day.dateKey}`}
              className="mr-trend-rate-line"
              d={segment
                .map(({ day, index }, segmentIndex) => {
                  const x = getX(index, data.length);
                  const y = getY(day.adherenceRate);
                  return `${segmentIndex ? "L" : "M"} ${x} ${y}`;
                })
                .join(" ")}
              fill="none"
            />
          ))}

          {data.map((day, index) => {
            const x = getX(index, data.length);
            const isMissing = day.adherenceRate === null;
            const axisLabelVisible = shouldShowAxisLabel(index, data.length);
            const ariaLabel = `${day.dateLabel}. Adherence ${day.adherenceRate} percent. Taken ${day.taken}, skipped ${day.skipped}, missed ${day.missed}, completed outcomes ${day.completedOutcomes}.`;

            return (
              <g key={day.dateKey}>
                {!isMissing ? (
                  <circle
                    className="mr-trend-rate-point"
                    cx={x}
                    cy={getY(day.adherenceRate)}
                    r={6}
                    tabIndex={0}
                    role="img"
                    aria-label={ariaLabel}
                    onFocus={() => setActiveDay(day)}
                    onBlur={() => setActiveDay(null)}
                    onMouseEnter={() => setActiveDay(day)}
                    onMouseLeave={() => setActiveDay(null)}
                  >
                    <title>{ariaLabel}</title>
                  </circle>
                ) : null}
                {axisLabelVisible ? (
                  <text
                    className="mr-trend-x-label"
                    x={x}
                    y={chartHeight - 19}
                    textAnchor="middle"
                  >
                    {day.shortLabel}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </article>
  );
}

function DailyMedicationOutcomeChart({ data }) {
  const [activeDay, setActiveDay] = useState(null);
  const titleId = useId();
  const descriptionId = useId();
  const maxOutcomes = Math.max(1, ...data.map((day) => day.completedOutcomes));
  const hasOutcomes = data.some((day) => day.completedOutcomes > 0);
  const slotWidth = plotWidth / Math.max(1, data.length);
  const barWidth = Math.max(1.5, Math.min(28, slotWidth * 0.66));

  if (!hasOutcomes) {
    return (
      <article className="mr-trend-chart-card">
        <header>
          <div>
            <h3>Daily Medication Outcomes</h3>
            <p>Taken, skipped, and missed outcomes by Manila date.</p>
          </div>
        </header>
        <div className="mr-trend-chart-empty">
          <Icon icon="solar:chart-square-linear" aria-hidden="true" />
          <span>No completed medication outcomes are available for this date range.</span>
        </div>
      </article>
    );
  }

  return (
    <article className={`mr-trend-chart-card${data.length === 1 ? " is-single-day" : ""}`}>
      <header>
        <div>
          <h3 id={titleId}>Daily Medication Outcomes</h3>
          <p>Taken, skipped, and missed outcomes by Manila date.</p>
        </div>
      </header>
      <div className="mr-trend-legend" aria-label="Medication outcome legend">
        <span className="is-taken"><i aria-hidden="true" />Taken</span>
        <span className="is-skipped"><i aria-hidden="true" />Skipped</span>
        <span className="is-missed"><i aria-hidden="true" />Missed</span>
      </div>
      <TrendTooltip day={activeDay} mode="outcomes" />
      <div className="mr-trend-svg-wrap">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
        >
          <desc id={descriptionId}>
            Stacked daily counts of Taken, Skipped, and Missed medication outcomes.
          </desc>
          <line
            className="mr-trend-axis-line"
            x1={chartMargins.left}
            x2={chartWidth - chartMargins.right}
            y1={chartMargins.top + plotHeight}
            y2={chartMargins.top + plotHeight}
          />
          {data.map((day, index) => {
            const x = getBarX(index, data.length);
            const scale = plotHeight / maxOutcomes;
            const takenHeight = day.taken * scale;
            const skippedHeight = day.skipped * scale;
            const missedHeight = day.missed * scale;
            const baseline = chartMargins.top + plotHeight;
            const axisLabelVisible = shouldShowAxisLabel(index, data.length);
            const ariaLabel = `${day.dateLabel}. Taken ${day.taken}, skipped ${day.skipped}, missed ${day.missed}, completed outcomes ${day.completedOutcomes}.`;

            return (
              <g key={day.dateKey}>
                {day.completedOutcomes ? (
                  <g
                    tabIndex={0}
                    role="img"
                    aria-label={ariaLabel}
                    onFocus={() => setActiveDay(day)}
                    onBlur={() => setActiveDay(null)}
                    onMouseEnter={() => setActiveDay(day)}
                    onMouseLeave={() => setActiveDay(null)}
                  >
                    <title>{ariaLabel}</title>
                    <rect
                      className="mr-trend-bar is-taken"
                      x={x - barWidth / 2}
                      y={baseline - takenHeight}
                      width={barWidth}
                      height={takenHeight}
                    />
                    <rect
                      className="mr-trend-bar is-skipped"
                      x={x - barWidth / 2}
                      y={baseline - takenHeight - skippedHeight}
                      width={barWidth}
                      height={skippedHeight}
                    />
                    <rect
                      className="mr-trend-bar is-missed"
                      x={x - barWidth / 2}
                      y={baseline - takenHeight - skippedHeight - missedHeight}
                      width={barWidth}
                      height={missedHeight}
                    />
                  </g>
                ) : null}
                {axisLabelVisible ? (
                  <text
                    className="mr-trend-x-label"
                    x={x}
                    y={chartHeight - 19}
                    textAnchor="middle"
                  >
                    {day.shortLabel}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </article>
  );
}

function ComparisonSummary({ trendData }) {
  const { currentSummary, previousSummary, comparison, dailyCurrent, dailyPrevious } =
    trendData;

  return (
    <div className="mr-trend-comparison" aria-label="Medication adherence period comparison">
      <div>
        <span>Current period adherence</span>
        <strong>{formatRate(currentSummary.adherenceRate)}</strong>
        <small>{getRangeLabel(dailyCurrent)}</small>
      </div>
      <div>
        <span>Previous period adherence</span>
        <strong>{formatRate(previousSummary.adherenceRate)}</strong>
        <small>{getRangeLabel(dailyPrevious)}</small>
      </div>
      <div>
        <span>Change</span>
        <strong className={comparison.changePercentagePoints > 0 ? "is-positive" : comparison.changePercentagePoints < 0 ? "is-negative" : ""}>
          {formatChange(comparison.changePercentagePoints)}
        </strong>
        <small>{comparison.interpretation}</small>
      </div>
      <div>
        <span>Current completed outcomes</span>
        <strong>{currentSummary.completedOutcomes}</strong>
      </div>
      <div>
        <span>Previous completed outcomes</span>
        <strong>{previousSummary.completedOutcomes}</strong>
      </div>
      {comparison.isLimitedData ? (
        <span className="mr-trend-limited">
          <Icon icon="solar:info-circle-linear" aria-hidden="true" />
          Limited data
        </span>
      ) : null}
    </div>
  );
}

function TrendDataTable({ data }) {
  return (
    <details className="mr-trend-data-details">
      <summary>View chart data</summary>
      <div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Taken</th>
              <th>Skipped</th>
              <th>Missed</th>
              <th>Completed Outcomes</th>
              <th>Adherence Rate</th>
            </tr>
          </thead>
          <tbody>
            {data.map((day) => (
              <tr key={day.dateKey}>
                <td>{day.dateLabel}</td>
                <td>{day.taken}</td>
                <td>{day.skipped}</td>
                <td>{day.missed}</td>
                <td>{day.completedOutcomes}</td>
                <td>{day.adherenceRate === null ? "No data" : `${day.adherenceRate}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default function MedicationAdherenceTrendCharts({
  trendData,
  status,
  onRetry,
}) {
  return (
    <section className="mr-trends" aria-labelledby="mr-trends-title">
      <header className="mr-trends-header">
        <div>
          <h2 id="mr-trends-title">Medication Adherence Trends</h2>
          <p>Daily medication outcomes for the selected date range.</p>
        </div>
      </header>

      {status === "loading" ? (
        <div className="mr-trend-loading" aria-label="Loading medication adherence trends">
          <span />
          <span />
        </div>
      ) : status === "error" ? (
        <div className="mr-trend-state is-error" role="alert">
          <Icon icon="solar:danger-circle-linear" aria-hidden="true" />
          <p>Medication adherence trends could not be loaded.</p>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      ) : trendData?.dailyCurrent?.length ? (
        <>
          <ComparisonSummary trendData={trendData} />
          {trendData.previousSummary.completedOutcomes === 0 ? (
            <p className="mr-trend-previous-empty">
              No previous-period adherence data is available.
            </p>
          ) : null}
          {trendData.currentSummary.completedOutcomes > 0 ? (
            <div className="mr-trend-chart-grid">
              <DailyAdherenceLineChart data={trendData.dailyCurrent} />
              <DailyMedicationOutcomeChart data={trendData.dailyCurrent} />
            </div>
          ) : (
            <div className="mr-trend-state">
              <Icon icon="solar:chart-2-linear" aria-hidden="true" />
              <p>No completed medication outcomes are available for this date range.</p>
            </div>
          )}
          <TrendDataTable data={trendData.dailyCurrent} />
        </>
      ) : (
        <div className="mr-trend-state">
          <Icon icon="solar:chart-2-linear" aria-hidden="true" />
          <p>No completed medication outcomes are available for this date range.</p>
        </div>
      )}
    </section>
  );
}
