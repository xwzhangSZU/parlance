import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@vscode/test-cli";

// The golden-path integration test drives the real extension, which spawns
// `zsearch`, which needs an embedding API key (e.g. GEMINI_API_KEY). VS Code is
// launched here by @vscode/test-electron, which builds the child env as
// `Object.assign({}, process.env, ...)` — so any key we put on process.env now
// flows: test runner -> VS Code -> Extension Host -> the zsearch child process.
//
// To avoid forcing the user to `source ~/.env` first, we read ~/.env here and
// inject any var that isn't already set. The PATH/HOME/etc. guard (`if already
// set, skip`) means we only ever add missing keys, never clobber the live env.
// No value is printed or committed; ~/.env itself is not part of the repo.
try {
  const envText = readFileSync(join(homedir(), ".env"), "utf8");
  for (const line of envText.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
} catch {
  // ~/.env absent or unreadable — the golden-path test will self-skip on a
  // missing GEMINI_API_KEY; the no-key tests still run.
}

export default defineConfig({
  files: "out-test/test/**/*.test.js",
  version: "stable",
  mocha: {
    ui: "bdd",
    // Generous timeout: first run downloads VS Code, and the golden-path test
    // makes a real embedding API call + vector search.
    timeout: 120000,
    color: true,
  },
});
