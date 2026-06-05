// Shared textarea editing helpers. These stay DOM-light so node:test can cover
// editor behavior without booting the browser app.

const DEFAULT_INDENT = "\t";

function clampIndex(value, index) {
  const n = Number(index);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(value.length, n));
}

function lineStartFor(value, index) {
  return value.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

function selectedLineRange(value, selectionStart, selectionEnd) {
  const lineStart = lineStartFor(value, selectionStart);
  const effectiveEnd =
    selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
      ? selectionEnd - 1
      : selectionEnd;
  const nextBreak = value.indexOf("\n", Math.max(lineStart, effectiveEnd));
  return {
    lineStart,
    lineEnd: nextBreak === -1 ? value.length : nextBreak,
  };
}

function lineStartsForBlock(block, lineStart) {
  const starts = [];
  let cursor = lineStart;
  for (const line of block.split("\n")) {
    starts.push(cursor);
    cursor += line.length + 1;
  }
  return starts;
}

function leadingOutdentWidth(line) {
  if (line.startsWith("\t")) return 1;
  const spaces = line.match(/^ {1,2}/)?.[0] || "";
  return spaces.length;
}

function adjustmentBeforePosition(position, lineStarts, widths) {
  let total = 0;
  for (let i = 0; i < lineStarts.length; i += 1) {
    if (position <= lineStarts[i]) continue;
    total += Math.min(widths[i], position - lineStarts[i]);
  }
  return total;
}

export function applyTextareaIndentation({
  value = "",
  selectionStart = 0,
  selectionEnd = selectionStart,
  shiftKey = false,
  indent = DEFAULT_INDENT,
} = {}) {
  const source = String(value);
  const start = clampIndex(source, selectionStart);
  const end = clampIndex(source, selectionEnd);
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  const indentText = String(indent || DEFAULT_INDENT);

  if (!shiftKey && first === last) {
    const nextValue = `${source.slice(0, first)}${indentText}${source.slice(last)}`;
    const nextCaret = first + indentText.length;
    return {
      value: nextValue,
      selectionStart: nextCaret,
      selectionEnd: nextCaret,
      handled: true,
    };
  }

  const { lineStart, lineEnd } = selectedLineRange(source, first, last);
  const block = source.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const lineStarts = lineStartsForBlock(block, lineStart);

  if (!shiftKey) {
    const widths = lines.map(() => indentText.length);
    const nextBlock = lines.map((line) => `${indentText}${line}`).join("\n");
    const selectionStartDelta = adjustmentBeforePosition(first, lineStarts, widths);
    const selectionEndDelta = adjustmentBeforePosition(last, lineStarts, widths);
    return {
      value: `${source.slice(0, lineStart)}${nextBlock}${source.slice(lineEnd)}`,
      selectionStart: first + selectionStartDelta,
      selectionEnd: last + selectionEndDelta,
      handled: true,
    };
  }

  const widths = lines.map(leadingOutdentWidth);
  const nextBlock = lines
    .map((line, index) => line.slice(widths[index]))
    .join("\n");
  const selectionStartDelta = adjustmentBeforePosition(first, lineStarts, widths);
  const selectionEndDelta = adjustmentBeforePosition(last, lineStarts, widths);
  return {
    value: `${source.slice(0, lineStart)}${nextBlock}${source.slice(lineEnd)}`,
    selectionStart: first - selectionStartDelta,
    selectionEnd: last - selectionEndDelta,
    handled: true,
  };
}

export function handleTextareaIndentationKeydown(event, textarea = event?.currentTarget) {
  if (!event || event.key !== "Tab") return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (!textarea || textarea.tagName !== "TEXTAREA") return false;

  event.preventDefault();
  const next = applyTextareaIndentation({
    value: textarea.value,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
    shiftKey: event.shiftKey,
  });

  textarea.value = next.value;
  textarea.setSelectionRange(next.selectionStart, next.selectionEnd);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return next.handled;
}
