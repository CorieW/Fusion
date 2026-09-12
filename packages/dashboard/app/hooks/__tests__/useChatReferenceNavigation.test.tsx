import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatReferenceNavigation } from "../useChatReferenceNavigation";

function Harness({ unavailable = false, scrollTo, onUnavailable, sessionId = "chat", loadPage }: { unavailable?: boolean; scrollTo: (id: string) => void; onUnavailable: () => void; sessionId?: string; loadPage?: () => Promise<void> }) {
  const container = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState([{ id: "recent" }]);
  const onClick = useChatReferenceNavigation({ sessionId, container, messages, loading: false, hasMore: !unavailable && messages.length === 1,
    loadMore: loadPage ?? (async () => { setMessages([{ id: "source" }, ...messages]); }), scrollTo, onUnavailable });
  return <div ref={container} onClick={onClick}><a href="#chat-message-source">Quoted message</a>{messages.map(message => <div key={message.id} data-message-id={message.id}>{message.id}</div>)}</div>;
}
describe("chat source navigation", () => {
  it.each([390, 1440])("keeps pending history requests isolated across conversation switches at width %s", async width => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    const finish: (() => void)[] = [];
    const loadPage = vi.fn(() => new Promise<void>(resolve => { finish.push(resolve); }));
    const scroll = vi.fn(); const unavailable = vi.fn();
    const view = render(<Harness sessionId="first" scrollTo={scroll} onUnavailable={unavailable} loadPage={loadPage} />);
    fireEvent.click(screen.getByText("Quoted message"));
    expect(loadPage).toHaveBeenCalledTimes(1);
    view.rerender(<Harness sessionId="second" scrollTo={scroll} onUnavailable={unavailable} loadPage={loadPage} />);
    fireEvent.click(screen.getByText("Quoted message"));
    expect(loadPage).toHaveBeenCalledTimes(2);
    await act(async () => { finish[0](); });
    fireEvent.click(screen.getByText("Quoted message"));
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(unavailable).not.toHaveBeenCalled();
    await act(async () => { finish[1](); });
    expect(unavailable).toHaveBeenCalledTimes(1);
    view.rerender(<Harness sessionId="third" scrollTo={scroll} onUnavailable={unavailable} />);
    fireEvent.click(screen.getByText("Quoted message"));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith("source"));
  });
  it("loads the original message before scrolling to an older quoted source", async () => {
    const scroll = vi.fn(); const unavailable = vi.fn();
    render(<Harness scrollTo={scroll} onUnavailable={unavailable} />);
    fireEvent.click(screen.getByText("Quoted message"));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith("source"));
    expect(unavailable).not.toHaveBeenCalled();
  });
  it("reports missing source messages instead of leaving a dead link", async () => {
    const scroll = vi.fn(); const unavailable = vi.fn();
    render(<Harness unavailable scrollTo={scroll} onUnavailable={unavailable} />);
    fireEvent.click(screen.getByText("Quoted message"));
    await waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1));
    expect(scroll).not.toHaveBeenCalled();
  });
  it.each([390, 1440])("stops a source lookup when pagination makes no progress at width %s", async width => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    const loadPage = vi.fn(async () => {});
    const onUnavailable = vi.fn();
    render(<Harness scrollTo={vi.fn()} onUnavailable={onUnavailable} loadPage={loadPage} />);
    fireEvent.click(screen.getByText("Quoted message"));
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(loadPage).toHaveBeenCalledTimes(1);
  });
  it("reports a rejected page and cancels navigation after a conversation switch", async () => {
    const scroll = vi.fn(); const unavailable = vi.fn();
    let rejectPage!: (error: Error) => void;
    const loadPage = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPage = reject; }));
    const view = render(<Harness scrollTo={scroll} onUnavailable={unavailable} loadPage={loadPage} />);
    fireEvent.click(screen.getByText("Quoted message"));
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1));
    view.rerender(<Harness sessionId="other" scrollTo={scroll} onUnavailable={unavailable} loadPage={loadPage} />);
    rejectPage(new Error("page failed"));
    await waitFor(() => expect(scroll).not.toHaveBeenCalled());
    expect(unavailable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Quoted message"));
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    rejectPage(new Error("page failed"));
    await waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1));
  });
});
