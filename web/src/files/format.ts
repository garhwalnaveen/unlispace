import { ApiError, type DriveApiError } from "../api";
import { baseName } from "./paths";

const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
/** "Today 4:12 PM", "Yesterday 4:12 PM", "Tuesday 4:12 PM", then a calendar date. */
export function friendlyDate(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  const days = Math.round((dayStart(new Date(now)) - dayStart(date)) / 86_400_000);
  if (days === 0) return `Today ${time(date)}`;
  if (days === 1) return `Yesterday ${time(date)}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time(date)}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}, ${time(date)}`;
}
export const exactDate = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? undefined : new Date(ms).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
export const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** Plain-language reasons for a refused file operation. */
export function fileError(error: unknown): string {
  if (error instanceof ApiError) {
    const named = (error as DriveApiError).path ? `“${baseName((error as DriveApiError).path!)}”` : "An item";
    const messages: Record<string, string> = {
      precondition_failed: `${named} changed while you were working. Nothing was changed — check the latest list and try again.`,
      path_conflict: `${named} already exists there. Rename one of them, then try again.`,
      no_such_path: `${named} can’t be found. It may have been moved or deleted.`,
      no_such_version: "That version is no longer available.",
      not_restorable: "That entry has no file contents to restore.",
      subtree_too_large: "This folder holds too many items to change in one go. Open it and work on smaller parts, or use Finder.",
      path_too_long: "That would make the location too long. Use a shorter name or a folder closer to the top of the drive.",
      bad_path: "That name contains characters Orbit can’t store. Choose another name.",
      over_quota: "Your files are safe. This workspace can’t take changes right now — check the plan and storage in Billing.",
      quota_exceeded: "Your files are safe. This workspace is out of storage — add storage in Billing to keep uploading.",
      forbidden: "You can view this drive, but you can’t change it.",
      no_such_drive: "This drive is no longer available.",
      unauthorized: "Your session has ended. Sign in again to continue.",
    };
    if (messages[error.code]) return messages[error.code];
    if (error.code === "bad_request" && /into itself/.test(error.message)) return "A folder can’t be moved into itself.";
    if (error.status >= 500) return "Orbit couldn’t finish that just now. Your files are safe — try again in a moment.";
    return error.message && error.message !== error.code ? error.message : "Orbit couldn’t finish that. Try again.";
  }
  if (error instanceof TypeError) return "Orbit couldn’t be reached. Check your connection and try again.";
  return error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
}
