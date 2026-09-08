import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import { MarkdownFileAnchor, parseMarkdownFileHref } from "../filePathLinkify";
import { standardChatMarkdownComponents } from "../../components/StandardChatSurface";
import { markdownComponents as agentMarkdownComponents } from "../../components/AgentLogViewer";
import { MailboxMessageContent } from "../../components/MailboxMessageContent";
import { markdownLinkifyComponents as taskDetailMarkdownComponents } from "../../components/TaskDetailModal";
import { markdownComponents as taskHistoryMarkdownComponents } from "../../components/TaskHistoryTab";
import { markdownComponents as workflowMarkdownComponents } from "../../components/WorkflowResultsTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Markdown file destinations", () => {
  it.each([
    ["output/playwright/report.md", "output/playwright/report.md", undefined],
    ["/output/playwright/report.md", "output/playwright/report.md", undefined],
    ["http://localhost:4040/output/playwright/report.md", "output/playwright/report.md", undefined],
    ["http://127.0.0.1:4040/output/playwright/report.md", "output/playwright/report.md", undefined],
    ["report%20with%20spaces.md", "report with spaces.md", undefined],
    ["src/app.ts:42:7", "src/app.ts", 42],
    ["src/app.ts#L42-L50", "src/app.ts", 42],
    ["README.md", "README.md", undefined],
  ])("recognizes %s", (href, path, line) => {
    expect(parseMarkdownFileHref(href as string)).toMatchObject({ path, line });
  });

  it.each([
    undefined, "", "#heading", "/?task=WORK-004", "/settings", "/api/health.json",
    "/report.md?download=1", "https://example.com/report.md", "//example.com/report.md",
    "http://localhost:5184/output/report.md", "http://localhost:4040/api/file.md",
    "javascript:alert(1)", "data:text/plain,report.md", "file:///tmp/report.md", "bad%ZZ.md",
  ])("preserves non-file destination %s", (href) => {
    expect(parseMarkdownFileHref(href)).toBeNull();
  });

  it("preserves usable anchors when no file browser is available", () => {
    render(<MarkdownFileAnchor href="output/report.md">Report</MarkdownFileAnchor>);
    expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute("href", "output/report.md");
  });
});

const renderers = {
  chat: standardChatMarkdownComponents,
  "agent/task output": agentMarkdownComponents,
  "task description/summary": taskDetailMarkdownComponents,
  "stage history": taskHistoryMarkdownComponents,
  "workflow results": workflowMarkdownComponents,
  mailbox: undefined,
};

describe.each(Object.keys(renderers) as Array<keyof typeof renderers>)("%s file links", (surface) => {
  function content(markdown: string) {
    if (surface === "mailbox") return <MailboxMessageContent content={markdown} />;
    return <ReactMarkdown remarkPlugins={[remarkGfm]} components={renderers[surface]}>{markdown}</ReactMarkdown>;
  }

  it.each([320, 1440])("opens the reported URL through the file browser at viewport %i", async (width) => {
    vi.stubGlobal("innerWidth", width);
    const openFile = vi.fn();
    render(<FileBrowserProvider openFile={openFile}>{content("[Browser report](http://localhost:4040/output/playwright/navigation-browser-report.md)")}</FileBrowserProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Browser report" }));
    expect(openFile).toHaveBeenCalledWith("output/playwright/navigation-browser-report.md", { line: undefined, col: undefined });
    expect(screen.queryByRole("link", { name: "Browser report" })).toBeNull();
  });

  it("handles relative links and code labels without nesting interactive controls", async () => {
    const openFile = vi.fn();
    const { container } = render(<FileBrowserProvider openFile={openFile}>{content("[`src/app.ts`](src/app.ts:42:7) and [web](https://example.com/report.md)")}</FileBrowserProvider>);
    await userEvent.click(screen.getByRole("button", { name: "src/app.ts" }));
    expect(openFile).toHaveBeenCalledWith("src/app.ts", { line: 42, col: 7 });
    expect(container.querySelector("button button, a button")).toBeNull();
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.com/report.md");
  });

  it("opens a bare report URL and repeated populated references", async () => {
    const openFile = vi.fn();
    const url = "http://localhost:4040/output/playwright/report.md";
    render(<FileBrowserProvider openFile={openFile}>{content(`${url}\n\n${url}`)}</FileBrowserProvider>);
    const links = screen.getAllByRole("button", { name: url });
    expect(links).toHaveLength(2);
    await userEvent.click(links[1]);
    expect(openFile).toHaveBeenCalledTimes(1);
  });
});
