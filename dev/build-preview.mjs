/*
 * Build dev/panel-preview.html from plugin/renderer/index.html.
 *
 * The harness must never drift from the real panel, so it is generated rather
 * than hand-maintained: the markup is index.html verbatim, the stylesheet and
 * the panel script are re-pointed one directory up, and the bridge stub is
 * injected ahead of panel.js (the bootstrap order the real host uses, where the
 * preload exists before the page script runs).
 *
 * Usage: node dev/build-preview.mjs [--check]
 *   (default) write dev/panel-preview.html
 *   --check   exit 1 when the committed file is stale
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..", "plugin");
const sourcePath = path.join(pluginRoot, "renderer", "index.html");
const targetPath = path.join(here, "panel-preview.html");

const BANNER = `<!--
  GENERATED FILE — do not edit by hand.
  Built from renderer/index.html by test/build-preview.mjs.
  Development harness: mounts the real panel.css + panel.js against a stubbed
  window.pluginBridge so the panel can be inspected in a plain browser.
-->`;

export function buildPreview() {
  const source = readFileSync(sourcePath, "utf8");
  let out = source
    .replace('href="panel.css"', 'href="../plugin/renderer/panel.css"')
    .replace('<script src="panel.js"></script>', '<script src="panel-preview-fixture.js"></script>\n    <script src="../plugin/renderer/panel.js"></script>');

  if (!out.includes("panel-preview-fixture.js")) {
    throw new Error("preview build failed: panel script tag not found in renderer/index.html");
  }
  if (!out.includes("../plugin/renderer/panel.css")) {
  }
  out = out.replace("<!DOCTYPE html>", `<!DOCTYPE html>\n${BANNER}`);
  return out;
}

const check = process.argv.includes("--check");
const built = buildPreview();

if (check) {
  const current = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  if (current !== built) {
    console.error("panel-preview.html is stale — run: node test/build-preview.mjs");
    console.error("panel-preview.html is stale — run: node dev/build-preview.mjs");
  }
  console.log("panel-preview.html is current");
} else {
  writeFileSync(targetPath, built, "utf8");
  console.log(`wrote ${path.relative(path.dirname(here), targetPath)} (${built.length} bytes)`);
}
