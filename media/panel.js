(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");

  function slot() {
    return document.getElementById("suggest-slot");
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "loading") {
      root.innerHTML = '<div class="loading">检索中…</div>';
    } else if (msg.type === "results") {
      const bar =
        msg.count > 0
          ? '<div class="suggest-bar"><button id="suggest-btn">✍ 生成改写建议</button></div>'
          : "";
      root.innerHTML = bar + '<div id="suggest-slot"></div><div id="hits">' + msg.html + "</div>";
    } else if (msg.type === "error") {
      const d = document.createElement("div");
      d.className = "error";
      d.textContent = msg.message;
      root.replaceChildren(d);
    } else if (msg.type === "suggestion-loading") {
      const s = slot();
      if (s) s.innerHTML = '<div class="loading">生成建议中…</div>';
    } else if (msg.type === "suggestions") {
      const s = slot();
      if (s) s.innerHTML = msg.html;
    } else if (msg.type === "suggestion-error") {
      const s = slot();
      if (s) {
        const d = document.createElement("div");
        d.className = "error";
        d.textContent = msg.message;
        s.replaceChildren(d);
      }
    }
  });

  root.addEventListener("click", (e) => {
    const target = e.target;
    if (target.id === "suggest-btn") {
      const s = slot();
      if (s) s.innerHTML = '<div class="loading">生成建议中…</div>';
      vscode.postMessage({ type: "suggest" });
    } else if (target.classList.contains("copy-btn")) {
      vscode.postMessage({ type: "copy", text: target.getAttribute("data-copy") });
    } else if (target.classList.contains("jump-btn")) {
      vscode.postMessage({ type: "jump", key: target.getAttribute("data-key") });
    }
  });
})();
