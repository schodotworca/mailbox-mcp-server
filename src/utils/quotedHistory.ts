import type { EmailMessage } from "../types/email.types.js";

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ");

/** Quote one selected message once, including any history already in its text. */
export function appendQuotedHistory(
  composition: { text?: string; html?: string }, original: EmailMessage,
): { text?: string; html?: string } {
  if (original.contentStatus === "unavailable" || !original.text?.trim()) {
    throw new Error("Original message text is unavailable; email was not sent. Cannot append reliable correspondence history.");
  }
  const limit = 64000;
  let body = original.text.slice(0, limit);
  // Avoid splitting a UTF-16 surrogate pair at the excerpt boundary.
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  const partial = original.contentStatus === "partial" || original.text.length > limit;
  const warning = partial ? "[Incomplete quoted history: the original was partially read or shortened.]\n" : "";
  const date = Number.isNaN(original.date.getTime()) ? "Unknown" : original.date.toISOString();
  const quote = `${warning}----- Original message -----\nFrom: ${original.from.map(a => oneLine(`${a.name || ""} <${a.address}>`)).join(", ")}\nDate: ${date}\nSubject: ${oneLine(original.subject)}\n\n${body.replace(/\r\n?/g, "\n").split("\n").map(line => `> ${line}`).join("\n")}`;
  return {
    text: composition.text ? `${composition.text}\n\n${quote}` : undefined,
    html: composition.html ? `${composition.html}\n<hr><blockquote style="white-space:pre-wrap">${escapeHtml(quote)}</blockquote>` : undefined,
  };
}
