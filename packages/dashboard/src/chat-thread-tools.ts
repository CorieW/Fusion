import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readChatAttachmentContents, readChatAttachmentTextPage } from "./chat-attachment-content.js";
import { readWorkingNotes, type ThreadAccess, type WorkingNote } from "./chat-thread-context.js";

/*
FNXC:ChatContext 2026-09-11-15:57:
Every chat participant can recover complete messages, tool evidence, and attachments from its own conversation. Paging applies to output, not storage; returned next offsets always reach the omitted tail. Server-bound scope prevents arbitrary conversation/project reads. Working notes preserve stable IDs and source provenance across handoffs and rewinds through message metadata.
*/
const PAGE_CHARS = 12_000;
const integer = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
const result = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {}, ...(isError ? { isError } : {}) });

export function createThreadTools(access: ThreadAccess, initialNotes: WorkingNote[] = [], rootDir?: string, isActive: () => boolean = () => true) {
  let notes = initialNotes.map(note => ({ ...note, sourceMessageIds: [...note.sourceMessageIds] }));
  const read = {
    name: "fn_chat_thread_read", label: "Read Current Conversation",
    description: "Read complete current-conversation messages by message_id, paging long content with char_offset and nextCharOffset. part=tools reads tool evidence; attachment_id reads an attached file. Omit message_id to list message IDs, or use part=notes for the source-linked working notes. Never assume the prompt contains all history.",
    parameters: { type: "object", properties: {
      message_id: { type: "string" }, offset: { type: "number", minimum: 0 }, char_offset: { type: "number", minimum: 0 },
      part: { type: "string", enum: ["content", "tools", "notes"] }, attachment_id: { type: "string" },
    }, additionalProperties: false },
    execute: async (_id: string, raw: { message_id?: string; offset?: number; char_offset?: number; part?: string; attachment_id?: string }) => {
      try {
        if (!isActive()) return result({ error: "This turn has ended." }, true);
        if (raw.part === "notes") return result({ notes });
        if (!raw.message_id) {
          const offset = integer(raw.offset, 0);
          const messages = await access.list(offset, 30);
          return result({ messages: messages.map(message => ({ id: message.id, role: message.role, createdAt: message.createdAt, preview: message.content.slice(0, 160), characters: message.content.length })), nextOffset: messages.length === 30 ? offset + messages.length : null });
        }
        const message = await access.read(raw.message_id);
        if (!message) return result({ error: "Message unavailable in this conversation." }, true);
        const text = raw.part === "tools" ? JSON.stringify(message.metadata?.toolCalls ?? []) : message.content;
        if (raw.attachment_id) {
          const attachment = message.attachments?.find(item => item.id === raw.attachment_id);
          if (!attachment || !rootDir) return result({ error: "Attachment unavailable in this conversation." }, true);
          if (!attachment.mimeType.startsWith("image/")) {
            const page = await readChatAttachmentTextPage(rootDir, access.scope.kind === "session" ? { kind: "session", sessionId: access.scope.id } : { kind: "room", roomId: access.scope.id }, attachment, integer(raw.char_offset, 0), PAGE_CHARS);
            return result({ id: message.id, attachmentId: attachment.id, ...page });
          }
          const contents = await readChatAttachmentContents(rootDir, access.scope.kind === "session" ? { kind: "session", sessionId: access.scope.id } : { kind: "room", roomId: access.scope.id }, [attachment]);
          if (contents.imageContents.length) return { content: contents.imageContents.map(item => ({ type: "image" as const, data: item.data, mimeType: item.mimeType })), details: {} };
          return result({ error: "Attachment could not be read." }, true);
        }
        const offset = integer(raw.char_offset, 0);
        const end = Math.min(text.length, offset + PAGE_CHARS);
        return result({ id: message.id, role: message.role, createdAt: message.createdAt, attachments: message.attachments ?? [], part: raw.part ?? "content", text: text.slice(offset, end), charOffset: offset, totalCharacters: text.length, nextCharOffset: end < text.length ? end : null });
      } catch { return result({ error: "Conversation could not be read." }, true); }
    },
  } as unknown as ToolDefinition;
  const search = {
    name: "fn_chat_thread_search", label: "Search Current Conversation",
    description: "Search current-conversation text literally, including older history. Follow nextOffset until null to cover the entire conversation; message IDs can be read in full with fn_chat_thread_read.",
    parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 1000 }, offset: { type: "number", minimum: 0 } }, required: ["query"], additionalProperties: false },
    execute: async (_id: string, raw: { query: string; offset?: number }) => {
      try {
        if (!isActive() || typeof raw.query !== "string" || !raw.query.trim() || raw.query.length > 1000) return result({ error: "An active turn and non-empty query are required." }, true);
        const offset = integer(raw.offset, 0);
        const messages = await access.list(offset, 200);
        const matches: { id: string; excerpt: string }[] = [];
        let scanned = 0;
        for (const message of messages) {
          scanned++;
          const index = message.content.toLocaleLowerCase().indexOf(raw.query.trim().toLocaleLowerCase());
          if (index >= 0) matches.push({ id: message.id, excerpt: message.content.slice(Math.max(0, index - 100), index + 300) });
          if (matches.length === 20) break;
        }
        return result({ matches, scanned, nextOffset: scanned < messages.length || messages.length === 200 ? offset + scanned : null });
      } catch { return result({ error: "Conversation could not be searched." }, true); }
    },
  } as unknown as ToolDefinition;
  const update = {
    name: "fn_chat_context_update", label: "Update Conversation Working Notes",
    description: "Upsert source-linked objectives, constraints, decisions, findings, actions or questions. Reuse the same id to resolve/update a finding; omit unrelated entries to preserve them. Archive only resolved entries using archive_ids. Distinguish proposals from accepted decisions. Sources must be message IDs in this conversation; accepted decisions/constraints require a user source. Notes are persisted with the reply and remain interpretations to verify against the originals.",
    parameters: { type: "object", properties: { notes: { type: "array", maxItems: 80, items: { type: "object", properties: {
      id: { type: "string", minLength: 1, maxLength: 100 }, kind: { type: "string", enum: ["objective", "constraint", "decision", "finding", "action", "question"] },
      status: { type: "string", enum: ["proposed", "accepted", "open", "resolved"] }, text: { type: "string", minLength: 1, maxLength: 2000 },
      sourceMessageIds: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
    }, required: ["id", "kind", "status", "text", "sourceMessageIds"], additionalProperties: false } }, archive_ids: { type: "array", maxItems: 80, items: { type: "string" } } }, required: ["notes"], additionalProperties: false },
    execute: async (_id: string, raw: { notes: WorkingNote[]; archive_ids?: string[] }) => {
      try {
        if (!isActive() || !Array.isArray(raw.notes) || raw.notes.length > 80 || readWorkingNotes(raw.notes).length !== raw.notes.length) return result({ error: "Invalid working notes." }, true);
        for (const note of raw.notes) {
          if (!note.id.trim() || note.id.length > 100 || !note.text.trim() || note.text.length > 2000 || note.sourceMessageIds.length > 10) return result({ error: "Working note exceeds its bounds." }, true);
          const sources = await Promise.all(note.sourceMessageIds.map(id => access.read(id)));
          if (sources.some(source => !source)) return result({ error: "Every source must exist in this conversation." }, true);
          if (note.status === "accepted" && ["decision", "constraint"].includes(note.kind) && !sources.some(source => source?.role === "user")) return result({ error: "Accepted decisions and constraints require a user source; otherwise record a proposal." }, true);
        }
        const merged = [...new Map([...notes, ...raw.notes].map(note => [note.id, note])).values()];
        if (raw.archive_ids !== undefined && (!Array.isArray(raw.archive_ids) || raw.archive_ids.length > 80 || raw.archive_ids.some(id => !merged.some(note => note.id === id && note.status === "resolved")))) return result({ error: "Only resolved working notes may be archived; unresolved requirements must remain." }, true);
        const next = merged.filter(note => !raw.archive_ids?.includes(note.id));
        if (next.length > 80 || JSON.stringify(next).length > 16_000) return result({ error: "Working notes are full. Consolidate existing entries by ID without dropping unresolved requirements." }, true);
        if (!isActive()) return result({ error: "This turn has ended." }, true);
        notes = next.map(note => ({ ...note, sourceMessageIds: [...note.sourceMessageIds] }));
        return result({ stagedForReply: raw.notes.map(note => note.id), archived: raw.archive_ids ?? [] });
      } catch { return result({ error: "Working-note sources could not be verified." }, true); }
    },
  } as unknown as ToolDefinition;
  return { tools: [read, search, update], getNotes: () => notes };
}
