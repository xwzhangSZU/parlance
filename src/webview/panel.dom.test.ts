// @vitest-environment jsdom
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, vi } from "vitest";

import { renderHits } from "./render";
import type { PhraseHit } from "../core/types";

// Execute the real webview script (not a copy) so this test breaks if the
// button wiring or message switch in media/panel.js drifts. Resolved from the
// project root (vitest's cwd) — under the jsdom env, import.meta.url is not a
// file:// URL.
const panelSrc = readFileSync(resolve(process.cwd(), "media/panel.js"), "utf8");

const HIT: PhraseHit = {
  key: "ABCD",
  chunk_idx: 0,
  distance: 0.234,
  snippet: "原文段落",
  title: "论隐私",
  creators: ["Solove, D"],
  date: "2006",
  venue: "HLR",
  doi: null,
};

interface LoadedPanel {
  postMessage: ReturnType<typeof vi.fn>;
  root: HTMLElement;
}

/** Fresh #root + stubbed VS Code API, then run media/panel.js against it. */
function loadPanel(innerHtml: string): LoadedPanel {
  document.body.innerHTML = `<div id="root">${innerHtml}</div>`;
  const postMessage = vi.fn();
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage,
  });
  new Function(panelSrc)();
  const root = document.getElementById("root") as HTMLElement;
  return { postMessage, root };
}

function click(el: Element): void {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function postToWebview(data: unknown): void {
  window.dispatchEvent(new window.MessageEvent("message", { data }));
}

describe("panel.js — button clicks post messages to the extension", () => {
  it("posts a copy message carrying the snippet text", () => {
    const { postMessage, root } = loadPanel(renderHits([HIT]));
    const btn = root.querySelector(".copy-btn");
    expect(btn, "copy button is rendered").toBeTruthy();
    click(btn!);
    expect(postMessage).toHaveBeenCalledWith({ type: "copy", text: "原文段落" });
  });

  it("posts a jump message carrying the item key", () => {
    const { postMessage, root } = loadPanel(renderHits([HIT]));
    const btn = root.querySelector(".jump-btn");
    expect(btn, "jump button is rendered").toBeTruthy();
    click(btn!);
    expect(postMessage).toHaveBeenCalledWith({ type: "jump", key: "ABCD" });
  });
});

describe("panel.js — incoming messages update the panel", () => {
  it("renders results HTML into the root", () => {
    const { root } = loadPanel("");
    postToWebview({ type: "results", html: '<div class="hit">MATCH</div>' });
    expect(root.querySelector(".hit")?.textContent).toBe("MATCH");
  });

  it("shows a loading state", () => {
    const { root } = loadPanel("");
    postToWebview({ type: "loading" });
    expect(root.textContent).toContain("检索中");
  });

  it("renders errors as text, never as HTML (XSS-safe)", () => {
    const { root } = loadPanel("");
    postToWebview({ type: "error", message: "<script>alert(1)</script>" });
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector(".error")?.textContent).toBe("<script>alert(1)</script>");
  });
});
