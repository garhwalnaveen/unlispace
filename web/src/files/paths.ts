import {
  File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation,
  type LucideIcon,
} from "lucide-react";

/** A folder path is "" for the drive itself, otherwise it ends with "/". */
export const asFolder = (path: string) => (path && !path.endsWith("/") ? `${path}/` : path);
export const baseName = (path: string) => path.replace(/\/$/, "").split("/").pop() || "";
export const parentFolder = (path: string) => {
  const trimmed = path.replace(/\/$/, "");
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
};
/** The path the data plane expects for `name` inside `folder`. */
export const childPath = (folder: string, name: string, isFolder: boolean) => `${folder}${name}${isFolder ? "/" : ""}`;
/** Drops items that sit inside a folder that is also in the list: acting on the folder already covers them. */
export const outermost = <T extends { path: string; isFolder: boolean }>(items: T[]): T[] => {
  const folders = items.filter((item) => item.isFolder).map((item) => item.path);
  return items.filter((item) => !folders.some((folder) => item.path !== folder && item.path.startsWith(folder)));
};
export const folderSegments = (folder: string) => folder.split("/").filter(Boolean);

/** Why `name` cannot be used for a file or folder, or null when it can. */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return "Enter a name.";
  if (name !== name.trim()) return "Names can’t start or end with a space.";
  if (name.includes("/")) return "Names can’t contain a slash (/).";
  if (name === "." || name === "..") return "That name is reserved. Choose another.";
  if (/[\u0000-\u001f]/.test(name)) return "Names can’t contain line breaks or control characters.";
  if (new TextEncoder().encode(name).length > 255) return "That name is too long. Use 255 characters or fewer.";
  return null;
}

const extension = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
const KINDS: [string, LucideIcon, string[]][] = [
  ["Image", FileImage, ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "heic", "tiff", "bmp", "psd", "ai", "fig", "sketch"]],
  ["Video", FileVideo, ["mp4", "mov", "mkv", "webm", "avi", "m4v"]],
  ["Audio", FileAudio, ["mp3", "wav", "aac", "flac", "m4a", "ogg", "aiff"]],
  ["PDF document", FileText, ["pdf"]],
  ["Spreadsheet", FileSpreadsheet, ["xls", "xlsx", "csv", "numbers", "tsv"]],
  ["Presentation", Presentation, ["ppt", "pptx", "key"]],
  ["Archive", FileArchive, ["zip", "tar", "gz", "tgz", "rar", "7z", "dmg"]],
  ["Code", FileCode, ["js", "jsx", "ts", "tsx", "json", "html", "css", "py", "rb", "go", "rs", "swift", "java", "c", "cpp", "h", "sh", "yml", "yaml", "toml", "xml", "sql"]],
  ["Document", FileText, ["doc", "docx", "pages", "txt", "md", "rtf", "log"]],
];
export function describeKind(name: string, isFolder: boolean): { label: string; icon: LucideIcon } {
  if (isFolder) return { label: "Folder", icon: Folder };
  const ext = extension(name);
  const match = KINDS.find(([, , list]) => list.includes(ext));
  return match ? { label: match[0], icon: match[1] } : { label: ext ? `${ext.toUpperCase()} file` : "File", icon: File };
}

export const MAX_MEDIA_PREVIEW = 8 * 1024 * 1024;
export const MAX_TEXT_PREVIEW = 512 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp" };
const TEXT = ["txt", "md", "csv", "tsv", "log", "json", "yml", "yaml", "toml", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "swift", "java", "c", "cpp", "h", "sh", "sql", "rtf"];
export type Preview = { kind: "image" | "pdf"; type: string; limit: number } | { kind: "text"; limit: number } | null;
/** How a file can be shown in the browser. The type comes from the name, never from stored metadata, so nothing uploaded can run as a page. */
export function previewFor(name: string): Preview {
  const ext = extension(name);
  if (IMAGE_TYPES[ext]) return { kind: "image", type: IMAGE_TYPES[ext], limit: MAX_MEDIA_PREVIEW };
  if (ext === "pdf") return { kind: "pdf", type: "application/pdf", limit: MAX_MEDIA_PREVIEW };
  if (TEXT.includes(ext)) return { kind: "text", limit: MAX_TEXT_PREVIEW };
  return null;
}
