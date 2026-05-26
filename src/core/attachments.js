import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { boardById, ticketById } from "./queries.js";
import { requireBoardAccess, requirePermission } from "./auth.js";
import { tx } from "./db.js";
import { recordEvent } from "./events.js";
import { bumpTicketUpdatedAt } from "./tickets.js";
import { httpError, id, now } from "./util.js";

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["image/bmp", ".bmp"],
  ["image/avif", ".avif"]
]);

export function attachmentStorageRoot(boardRow) {
  return join(dirname(boardRow.db_path), "attachments");
}

function ticketAttachmentDir(boardRow, ticketId) {
  return join(attachmentStorageRoot(boardRow), "tickets", ticketId);
}

function safeOriginalName(value) {
  const name = String(value || "image").replace(/[\0\r\n]/g, "").trim();
  return name.slice(0, 240) || "image";
}

function normalizeImageMime(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_EXTENSIONS.has(mime)) throw httpError(415, "unsupported_attachment_type");
  return mime;
}

function extensionFor(mime, originalName = "") {
  const originalExt = extname(originalName).toLowerCase();
  if ([...IMAGE_EXTENSIONS.values()].includes(originalExt)) return originalExt;
  return IMAGE_EXTENSIONS.get(mime) || ".img";
}

function relativeStoredPath(ticketId, attachmentId, mime, originalName) {
  return normalize(join("tickets", ticketId, `${attachmentId}${extensionFor(mime, originalName)}`)).replace(/\\/g, "/");
}

function resolveStoredPath(boardRow, storedPath) {
  const root = attachmentStorageRoot(boardRow);
  const abs = join(root, storedPath);
  const normalizedRoot = normalize(root + sep);
  const normalizedAbs = normalize(abs);
  if (!normalizedAbs.startsWith(normalizedRoot)) throw httpError(400, "invalid_attachment_path");
  return normalizedAbs;
}

function assertTicket(ctx, ticketId, write = false) {
  const { db, board, actor } = ctx;
  const ticket = ticketById(db, ticketId);
  if (!ticket || ticket.board_id !== board.id) throw httpError(404, "ticket_not_found");
  requireBoardAccess(actor, boardById(db, ticket.board_id));
  if (write) requirePermission(actor, "write");
  return ticket;
}

function rowToAttachment(boardRow, row) {
  const path = resolveStoredPath(boardRow, row.stored_path);
  let missing = true;
  let size = row.size_bytes;
  try {
    const stat = statSync(path);
    missing = !stat.isFile();
    if (!missing) size = stat.size;
  } catch {
    missing = true;
  }
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    board_id: row.board_id,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    stored_path: row.stored_path,
    created_by: row.created_by,
    created_at: row.created_at,
    missing,
    content_url: missing ? null : `/api/tickets/${encodeURIComponent(row.ticket_id)}/attachments/${encodeURIComponent(row.id)}/content`,
    filesystem_size_bytes: missing ? null : size
  };
}

export function listTicketAttachments(ticketId, ctx) {
  assertTicket(ctx, ticketId);
  const rows = ctx.db
    .prepare("SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticketId);
  return { attachments: rows.map((row) => rowToAttachment(ctx.board, row)) };
}

export function getTicketAttachmentContent(ticketId, attachmentId, ctx) {
  assertTicket(ctx, ticketId);
  const row = ctx.db
    .prepare("SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ?")
    .get(attachmentId, ticketId);
  if (!row) throw httpError(404, "attachment_not_found");
  const filePath = resolveStoredPath(ctx.board, row.stored_path);
  if (!existsSync(filePath)) throw httpError(404, "attachment_file_missing");
  return { row, filePath };
}

export function createTicketAttachment(ticketId, input, ctx) {
  const ticket = assertTicket(ctx, ticketId, true);
  const mime = normalizeImageMime(input.mime_type);
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes || []);
  if (bytes.length === 0) throw httpError(400, "empty_attachment");
  if (bytes.length > MAX_IMAGE_ATTACHMENT_BYTES) throw httpError(413, "attachment_too_large");
  const originalName = safeOriginalName(input.original_name);
  const attachmentId = id();
  const storedPath = relativeStoredPath(ticketId, attachmentId, mime, originalName);
  const filePath = resolveStoredPath(ctx.board, storedPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const time = now();

  mkdirSync(ticketAttachmentDir(ctx.board, ticketId), { recursive: true });
  writeFileSync(filePath, bytes, { flag: "wx" });

  try {
    return tx(ctx.db, () => {
      ctx.db.prepare(
        `INSERT INTO ticket_attachments
         (id, ticket_id, board_id, original_name, stored_path, mime_type, size_bytes, sha256, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(attachmentId, ticketId, ticket.board_id, originalName, storedPath, mime, bytes.length, hash, ctx.actor.name, time);
      ctx.db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(time, ticketId);
      recordEvent(ctx.db, ticket.board_id, "attachment_created", ticketId, ctx.actor.name, {
        attachment_id: attachmentId,
        original_name: originalName,
        mime_type: mime,
        size_bytes: bytes.length,
        sha256: hash
      });
      bumpTicketUpdatedAt(ctx.db, ticket.parent_ticket_id, time);
      return rowToAttachment(ctx.board, ctx.db.prepare("SELECT * FROM ticket_attachments WHERE id = ?").get(attachmentId));
    });
  } catch (error) {
    try { unlinkSync(filePath); } catch {}
    throw error;
  }
}

export function deleteTicketAttachment(ticketId, attachmentId, ctx) {
  const ticket = assertTicket(ctx, ticketId, true);
  const row = ctx.db
    .prepare("SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ?")
    .get(attachmentId, ticketId);
  if (!row) throw httpError(404, "attachment_not_found");
  const filePath = resolveStoredPath(ctx.board, row.stored_path);
  return tx(ctx.db, () => {
    ctx.db.prepare("DELETE FROM ticket_attachments WHERE id = ?").run(attachmentId);
    const time = now();
    ctx.db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(time, ticketId);
    recordEvent(ctx.db, ticket.board_id, "attachment_deleted", ticketId, ctx.actor.name, {
      attachment_id: attachmentId,
      original_name: row.original_name
    });
    bumpTicketUpdatedAt(ctx.db, ticket.parent_ticket_id, time);
    try { unlinkSync(filePath); } catch {}
    return { ok: true, deleted_id: attachmentId };
  });
}

export function attachmentRowsForBoard(db, boardId) {
  return db
    .prepare("SELECT * FROM ticket_attachments WHERE board_id = ? ORDER BY created_at ASC")
    .all(boardId);
}

export function serializeAttachmentForExport(boardRow, row, includeBytes = false) {
  const attachment = rowToAttachment(boardRow, row);
  if (!includeBytes || attachment.missing) {
    return { ...attachment, data_base64: null, included: false };
  }
  const filePath = resolveStoredPath(boardRow, row.stored_path);
  const data = readFileSync(filePath);
  return {
    ...attachment,
    data_base64: data.toString("base64"),
    included: true,
    missing: false
  };
}

export function importAttachmentRows(snapshot, ctx, targetBoardId) {
  const rows = Array.isArray(snapshot.attachments) ? snapshot.attachments : [];
  for (const attachment of rows) {
    const attachmentId = attachment.id || id();
    const ticketId = attachment.ticket_id;
    if (!ticketId || !ctx.db.prepare("SELECT 1 FROM tickets WHERE id = ?").get(ticketId)) continue;
    const mime = normalizeImageMime(attachment.mime_type || "image/png");
    const originalName = safeOriginalName(attachment.original_name);
    const storedPath = relativeStoredPath(ticketId, attachmentId, mime, originalName);
    let size = Number(attachment.size_bytes || 0);
    let sha = String(attachment.sha256 || "");

    if (attachment.data_base64) {
      const bytes = Buffer.from(String(attachment.data_base64), "base64");
      if (bytes.length > MAX_IMAGE_ATTACHMENT_BYTES) throw httpError(413, "attachment_too_large");
      size = bytes.length;
      sha = createHash("sha256").update(bytes).digest("hex");
      const filePath = resolveStoredPath(ctx.board, storedPath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, bytes);
    }

    ctx.db.prepare(
      `INSERT OR IGNORE INTO ticket_attachments
       (id, ticket_id, board_id, original_name, stored_path, mime_type, size_bytes, sha256, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      attachmentId,
      ticketId,
      targetBoardId,
      originalName,
      storedPath,
      mime,
      size,
      sha,
      attachment.created_by || "import",
      attachment.created_at || now()
    );
  }
}
