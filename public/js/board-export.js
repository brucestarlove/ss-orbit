// Board snapshot export: builds a ZIP of every board's `.orbit.json` and
// triggers a browser download. Extracted from board-menu.js so both the Board
// flyout's "Export All" and Settings → Appearance's "Back up all boards" can
// reuse the exact same archive without importing the heavier board-menu module
// (which would create a settings ↔ board-menu import cycle). Depends only on
// state/api/toast, so it stays safe to import from anywhere.

import { state } from "./state.js";
import { api } from "./api.js";
import { toast } from "./toast.js";

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(bytes, value) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(bytes, value) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function zipDateTime(date = new Date()) {
  return {
    time:
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f),
    date:
      (((date.getFullYear() - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0xf) << 5) |
      (date.getDate() & 0x1f)
  };
}

export function createZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const timestamp = zipDateTime();

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const checksum = crc32(dataBytes);
    const localHeader = [];
    writeUint32(localHeader, 0x04034b50);
    writeUint16(localHeader, 20);
    writeUint16(localHeader, 0x0800);
    writeUint16(localHeader, 0);
    writeUint16(localHeader, timestamp.time);
    writeUint16(localHeader, timestamp.date);
    writeUint32(localHeader, checksum);
    writeUint32(localHeader, dataBytes.length);
    writeUint32(localHeader, dataBytes.length);
    writeUint16(localHeader, nameBytes.length);
    writeUint16(localHeader, 0);
    localParts.push(new Uint8Array(localHeader), nameBytes, dataBytes);

    const centralHeader = [];
    writeUint32(centralHeader, 0x02014b50);
    writeUint16(centralHeader, 20);
    writeUint16(centralHeader, 20);
    writeUint16(centralHeader, 0x0800);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, timestamp.time);
    writeUint16(centralHeader, timestamp.date);
    writeUint32(centralHeader, checksum);
    writeUint32(centralHeader, dataBytes.length);
    writeUint32(centralHeader, dataBytes.length);
    writeUint16(centralHeader, nameBytes.length);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint16(centralHeader, 0);
    writeUint32(centralHeader, 0);
    writeUint32(centralHeader, offset);
    centralParts.push(new Uint8Array(centralHeader), nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  });

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = [];
  writeUint32(endHeader, 0x06054b50);
  writeUint16(endHeader, 0);
  writeUint16(endHeader, 0);
  writeUint16(endHeader, files.length);
  writeUint16(endHeader, files.length);
  writeUint32(endHeader, centralSize);
  writeUint32(endHeader, centralOffset);
  writeUint16(endHeader, 0);

  return new Blob([...localParts, ...centralParts, new Uint8Array(endHeader)], { type: "application/zip" });
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function safeExportName(board, usedNames) {
  const base = String(board?.slug || board?.name || board?.id || "board")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "board";
  let name = `${base}.orbit.json`;
  let suffix = 2;
  while (usedNames.has(name)) {
    name = `${base}-${suffix}.orbit.json`;
    suffix += 1;
  }
  usedNames.add(name);
  return name;
}

/** Export every board the actor can see as a single ZIP of `.orbit.json`
 *  snapshots. Resolves `true` once the download starts, `false` if there are
 *  no boards. Throws on a failed export request so callers can surface it. */
export async function exportAllBoards({ includeAttachments = false } = {}) {
  const boards = state.data?.boards || [];
  if (!boards.length) {
    toast.error("No boards to export");
    return false;
  }
  const suffix = includeAttachments ? "?include_attachments=true" : "";
  const usedNames = new Set();
  const files = [];
  for (const board of boards) {
    const snapshot = await api(`/api/boards/${encodeURIComponent(board.id)}/export${suffix}`);
    files.push({
      name: safeExportName(board, usedNames),
      content: JSON.stringify(snapshot, null, 2)
    });
  }
  const archive = createZip(files);
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(`orbit-boards-${date}${includeAttachments ? ".with-images" : ""}.zip`, archive);
  toast.success(`Exported ${files.length} board${files.length === 1 ? "" : "s"}`);
  return true;
}
