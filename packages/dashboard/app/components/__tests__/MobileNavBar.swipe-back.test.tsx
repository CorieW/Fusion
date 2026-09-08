import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchScripts } from "../../api";
import { NavigationHistoryProvider, useNavigationHistory, type UseNavigationHistoryResult } from "../../hooks/useNavigationHistory";
import { MobileNavBar } from "../MobileNavBar";

vi.mock("../../api", () => ({
  fetchScripts: vi.fn(),
}));

function mockMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function HistoryHarness({ children, onReady }: { children: ReactNode; onReady: (history: UseNavigationHistoryResult) => void }) {
  const history = useNavigationHistory({ enabled: true });
  useEffect(() => onReady(history), [history, onReady]);
  return <NavigationHistoryProvider value={history}>{children}</NavigationHistoryProvider>;
}

const createDefaultProps = () => ({
  view: "board" as const,
  onChangeView: vi.fn(),
  footerVisible: false,
  onOpenActivityLog: vi.fn(),
  onOpenGitManager: vi.fn(),
  onOpenWorkflowEditor: vi.fn(),
  onOpenSchedules: vi.fn(),
  onOpenScripts: vi.fn(),
  onToggleTerminal: vi.fn(),
  onOpenFiles: vi.fn(),
  onOpenGitHubImport: vi.fn(),
  onOpenPlanning: vi.fn(),
  onResumePlanning: vi.fn(),
  onOpenUsage: vi.fn(),
  onViewAllProjects: vi.fn(),
  onRunScript: vi.fn(),
  projectId: "proj_1",
});

function dispatchPopState(navIndex: number) {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex } }));
  });
}

async function openMore() {
  fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
  const other = screen.getByRole("button", { name: "Other" });
  if (other.getAttribute("aria-expanded") === "false") fireEvent.click(other);
  expect(screen.getByTestId("mobile-more-item-activity")).toBeVisible();
}

describe("MobileNavBar More sheet navigation history", () => {
  let navigationHistory: UseNavigationHistoryResult | null;

  beforeEach(() => {
    mockMobileViewport();
    navigationHistory = null;
    window.history.replaceState({ navIndex: 0 }, "");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
    vi.spyOn(window.history, "back").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderWithHistory(props = createDefaultProps()) {
    const rendered = render(
      <HistoryHarness onReady={(history) => { navigationHistory = history; }}>
        <MobileNavBar {...props} />
      </HistoryHarness>,
    );
    return { ...rendered, props };
  }

  it("dismisses the More sheet on browser Back without navigating away", async () => {
    const { container } = renderWithHistory();
    await openMore();

    dispatchPopState(0);

    await waitFor(() => expect(container.querySelector(".mobile-more-sheet")).toBeNull());
    dispatchPopState(0);
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
  });

  it("routes Android native Back through history before dismissing the More sheet", async () => {
    const { container } = renderWithHistory();
    await openMore();
    const nativeBack = new CustomEvent("fusion:native-back", { cancelable: true });

    expect(window.dispatchEvent(nativeBack)).toBe(false);
    expect(window.history.back).toHaveBeenCalledOnce();
    expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();

    dispatchPopState(0);
    await waitFor(() => expect(container.querySelector(".mobile-more-sheet")).toBeNull());
  });

  async function expectProgrammaticCloseConsumesMoreEntry(close: () => void | Promise<void>) {
    vi.mocked(window.history.back).mockClear();
    const sentinelClose = vi.fn();
    const rendered = renderWithHistory();
    await waitFor(() => expect(navigationHistory).not.toBeNull());
    navigationHistory?.pushNav({ type: "modal", close: sentinelClose });
    await openMore();

    await close();
    expect(screen.queryByTestId("mobile-more-item-activity")).toBeNull();
    expect(window.history.back).toHaveBeenCalledOnce();

    // removeNav's history.back() self-pop is ignored before the lower entry can handle Back.
    dispatchPopState(1);
    expect(sentinelClose).not.toHaveBeenCalled();
    dispatchPopState(0);
    expect(sentinelClose).toHaveBeenCalledOnce();
    rendered.unmount();
  }

  it("consumes the More entry on backdrop close", async () => {
    await expectProgrammaticCloseConsumesMoreEntry(() => fireEvent.click(document.querySelector(".mobile-more-sheet-backdrop")!));
  });

  it("replaces the More entry before opening Import so delayed Back cannot consume it", async () => {
    const importClose = vi.fn();
    const props = createDefaultProps();
    props.onOpenGitHubImport = () => {
      navigationHistory?.pushNav({ type: "modal", close: importClose });
    };
    renderWithHistory(props);
    await openMore();

    fireEvent.click(screen.getByTestId("mobile-more-item-github"));

    expect(window.history.back).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mobile-more-item-activity")).toBeNull();

    dispatchPopState(0);
    expect(importClose).toHaveBeenCalledOnce();
  });

  it("consumes the More entry on Escape", async () => {
    await expectProgrammaticCloseConsumesMoreEntry(() => fireEvent.keyDown(document, { key: "Escape" }));
  });

  it("consumes the More entry on drag dismissal", async () => {
    await expectProgrammaticCloseConsumesMoreEntry(() => {
      const sheet = document.querySelector<HTMLDivElement>(".mobile-more-sheet")!;
      Object.defineProperty(sheet, "getBoundingClientRect", { configurable: true, value: () => ({ height: 400 }) });
      fireEvent.touchStart(sheet, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(sheet, { touches: [{ clientY: 300 }] });
      fireEvent.touchEnd(sheet, { changedTouches: [{ clientY: 300 }] });
    });
  });

  it("consumes the More entry when its tab toggles closed", async () => {
    await expectProgrammaticCloseConsumesMoreEntry(() => fireEvent.click(screen.getByTestId("mobile-nav-tab-more")));
  });

  /* FNXC:MobileNavFit 2026-09-08-06:50: Script execution, populated Manage, and empty Add are destination transitions, not plain dismissal. A delayed self-pop must never consume the new destination. */
  it.each(["run", "manage", "empty"])("replaces More before a script destination (%s)", async (action) => {
    vi.mocked(fetchScripts).mockResolvedValueOnce(action === "empty" ? {} : { build: "pnpm build" });
    const destinationClose = vi.fn();
    const props = createDefaultProps();
    const openDestination = vi.fn(() => { navigationHistory?.pushNav({ type: "modal", close: destinationClose }); });
    props.onRunScript = openDestination;
    props.onOpenScripts = openDestination;
    renderWithHistory(props);
    await openMore();
    fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));
    const item = await screen.findByTestId(action === "run" ? "mobile-more-script-item-build" : "mobile-more-scripts-manage");
    fireEvent.click(item);
    expect(openDestination).toHaveBeenCalledOnce();
    expect(window.history.back).not.toHaveBeenCalled();
    expect(document.querySelector(".mobile-more-sheet")).toBeNull();
    dispatchPopState(0);
    expect(destinationClose).toHaveBeenCalledOnce();
  });

  it("keeps provider-less More-sheet renders functional", async () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);
    await openMore();
    fireEvent.click(document.querySelector(".mobile-more-sheet-backdrop")!);
    await waitFor(() => expect(container.querySelector(".mobile-more-sheet")).toBeNull());
  });
});
