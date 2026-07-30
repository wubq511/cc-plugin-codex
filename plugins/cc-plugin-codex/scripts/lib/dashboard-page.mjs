/**
 * Dashboard HTML page assembly.
 *
 * Served by dashboard.mjs at GET /?token=<token>. Authored as three sibling
 * files (dashboard-page.html / .css / dashboard-client.mjs) so the markup,
 * styles, and client logic stay highlightable, lintable, and unit-testable;
 * inlined here at module load so the server still delivers exactly ONE
 * response: zero extra routes, zero build, zero runtime dependencies.
 *
 * The page reads the token from the URL and uses EventSource + fetch to
 * render a real-time timeline of Claude's actions. Chinese UI.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Fail fast at load: a missing asset means a broken install, and the
// dashboard is the only liveness channel during a blocking delegation.
function readAsset(name) {
  try {
    return readFileSync(path.join(here, name), "utf8");
  } catch (err) {
    throw new Error(`dashboard page asset missing: ${name} (${err?.message || err})`);
  }
}

const PAGE_HTML = readAsset("dashboard-page.html");
const PAGE_CSS = readAsset("dashboard-page.css");
const PAGE_JS = readAsset("dashboard-client.mjs");

export function renderDashboardPage() {
  // The HTML parser closes a script element at the first "</script"
  // sequence, even inside a JS string literal. Escape defensively.
  const safeJs = PAGE_JS.replaceAll("</script", "<\\/script");
  // Function replacers avoid "$"-pattern interpretation in asset content.
  return PAGE_HTML
    .replace("%%DASHBOARD_CSS%%", () => PAGE_CSS)
    .replace("%%DASHBOARD_JS%%", () => safeJs);
}
