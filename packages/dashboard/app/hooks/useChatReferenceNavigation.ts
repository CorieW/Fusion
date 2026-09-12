import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";

/* FNXC:ChatContext 2026-09-11-15:57: Source links reuse the existing history pager and viewport scroll action. Never leave a link inert because its message has not been loaded; cancellation on conversation changes prevents a late page from scrolling another thread. */
export function useChatReferenceNavigation(options: {
  sessionId: string | null;
  container: RefObject<HTMLDivElement | null>;
  messages: { id: string }[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  scrollTo: (id: string) => void;
  onUnavailable: () => void;
}) {
  const [pending, setPending] = useState<{ id: string; sessionId: string; previousOldestId?: string; failed?: boolean } | null>(null);
  const request = useRef<object | null>(null);
  // A previous conversation's page must not hold the current conversation's lock.
  // Request identity also prevents its late completion from clearing a newer lock.
  useEffect(() => () => { request.current = null; }, [options.sessionId]);
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#chat-message-"]') : null;
    if (!anchor || !options.sessionId) return;
    const id = anchor.getAttribute("href")?.slice("#chat-message-".length);
    if (!id || !/^[\w-]+$/.test(id)) return;
    event.preventDefault();
    setPending({ id, sessionId: options.sessionId });
  }, [options.sessionId]);

  useEffect(() => {
    if (!pending) return;
    if (pending.sessionId !== options.sessionId) { setPending(null); return; }
    if (options.container.current?.querySelector(`[data-message-id="${pending.id}"]`)) {
      options.scrollTo(pending.id);
      setPending(null);
      return;
    }
    if (options.loading || request.current) return;
    const oldestId = options.messages[0]?.id;
    if (!options.hasMore || pending.failed || !oldestId || pending.previousOldestId === oldestId) {
      options.onUnavailable();
      setPending(null);
      return;
    }
    const pageRequest = {};
    request.current = pageRequest;
    let failed = false;
    void options.loadMore().catch(() => { failed = true; }).finally(() => {
      if (request.current !== pageRequest) return;
      request.current = null;
      setPending(current => current?.sessionId === pending.sessionId && current.id === pending.id ? { ...current, previousOldestId: oldestId, failed } : current ? { ...current } : null);
    });
  }, [pending, options.sessionId, options.container, options.messages, options.loading, options.hasMore, options.loadMore, options.scrollTo, options.onUnavailable]);
  return onClick;
}
