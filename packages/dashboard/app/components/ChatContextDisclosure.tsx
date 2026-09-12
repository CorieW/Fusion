import { useTranslation } from "react-i18next";
import "./ChatContextDisclosure.css";

/* FNXC:ChatContext 2026-09-11-15:57: Desktop and mobile show the same persisted context coverage. Counts describe the supplied prompt, not a claim that the agent retrieved or understood omitted material. */
export function ChatContextDisclosure({ metadata }: { metadata?: Record<string, unknown> | null }) {
  const { t } = useTranslation("app");
  const notes = Array.isArray(metadata?.workingNotes) ? metadata.workingNotes.filter((note): note is { id: string; text: string; status: string; sourceMessageIds: string[] } => Boolean(note) && typeof note === "object" && typeof note.id === "string" && typeof note.text === "string" && typeof note.status === "string" && Array.isArray(note.sourceMessageIds) && note.sourceMessageIds.every((id: unknown) => typeof id === "string")) : [];
  const savedNotes = notes.length > 0 ? <details className="chat-context-disclosure">
      <summary>{t("chat.contextSavedNotes", "Working notes saved for later replies")}</summary>
      <ul>{notes.map(note => <li key={note.id}>{note.text} ({note.status}) <span>{note.sourceMessageIds.map((id, index) => <a key={`${id}-${index}`} href={`#chat-message-${encodeURIComponent(id)}`}>{t("chat.contextSource", "Source {{count}}", { count: index + 1 })}{" "}</a>)}</span></li>)}</ul>
    </details> : null;
  const raw = metadata?.contextReport;
  if (!raw || typeof raw !== "object") return savedNotes;
  const report = raw as Record<string, unknown>;
  if (report.version !== 1 || !Array.isArray(report.includedMessageIds) || !Array.isArray(report.omittedMessageIds)) return savedNotes;
  const missing = Array.isArray(report.missingReferenceIds) ? report.missingReferenceIds.length : 0;
  const deferred = Array.isArray(report.deferredRequiredMessageIds) ? report.deferredRequiredMessageIds.length : 0;

  return <details className="chat-context-disclosure">
    <summary>{t("chat.contextCoverage", "Conversation context")}</summary>
    <p>{t("chat.contextIncluded", "Complete earlier messages included: {{count}}.", { count: report.includedMessageIds.length })}</p>
    <p>{t("chat.contextOmitted", "Earlier messages omitted from the prompt: {{count}}. The agent can retrieve them.", { count: report.omittedMessageIds.length })}</p>
    {report.olderHistoryAvailable === true && <p>{t("chat.contextOlder", "Additional older history is available through conversation search.")}</p>}
    {deferred > 0 && <p>{t("chat.contextRequiredDeferred", "Required messages needing retrieval: {{count}}.", { count: deferred })}</p>}
    {missing > 0 && <p>{t("chat.contextMissing", "Unavailable referenced messages: {{count}}.", { count: missing })}</p>}
    <p>{t("chat.contextNotes", "Source-linked working notes carried forward: {{count}}.", { count: typeof report.workingNoteCount === "number" ? report.workingNoteCount : 0 })}</p>
    {report.workingNotesDeferred === true && <p>{t("chat.contextNotesDeferred", "Working notes were too large to include and are available for retrieval.")}</p>}
    {savedNotes}
  </details>;
}
