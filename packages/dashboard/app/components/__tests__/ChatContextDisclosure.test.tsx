import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatContextDisclosure } from "../ChatContextDisclosure";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (_key: string, fallback: string, params?: { count: number }) => fallback.replace("{{count}}", String(params?.count ?? 0)) }) }));

describe("ChatContextDisclosure", () => {
  it("exposes saved working notes and their original sources even without a rebuilt transcript", () => {
    render(<ChatContextDisclosure metadata={{ workingNotes: [{ id: "finding", text: "Correct the update label", status: "open", sourceMessageIds: ["review"] }] }} />);
    expect(screen.getByText("Working notes saved for later replies")).toBeDefined();
    expect(screen.getByText("Correct the update label (open)")).toBeDefined();
    expect(screen.getByRole("link", { hidden: true }).getAttribute("href")).toBe("#chat-message-review");
  });
  it.each([390, 1440])("shows persistent context coverage in the shared layout at width %s", width => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const { container } = render(<ChatContextDisclosure metadata={{ contextReport: { version: 1, includedMessageIds: ["review", "coder"], omittedMessageIds: ["older"], requiredMessageIds: ["review"], missingReferenceIds: ["deleted"], deferredRequiredMessageIds: ["large"], olderHistoryAvailable: true, workingNoteCount: 3, workingNotesDeferred: true } }} />);
    const summary = screen.getByText("Conversation context");
    fireEvent.click(summary);
    expect(container.querySelector("details")?.open).toBe(true);
    expect(screen.getByText("Complete earlier messages included: 2.")).toBeDefined();
    expect(screen.getByText("Required messages needing retrieval: 1.")).toBeDefined();
    expect(screen.getByText("Source-linked working notes carried forward: 3.")).toBeDefined();
    expect(screen.getByText("Unavailable referenced messages: 1.")).toBeDefined();
  });
  it.each([undefined, null, {}, { contextReport: "bad" }, { contextReport: { version: 1 } }])("does not render an empty disclosure for unavailable metadata", metadata => {
    const { container } = render(<ChatContextDisclosure metadata={metadata} />);
    expect(container.querySelector("details")).toBeNull();
  });
});
