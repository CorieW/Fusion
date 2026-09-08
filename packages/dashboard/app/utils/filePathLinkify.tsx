import "./filePathLinkify.css";
import React, { cloneElement, createContext, isValidElement, useContext } from "react";
import type { ReactElement, ReactNode } from "react";
import { useFileBrowser } from "../context/FileBrowserContext";

// Two branches: the main branch requires a slash plus extension to avoid plain-prose false positives,
// while the allowlist branch covers well-known root files agents commonly reference without a slash.
export const FILE_PATH_REGEX = /(?<![\w@-])((?:[A-Za-z0-9_./@-]+\/)+[A-Za-z0-9_./@-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?|(?:Dockerfile|Makefile|AGENTS\.md|README\.md|README)(?::\d+(?::\d+)?)?)(?![\w-])/g;

const EXCLUDED_PROTOCOLS = ["http://", "https://", "mailto:", "git@", "ftp://"];
const WELL_KNOWN_ROOT_FILES = new Set(["Dockerfile", "Makefile", "AGENTS.md", "README.md", "README"]);
const FileLinkLabelContext = createContext(false);

/**
 * FNXC:MarkdownFileLinks 2026-09-08-06:39:
 * Agent report links belong in the file browser, including relative Markdown destinations and
 * dashboard /output URLs that have no static route. Preserve external sites, API URLs, dashboard
 * navigation, and other localhost services. File-service workspace containment remains authoritative.
 */
export function parseMarkdownFileHref(href: string | undefined): { path: string; line?: number; col?: number } | null {
  if (!href || href.startsWith("#") || href.startsWith("?")) return null;
  let path = href;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
    if (typeof window === "undefined") return null;
    try {
      const url = new URL(href, window.location.href);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      const isDashboardOutput = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        && url.port === "4040" && url.pathname.startsWith("/output/");
      if (url.origin !== window.location.origin && !isDashboardOutput) return null;
      path = url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  }
  // Query-bearing destinations can be application routes even when they end in a file extension.
  if (path.includes("?") || /^\/?api\//i.test(path)) return null;
  const [encodedPath, fragment] = path.split("#", 2);
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (path.includes("\\") || Array.from(path).some((character) => character.charCodeAt(0) < 32)) return null;
  const parsed = parseFilePathMatch(path.replace(/^\//, ""));
  if (!/\.[a-z\d]{1,8}$/i.test(parsed.path) && !WELL_KNOWN_ROOT_FILES.has(parsed.path)) return null;
  const lineFragment = fragment?.match(/^L?(\d+)(?:C(\d+))?(?:-L?\d+)?$/i);
  return {
    ...parsed,
    ...(lineFragment ? { line: Number(lineFragment[1]), col: lineFragment[2] ? Number(lineFragment[2]) : undefined } : {}),
  };
}

export function MarkdownFileAnchor({ children, href, node: _node, ...props }: React.ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const fileBrowser = useFileBrowser();
  const target = parseMarkdownFileHref(href);
  const label = <FileLinkLabelContext.Provider value={true}>{children}</FileLinkLabelContext.Provider>;
  if (fileBrowser && target) return <FilePathLink {...target}>{label}</FilePathLink>;
  if (!href) return <span>{label}</span>;
  return <a {...props} href={href}>{label}</a>;
}

function parseFilePathMatch(value: string): { path: string; line?: number; col?: number } {
  const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(value);
  if (!match) {
    return { path: value };
  }

  return {
    path: match[1] ?? value,
    line: match[2] ? Number.parseInt(match[2], 10) : undefined,
    col: match[3] ? Number.parseInt(match[3], 10) : undefined,
  };
}

function isVersionLike(value: string): boolean {
  return /^v?\d+(?:\.\d+)+$/.test(value);
}

function hasPathSeparatorOrAllowlist(path: string): boolean {
  return path.includes("/") || WELL_KNOWN_ROOT_FILES.has(path);
}

function isExcludedMatch(source: string, start: number, rawMatch: string): boolean {
  const prefix = source.slice(Math.max(0, start - 16), start).toLowerCase();
  if (rawMatch.startsWith("//") || EXCLUDED_PROTOCOLS.some((protocol) => prefix.endsWith(protocol))) {
    return true;
  }

  const { path } = parseFilePathMatch(rawMatch);
  if (isVersionLike(path)) {
    return true;
  }

  if (!hasPathSeparatorOrAllowlist(path)) {
    return true;
  }

  return false;
}

export function FilePathLink({
  path,
  line,
  col,
  children,
}: {
  path: string;
  line?: number;
  col?: number;
  children?: ReactNode;
}) {
  const fileBrowser = useFileBrowser();
  const insideLink = useContext(FileLinkLabelContext);

  if (!fileBrowser || insideLink) {
    return <span>{children ?? path}</span>;
  }

  return (
    <button
      type="button"
      className="file-path-link"
      onClick={() => fileBrowser.openFile(path, { line, col })}
    >
      {children ?? path}
    </button>
  );
}

export function linkifyFilePaths(text: string, options?: { keyPrefix?: string }): ReactNode[] {
  if (!text) {
    return [text];
  }

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;

  for (const match of text.matchAll(FILE_PATH_REGEX)) {
    const rawMatch = match[0];
    const start = match.index ?? 0;
    const end = start + rawMatch.length;

    if (isExcludedMatch(text, start, rawMatch)) {
      continue;
    }

    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }

    const { path, line, col } = parseFilePathMatch(rawMatch);
    nodes.push(
      <FilePathLink
        key={`${options?.keyPrefix ?? "file-path"}-${start}-${matchIndex}`}
        path={path}
        line={line}
        col={col}
      >
        {rawMatch}
      </FilePathLink>,
    );
    lastIndex = end;
    matchIndex += 1;
  }

  if (lastIndex === 0) {
    return [text];
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function linkifyReactChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") {
    const nodes = linkifyFilePaths(children);
    return nodes.length === 1 ? nodes[0] : <>{nodes}</>;
  }

  if (Array.isArray(children)) {
    return React.Children.map(children, (child) => linkifyReactChildren(child));
  }

  if (!isValidElement<{ children?: ReactNode; href?: string }>(children)) {
    return children;
  }

  if (children.props.href !== undefined || (typeof children.type === "string" && ["a", "button", "code", "pre"].includes(children.type))) {
    return children;
  }

  if (children.props.children === undefined) {
    return children;
  }

  return cloneElement(
    children as ReactElement<{ children?: ReactNode }>,
    undefined,
    React.Children.map(children.props.children, (child) => linkifyReactChildren(child)),
  );
}
