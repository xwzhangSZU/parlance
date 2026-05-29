import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { renderHits } from "../webview/render";
import type { PhraseHit } from "../core/types";

/**
 * Read-only snapshot of the panel's last state. Exposed purely for
 * integration tests (the webview DOM is not reachable from the test host);
 * production code only writes it and never reads it back.
 */
export interface PanelState {
  kind: "loading" | "results" | "error";
  count?: number;
  message?: string;
}

export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "parlance.results";
  public lastState?: PanelState;
  private view?: vscode.WebviewView;
  private pending?: { type: string; [k: string]: unknown };

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.shell(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "copy") {
        void vscode.env.clipboard.writeText(msg.text);
        void vscode.window.showInformationMessage("已复制到剪贴板");
      } else if (msg.type === "jump") {
        void vscode.env.openExternal(vscode.Uri.parse(`zotero://select/library/items/${msg.key}`));
      }
    });
    if (this.pending) {
      void view.webview.postMessage(this.pending);
      this.pending = undefined;
    }
  }

  showLoading(): void {
    this.lastState = { kind: "loading" };
    this.post({ type: "loading" });
  }

  showResults(hits: PhraseHit[]): void {
    this.lastState = { kind: "results", count: hits.length };
    this.post({ type: "results", html: renderHits(hits) });
  }

  showError(message: string): void {
    this.lastState = { kind: "error", message };
    this.post({ type: "error", message });
  }

  private post(message: { type: string; [k: string]: unknown }): void {
    if (this.view) {
      this.view.show?.(true);
      void this.view.webview.postMessage(message);
    } else {
      // View not resolved yet: stash and trigger resolution; resolveWebviewView flushes it.
      this.pending = message;
      void vscode.commands.executeCommand("parlance.results.focus");
    }
  }

  private shell(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "panel.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "panel.js"));
    const nonce = randomUUID().replace(/-/g, "");
    return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" />
</head>
<body>
  <div id="root"><div class="empty">选中一段文字,运行「Parlance: 查找相近表达」。</div></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
