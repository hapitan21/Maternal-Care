import {
  formatAppointmentDate,
  formatAppointmentTime,
} from "../../lib/appointmentDate";
import {
  formatMedicationFollowupDate,
  formatMedicationFollowupDateTime,
  formatMedicationFollowupRate,
  formatMedicationFollowupSeverity,
  formatMedicationFollowupStatus,
} from "../../lib/medicationAdherenceFollowups";
import { formatReportTimestamp } from "../../lib/reportExport";
import {
  PrintableMetricGrid,
  PrintableReportFooter,
  PrintableReportHeader,
  PrintableReportPortal,
} from "./PrintableReportLayout";

const chartWidth = 680;
const chartHeight = 240;
const chartMargin = { top: 20, right: 16, bottom: 40, left: 42 };
const plotWidth = chartWidth - chartMargin.left - chartMargin.right;
const plotHeight = chartHeight - chartMargin.top - chartMargin.bottom;

function shouldShowAxisLabel(index, count) {
  if (count <= 10) return true;
  const interval =
    count <= 20 ? 2 : Math.max(1, Math.ceil((count - 1) / 6));
  return index === 0 || index === count - 1 || index % interval === 0;
}

function getX(index, count) {
  if (count <= 1) return chartMargin.left + plotWidth / 2;
  return chartMargin.left + (index / (count - 1)) * plotWidth;
}

function getY(value) {
  return chartMargin.top + plotHeight - (value / 100) * plotHeight;
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

function PrintableAdherenceCharts({ daily }) {
  const hasOutcomes = daily.some((day) => day.completedOutcomes > 0);
  const maxOutcomes = Math.max(1, ...daily.map((day) => day.completedOutcomes));
  const slotWidth = plotWidth / Math.max(1, daily.length);
  const barWidth = Math.max(2, Math.min(22, slotWidth * 0.64));

  if (!hasOutcomes) {
    return (
      <section className="report-print-section">
        <h2>Medication Adherence Charts</h2>
        <p>No medication adherence records are available for this date range.</p>
      </section>
    );
  }

  return (
    <section className="report-print-chart-grid">
      <article className="report-print-chart">
        <h2>Daily Adherence Rate</h2>
        <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img">
          <title>Daily Adherence Rate</title>
          {[0, 25, 50, 75, 100].map((tick) => (
            <g key={tick}>
              <line
                className="report-print-grid-line"
                x1={chartMargin.left}
                x2={chartWidth - chartMargin.right}
                y1={getY(tick)}
                y2={getY(tick)}
              />
              <text x={chartMargin.left - 8} y={getY(tick) + 4} textAnchor="end">
                {tick}%
              </text>
            </g>
          ))}
          {buildLineSegments(daily).map((segment) => (
            <path
              key={`${segment[0].day.dateKey}-${segment.at(-1).day.dateKey}`}
              className="report-print-adherence-line"
              d={segment
                .map(({ day, index }, segmentIndex) =>
                  `${segmentIndex ? "L" : "M"} ${getX(index, daily.length)} ${getY(
                    day.adherenceRate
                  )}`
                )
                .join(" ")}
              fill="none"
            />
          ))}
          {daily.map((day, index) => (
            <g key={day.dateKey}>
              {day.adherenceRate !== null ? (
                <circle
                  className="report-print-adherence-point"
                  cx={getX(index, daily.length)}
                  cy={getY(day.adherenceRate)}
                  r="4"
                />
              ) : null}
              {shouldShowAxisLabel(index, daily.length) ? (
                <text
                  x={getX(index, daily.length)}
                  y={chartHeight - 15}
                  textAnchor="middle"
                >
                  {day.shortLabel}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      </article>

      <article className="report-print-chart">
        <h2>Daily Medication Outcomes</h2>
        <div className="report-print-legend">
          <span><i className="is-taken" />Taken</span>
          <span><i className="is-skipped" />Skipped</span>
          <span><i className="is-missed" />Missed</span>
        </div>
        <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img">
          <title>Daily Medication Outcomes</title>
          <line
            className="report-print-axis-line"
            x1={chartMargin.left}
            x2={chartWidth - chartMargin.right}
            y1={chartMargin.top + plotHeight}
            y2={chartMargin.top + plotHeight}
          />
          {daily.map((day, index) => {
            const center = chartMargin.left + index * slotWidth + slotWidth / 2;
            const scale = plotHeight / maxOutcomes;
            const takenHeight = day.taken * scale;
            const skippedHeight = day.skipped * scale;
            const missedHeight = day.missed * scale;
            const baseline = chartMargin.top + plotHeight;

            return (
              <g key={day.dateKey}>
                {day.taken > 0 ? (
                  <rect
                    className="report-print-outcome-bar is-taken"
                    x={center - barWidth / 2}
                    y={baseline - takenHeight}
                    width={barWidth}
                    height={takenHeight}
                  />
                ) : null}
                {day.skipped > 0 ? (
                  <rect
                    className="report-print-outcome-bar is-skipped"
                    x={center - barWidth / 2}
                    y={baseline - takenHeight - skippedHeight}
                    width={barWidth}
                    height={skippedHeight}
                  />
                ) : null}
                {day.missed > 0 ? (
                  <rect
                    className="report-print-outcome-bar is-missed"
                    x={center - barWidth / 2}
                    y={baseline - takenHeight - skippedHeight - missedHeight}
                    width={barWidth}
                    height={missedHeight}
                  />
                ) : null}
                {shouldShowAxisLabel(index, daily.length) ? (
                  <text x={center} y={chartHeight - 15} textAnchor="middle">
                    {day.shortLabel}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </article>
    </section>
  );
}

function getAssignedDoctorName(followup) {
  const doctor = Array.isArray(followup?.assigned_doctor)
    ? followup.assigned_doctor[0]
    : followup?.assigned_doctor;
  return doctor?.full_name || "Assigned Doctor";
}

function PrintableFollowups({ activeFollowup, followups }) {
  const resolved = (followups || []).filter(
    (followup) => followup.status === "resolved"
  );

  return (
    <>
      <section className="report-print-section">
        <h2>Active Follow-up Summary</h2>
        {activeFollowup ? (
          <dl className="report-print-definition-grid">
            <div><dt>Status</dt><dd>{formatMedicationFollowupStatus(activeFollowup.status)}</dd></div>
            <div><dt>Assigned Doctor</dt><dd>{getAssignedDoctorName(activeFollowup)}</dd></div>
            <div><dt>Started</dt><dd>{formatMedicationFollowupDate(activeFollowup.created_at)}</dd></div>
            <div><dt>Last Confirmed Contact</dt><dd>{formatMedicationFollowupDateTime(activeFollowup.last_contacted_at, "Not available")}</dd></div>
            <div><dt>Next Follow-up</dt><dd>{formatMedicationFollowupDateTime(activeFollowup.next_follow_up_at, "Not available")}</dd></div>
            <div><dt>Original Severity</dt><dd>{formatMedicationFollowupSeverity(activeFollowup.severity_snapshot)}</dd></div>
          </dl>
        ) : (
          <p>No active medication adherence follow-up.</p>
        )}
      </section>

      <section className="report-print-section">
        <h2>Previous Follow-ups</h2>
        {resolved.length ? (
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Resolved</th>
                <th>Original Severity</th>
                <th>Snapshot Adherence</th>
                <th>Assigned Doctor</th>
                <th>Resolution Summary</th>
              </tr>
            </thead>
            <tbody>
              {resolved.map((followup) => (
                <tr key={followup.id}>
                  <td>{formatMedicationFollowupDate(followup.created_at)}</td>
                  <td>{formatMedicationFollowupDate(followup.resolved_at)}</td>
                  <td>{formatMedicationFollowupSeverity(followup.severity_snapshot)}</td>
                  <td>{formatMedicationFollowupRate(followup.adherence_rate_snapshot)}</td>
                  <td>{getAssignedDoctorName(followup)}</td>
                  <td>{followup.resolution_summary || "Not recorded"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No previous medication adherence follow-ups.</p>
        )}
      </section>
    </>
  );
}

export default function MedicationAdherencePrintableReport({
  patient,
  doctorName,
  dateRange,
  statusFilter,
  generatedAt,
  trendData,
  historyRows,
  activeFollowup,
  followups,
}) {
  const current = trendData.currentSummary;
  const previous = trendData.previousSummary;
  const comparison = trendData.comparison;
  const reportPeriod = `${formatAppointmentDate(
    `${dateRange.startDate}T00:00:00+08:00`
  )} - ${formatAppointmentDate(`${dateRange.endDate}T00:00:00+08:00`)}`;

  return (
    <PrintableReportPortal className="report-print-patient">
      <PrintableReportHeader
        title="Medication Adherence Report"
        details={[
          { label: "Patient", value: patient?.full_name || "Patient" },
          { label: "Patient ID", value: patient?.patient_id || "Not assigned" },
          { label: "Doctor", value: doctorName || "Doctor" },
          { label: "Report Period", value: reportPeriod },
          { label: "History Filter", value: statusFilter },
          { label: "Generated", value: formatReportTimestamp(generatedAt) },
        ]}
      />

      <PrintableMetricGrid
        title="Medication Adherence Summary"
        metrics={[
          { label: "Total Completed Outcomes", value: current.completedOutcomes },
          { label: "Taken", value: current.taken },
          { label: "Skipped", value: current.skipped },
          { label: "Missed", value: current.missed },
          {
            label: "Adherence Rate",
            value:
              current.adherenceRate === null
                ? "No completed outcomes"
                : `${current.adherenceRate}%`,
          },
        ]}
      />

      <PrintableMetricGrid
        title="Period Comparison"
        metrics={[
          {
            label: "Current Period Adherence",
            value:
              current.adherenceRate === null
                ? "No completed outcomes"
                : `${current.adherenceRate}%`,
          },
          {
            label: "Previous Period Adherence",
            value:
              previous.adherenceRate === null
                ? "No completed outcomes"
                : `${previous.adherenceRate}%`,
          },
          {
            label: "Percentage-point Change",
            value:
              comparison.changePercentagePoints === null
                ? "Not available"
                : `${comparison.changePercentagePoints > 0 ? "+" : ""}${
                    comparison.changePercentagePoints
                  } percentage points`,
          },
          {
            label: "Data Status",
            value: comparison.isLimitedData ? "Limited data" : "Sufficient data",
          },
        ]}
      />

      <PrintableAdherenceCharts daily={trendData.dailyCurrent} />

      <section className="report-print-section">
        <h2>Chart Data Summary</h2>
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
            {trendData.dailyCurrent.map((day) => (
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
      </section>

      <section className="report-print-section">
        <h2>Adherence History</h2>
        <p>History filter: {statusFilter}</p>
        {historyRows.length ? (
          <table>
            <thead>
              <tr>
                <th>Scheduled Date</th>
                <th>Scheduled Time</th>
                <th>Medication</th>
                <th>Dosage</th>
                <th>Status</th>
                <th>Response Time</th>
              </tr>
            </thead>
            <tbody>
              {historyRows.map((row) => (
                <tr key={row.id}>
                  <td>{formatAppointmentDate(row.scheduled_for)}</td>
                  <td>{formatAppointmentTime(row.scheduled_for)}</td>
                  <td>{row.medicationName}</td>
                  <td>{row.dosage}</td>
                  <td>{row.statusLabel}</td>
                  <td>{row.responseTime || "Not available"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No medication adherence records are available for this date range.</p>
        )}
      </section>

      <PrintableFollowups activeFollowup={activeFollowup} followups={followups} />
      <PrintableReportFooter generatedAt={generatedAt} />
    </PrintableReportPortal>
  );
}
