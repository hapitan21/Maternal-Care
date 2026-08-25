import {
  formatAppointmentDate,
  formatAppointmentTime,
} from "./appointmentDate.js";

const spreadsheetFormulaPattern = /^[\t\r\n ]*[=+\-@]/;
const forbiddenFilenamePattern = /[<>:"/\\|?*]/g;
const activePageStyleId = "active-report-page-style";
const printFallbackCleanupMs = 60_000;

export function sanitizeSpreadsheetCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint") return String(value);

  const text = String(value);
  return spreadsheetFormulaPattern.test(text) ? `'${text}` : text;
}

export function escapeCsvCell(value) {
  const text = sanitizeSpreadsheetCell(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv(rows) {
  const csvRows = (Array.isArray(rows) ? rows : []).map((row) =>
    (Array.isArray(row) ? row : [row]).map(escapeCsvCell).join(",")
  );
  return `\ufeff${csvRows.join("\r\n")}`;
}

export function sanitizeFilename(value, fallback = "report") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(forbiddenFilenamePattern, "-")
    .toLowerCase()
    .replace(/[^a-z0-9._ -]+/g, "-")
    .replace(/[\s_-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 140)
    .replace(/[.\s-]+$/g, "");

  return normalized || fallback;
}

export function formatDateRangeFilenameSegment(startDate, endDate) {
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  if (!isDate(startDate) || !isDate(endDate)) return "date-range";
  return `${startDate}-to-${endDate}`;
}

export function formatReportTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return `${formatAppointmentDate(date)} at ${formatAppointmentTime(date)}`;
}

export function downloadCsv({ filename, rows }) {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined"
  ) {
    throw new Error("Browser download APIs are unavailable.");
  }

  const safeBaseName = sanitizeFilename(
    String(filename || "").replace(/\.csv$/i, "")
  );
  const blob = new Blob([buildCsv(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  try {
    link.href = objectUrl;
    link.download = `${safeBaseName}.csv`;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

function nextAnimationFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

function createPageStyle({ pageSize, pageMargin }) {
  document.getElementById(activePageStyleId)?.remove();

  const style = document.createElement("style");
  style.id = activePageStyleId;
  style.media = "print";
  style.textContent = `@page { size: ${pageSize}; margin: ${pageMargin}; }`;
  document.head.appendChild(style);
  return style;
}

async function getReadyPrintRoot(rootSelector) {
  await nextAnimationFrame();
  await nextAnimationFrame();

  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  const roots = document.querySelectorAll(rootSelector);
  if (roots.length !== 1) {
    throw new Error("Expected exactly one printable report root.");
  }

  const root = roots[0];
  if (!root.textContent?.trim() || root.scrollHeight <= 0) {
    throw new Error("Printable report content is not ready.");
  }

  return root;
}

function waitForPrintCompletion() {
  return new Promise((resolve, reject) => {
    const supportsAfterPrint = "onafterprint" in window;
    const printMedia = !supportsAfterPrint && window.matchMedia
      ? window.matchMedia("print")
      : null;
    let fallbackTimer = null;
    let settled = false;

    const removeListeners = () => {
      window.removeEventListener("afterprint", finish);
      printMedia?.removeEventListener?.("change", handlePrintMediaChange);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      removeListeners();
      resolve();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      removeListeners();
      reject(error);
    };

    const handlePrintMediaChange = (event) => {
      if (!event.matches) finish();
    };

    if (supportsAfterPrint) {
      window.addEventListener("afterprint", finish, { once: true });
    } else {
      printMedia?.addEventListener?.("change", handlePrintMediaChange);
      fallbackTimer = window.setTimeout(finish, printFallbackCleanupMs);
    }

    try {
      window.print();
    } catch (error) {
      fail(error);
    }
  });
}

export async function printReport({
  bodyClass,
  documentTitle,
  rootSelector = ".report-print-root",
  pageSize = "A4 portrait",
  pageMargin = "12mm",
}) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Browser print APIs are unavailable.");
  }

  const previousTitle = document.title;
  const previousFocus = document.activeElement;
  const classes = ["is-printing-report", "is-preparing-report", bodyClass].filter(
    Boolean
  );
  let pageStyle = null;

  document.body.classList.add(...classes);
  if (documentTitle) document.title = documentTitle;

  try {
    pageStyle = createPageStyle({ pageSize, pageMargin });
    await getReadyPrintRoot(rootSelector);
    await waitForPrintCompletion();
  } finally {
    document.body.classList.remove(...classes);
    pageStyle?.remove();
    document.title = previousTitle;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus();
    }
  }
}
