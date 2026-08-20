/** @typedef {{ since: Date, until: Date, reportTuesday: Date }} WeeklyWindow */

const TUESDAY = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Local midnight for a calendar day.
 * @param {Date} date
 */
export function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/**
 * Local end of day (23:59:59.999).
 * @param {Date} date
 */
export function endOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/**
 * Calendar days since the most recent Tuesday (0 when `date` is a Tuesday).
 * @param {Date} date
 */
export function daysSinceTuesday(date) {
  return (date.getDay() + 7 - TUESDAY) % 7;
}

/**
 * The Tuesday this weekly report closes on.
 * When run on Tuesday → today; Wed–Mon → the most recent Tuesday.
 * @param {Date} [now]
 */
export function getReportTuesday(now = new Date()) {
  const reportTuesday = startOfLocalDay(now);
  reportTuesday.setDate(reportTuesday.getDate() - daysSinceTuesday(now));
  return reportTuesday;
}

/**
 * Git commit window for the weekly report:
 * **previous Tuesday 00:00** (inclusive) → **report Tuesday** (inclusive).
 *
 * When the shortcut runs on report Tuesday, `until` is the current time so
 * same-day commits before the run are included. When run later (e.g. test on
 * Wednesday), `until` is the end of report Tuesday — no spill into the next day.
 *
 * @param {Date} [now]
 * @returns {WeeklyWindow}
 */
export function getWeeklyWindow(now = new Date()) {
  const reportTuesday = getReportTuesday(now);

  const since = new Date(reportTuesday);
  since.setDate(since.getDate() - 7);

  const reportTuesdayEnd = endOfLocalDay(reportTuesday);
  const runningOnReportTuesday =
    startOfLocalDay(now).getTime() === reportTuesday.getTime();

  const until = runningOnReportTuesday
    ? new Date(Math.min(now.getTime(), reportTuesdayEnd.getTime()))
    : reportTuesdayEnd;

  return { since, until, reportTuesday };
}

/**
 * @param {Date} date
 */
export function formatDateDisplay(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Human-readable Tue → Tue label for logs and the Cliq header.
 * @param {WeeklyWindow} window
 */
export function formatWeekRange({ since, reportTuesday }) {
  return `${formatDateDisplay(since)} – ${formatDateDisplay(reportTuesday)}`;
}

/**
 * `git log --since/--until` string in local time.
 * @param {Date} date
 */
export function formatLocalGitTimestamp(date) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Quick sanity check that the window spans exactly seven calendar days.
 * @param {WeeklyWindow} window
 */
export function isFullWeekWindow(window) {
  const days = (window.reportTuesday.getTime() - window.since.getTime()) / MS_PER_DAY;
  return days === 7;
}
