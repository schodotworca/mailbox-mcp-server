import type { MessageStructureObject } from "imapflow";
import type { EmailMessage } from "../types/email.types.js";

// Read one display body only. Never descend into attached messages or files.
export function selectMailBody(node: MessageStructureObject): MessageStructureObject | undefined {
  if (node.disposition?.toLowerCase() === "attachment" ||
      node.dispositionParameters?.filename || node.parameters?.name) return;
  const type = node.type.toLowerCase();
  if (type === "text/plain" || type === "text/html") return node;
  if (!type.startsWith("multipart/")) return;
  const children = node.childNodes || [];
  if (type === "multipart/related") {
    const start = node.parameters?.start?.replace(/[<>]/g, "");
    const root = start ? children.find(child => child.id?.replace(/[<>]/g, "") === start) : children[0];
    return root ? selectMailBody(root) : undefined;
  }
  if (type === "multipart/alternative") {
    const candidates = children.map(selectMailBody).filter((part): part is MessageStructureObject => !!part);
    return candidates.find(part => part.type.toLowerCase() === "text/plain") || candidates[0];
  }
  // Skip explicit attachments even when they precede the display body.
  for (const child of children) {
    const body = selectMailBody(child);
    if (body) return body;
  }
  return undefined;
}

export function attachmentMetadata(node: MessageStructureObject, body?: MessageStructureObject): NonNullable<EmailMessage["attachments"]> {
  if (node === body) return [];
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  if (node.disposition?.toLowerCase() === "attachment" || filename || !node.type.toLowerCase().startsWith("multipart/")) {
    if (!filename && ["text/plain", "text/html"].includes(node.type.toLowerCase()) && node.disposition?.toLowerCase() !== "attachment") return [];
    return [{filename: filename || "unnamed", contentType: node.type, size: node.size || 0, contentId: node.id}];
  }
  return (node.childNodes || []).flatMap(child => attachmentMetadata(child, body));
}
