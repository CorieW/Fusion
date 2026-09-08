import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

// FNXC:WorkflowViewport 2026-09-08-18:36: Explicit opt-in rendering regression; inline production CSS and block every request so geometry coverage needs no server, database, provider, or real network. Run with node --test scripts/__tests__/workflow-viewport.browser.mjs.
const require = createRequire(new URL("../../packages/engine/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const candidates = [process.env.FUSION_BROWSER_SMOKE_BROWSER, chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"];
const executablePath = candidates.find(p => p && existsSync(p));
assert.ok(executablePath, "Set FUSION_BROWSER_SMOKE_BROWSER to an installed Chromium executable; this explicit check must not silently skip.");
const css = ["styles.css", "components/WorkflowNodeEditor.css"].map(p => readFileSync(fileURLToPath(new URL(`../../packages/dashboard/app/${p}`, import.meta.url)), "utf8")).join("\n");
let browser;
before(async () => { browser = await chromium.launch({ executablePath, headless: true }); });
after(async () => { await browser?.close(); });
for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 640, height: 360 }, { width: 1440, height: 1000 }]) {
  test(`embedded stage stays contained and scrolls its node into reach at ${viewport.width}x${viewport.height}`, async () => {
    const page = await browser.newPage({ viewport });
    try {
      await page.route("**/*", route => route.abort());
      await page.setContent(`<style>${css}</style>
        <div class="workflow-editor-embedded" style="height:40vh;margin-top:25vh">
          <div class="modal wf-editor-modal wf-editor-modal--embedded">
            <header class="wf-editor-header">Workflows</header>
            <div class="wf-editor-body wf-editor-body--editor-stage wf-editor-body--simple-layout">
              <section class="wf-editor-canvas-wrap">
                <div style="height:15vh;flex-shrink:0">Long workflow title and controls</div>
                <div class="wf-mobile-shell">
                  <nav class="wf-mobile-tabs"><button>Graph</button><button>Settings</button></nav>
                  <div class="wf-mobile-panel">
                    <div class="wf-mobile-graph-style-toggle">Graph / List</div>
                    <div class="wf-mobile-simple-canvas">
                      <button id="node" style="position:absolute;top:45%;left:40%" onclick="this.dataset.clicked='true'">Start</button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
        <footer style="position:fixed;top:65vh;bottom:0;left:0;right:0;z-index:99;background:var(--bg)">Navigation</footer>`);
      const host = await page.locator(".workflow-editor-embedded").boundingBox();
      const shell = await page.locator(".wf-editor-modal").boundingBox();
      assert.ok(host && shell);
      assert.ok(Math.abs(host.height - shell.height) < 1, `shell ${shell.height} must fill host ${host.height}, not the viewport`);
      await page.locator("#node").click({ timeout: 2000 });
      assert.equal(await page.locator("#node").getAttribute("data-clicked"), "true");
      const node = await page.locator("#node").boundingBox();
      assert.ok(node);
      const inside = node.y >= host.y && node.y + node.height <= host.y + host.height;
      assert.equal(inside, true, "normal scrolling must expose the node inside the host, above navigation");
    } finally { await page.close(); }
  });
}
test("a mobile dialog still uses the viewport rather than embedded-pane sizing", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.route("**/*", route => route.abort());
    await page.setContent(`<style>${css}</style><div class="modal wf-editor-modal"></div>`);
    assert.equal(await page.locator(".wf-editor-modal").evaluate(el => el.getBoundingClientRect().height), 844);
  } finally { await page.close(); }
});
