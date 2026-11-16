/* A buildless, independent Manim editor. The existing inspector remains intact. */
"use strict";
(() => {
  const byId = (id) => document.getElementById(id);
  const studio = () => window.AnimathemaStudio;
  const source = byId("direct-code-source");
  const panel = byId("direct-code-workspace");
  const highlight = byId("direct-code-highlight");
  const lines = byId("direct-code-lines");
  const selector = byId("direct-code-scene");
  const storageKey = "animathema.directCode.v1";
  const editor = {
    custom: false, generated: "", scenes: [], selected: "", revision: 0,
    checkedRevision: -1, diagnostic: null, busy: false, requesting: false,
    analysisTimer: null, visualSequence: 0, visualProblem: "", shown: false,
  };
  const escape = (value) => String(value).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  async function codeRequest(path, body) {
    const response = await fetch("/api/" + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail));
      error.diagnostic = data.diagnostic;
      throw error;
    }
    return data;
  }

  function persist() {
    try {
      if (editor.custom) localStorage.setItem(storageKey, JSON.stringify({ code: source.value, scene: editor.selected }));
      else localStorage.removeItem(storageKey);
    } catch { /* Editing and rendering also work when browser storage is disabled. */ }
  }

  function updateStatus() {
    const badge = byId("direct-code-status");
    badge.textContent = editor.custom ? "Custom Code Override"
      : editor.visualProblem ? "Visual scene needs attention" : "Synced with Visual Scene";
    badge.classList.toggle("custom", editor.custom);
    badge.classList.toggle("invalid", !editor.custom && Boolean(editor.visualProblem));
    byId("direct-code-note").textContent = editor.custom
      ? "Draft in this browser · Download .py to save a file · Tab to indent"
      : "Python runs locally through Manim · Tab / Shift+Tab to indent";
    const busy = editor.busy || editor.requesting || studio()?.isBusy();
    for (const id of ["direct-code-draft", "direct-code-production"]) {
      byId(id).disabled = Boolean(busy || !source.value.trim());
    }
  }

  function updateCursor() {
    const before = source.value.slice(0, source.selectionStart);
    const row = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
    byId("direct-code-cursor").textContent = `Ln ${row}, Col ${column}`;
  }

  function syncScroll() {
    highlight.scrollTop = source.scrollTop;
    highlight.scrollLeft = source.scrollLeft;
    lines.scrollTop = source.scrollTop;
  }

  function paint() {
    // Tokenize once, before escaping, so strings and comments cannot become HTML.
    const token = /#[^\n]*|(?:[rRuUbBfF]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(?:False|None|True|and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b|\b(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\b|\b(?:Scene|ThreeDScene|MovingCameraScene|ZoomedScene|VectorScene|LinearTransformationScene|self|super|range|len|print)\b/g;
    let html = "", end = 0;
    for (const match of source.value.matchAll(token)) {
      html += escape(source.value.slice(end, match.index));
      const text = match[0];
      const style = text.startsWith("#") ? "comment" : /^[rRuUbBfF]*["']/.test(text) ? "string"
        : /^\d|^\.\d/.test(text) ? "number"
        : /^(?:Scene|ThreeDScene|MovingCameraScene|ZoomedScene|VectorScene|LinearTransformationScene|self|super|range|len|print)$/.test(text) ? "name" : "keyword";
      html += `<span class="py-${style}">${escape(text)}</span>`;
      end = match.index + text.length;
    }
    highlight.innerHTML = html + escape(source.value.slice(end)) + "\n";
    lines.innerHTML = source.value.split("\n").map((_, i) =>
      `<span${editor.diagnostic?.line === i + 1 ? ' class="error-line"' : ""}>${i + 1}</span>`).join("");
    syncScroll();
    updateCursor();
    updateStatus();
  }

  function showDiagnostic(error) {
    editor.diagnostic = error?.diagnostic || null;
    const box = byId("direct-code-diagnostic");
    box.hidden = !error;
    box.textContent = error?.message || "";
    paint();
  }

  function setScenes(scenes) {
    editor.scenes = scenes;
    if (!scenes.includes(editor.selected)) editor.selected = scenes[0] || "";
    selector.replaceChildren();
    for (const name of scenes.length ? scenes : [""]) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name || "No scene classes detected";
      selector.append(option);
    }
    selector.value = editor.selected;
    selector.disabled = !scenes.length;
    persist();
  }

  async function analyze() {
    const revision = editor.revision;
    if (!source.value.trim()) {
      setScenes([]);
      byId("direct-code-validation").textContent = "Write or paste a Manim Scene to begin.";
      return false;
    }
    try {
      const data = await codeRequest("code/analyze", { code: source.value });
      if (revision !== editor.revision) return false;
      editor.checkedRevision = revision;
      setScenes(data.scenes);
      showDiagnostic(null);
      byId("direct-code-validation").textContent = data.scenes.length
        ? `${data.scenes.length} scene${data.scenes.length === 1 ? "" : "s"} detected${data.import_added ? " · Manim import added at render" : " · Python valid"}`
        : "Python valid · define a Manim Scene subclass to render.";
      return Boolean(data.scenes.length);
    } catch (error) {
      if (revision !== editor.revision) return false;
      setScenes([]);
      showDiagnostic(error);
      byId("direct-code-validation").textContent = "Fix the Python error before rendering.";
      return false;
    }
  }

  function queueAnalysis() {
    clearTimeout(editor.analysisTimer);
    byId("direct-code-validation").textContent = "Checking Python…";
    editor.analysisTimer = setTimeout(analyze, 350);
  }

  function edited() {
    editor.custom = true;
    editor.revision++;
    editor.checkedRevision = -1;
    editor.diagnostic = null;
    byId("direct-code-diagnostic").hidden = true;
    paint();
    persist();
    queueAnalysis();
  }

  function adoptGenerated() {
    if (editor.custom) { updateStatus(); return; }
    if (source.value === editor.generated) { showDiagnostic(null); return; }
    source.value = editor.generated;
    editor.revision++;
    editor.checkedRevision = -1;
    showDiagnostic(null);
    queueAnalysis();
  }

  async function syncVisual(project, compiled) {
    const sequence = ++editor.visualSequence;
    try {
      // The original inspector may have its own legacy override. A dedicated
      // endpoint gives this workspace the visual graph without changing it.
      const code = project.code_override !== null && project.code_override !== undefined
        ? (await codeRequest("compile/visual", project)).code : compiled;
      if (sequence !== editor.visualSequence) return;
      editor.visualProblem = "";
      editor.generated = code;
      adoptGenerated();
    } catch (error) { if (sequence === editor.visualSequence) visualError(error.message); }
  }

  function visualError(message) {
    editor.visualProblem = message;
    if (!editor.custom) showDiagnostic(new Error(message));
    updateStatus();
  }

  async function reset() {
    const project = studio()?.getProject();
    if (!project) return;
    try {
      const data = await codeRequest("compile/visual", project);
      editor.custom = false;
      editor.generated = data.code;
      editor.visualProblem = "";
      editor.selected = "";
      persist();
      adoptGenerated();
      // Reset also needs to re-check a custom document identical to generated code.
      queueAnalysis();
      studio().toast("Code workspace re-synced with the visual scene.");
    } catch (error) { showDiagnostic(error); }
  }

  function leave() {
    if (!editor.shown) return;
    editor.shown = false;
    panel.hidden = true;
    byId("viewport").hidden = false;
    for (const selector of [".viewport-toolbar", ".viewport-footer", ".viewport-actions"]) {
      document.querySelector(selector).hidden = false;
    }
    document.querySelector(".viewport-panel").classList.remove("direct-code-active");
    byId("code-workspace-toggle").setAttribute("aria-pressed", "false");
  }

  function toggle() {
    if (editor.shown) { leave(); return; }
    editor.shown = true;
    studio()?.pause();
    panel.hidden = false;
    byId("viewport").hidden = true;
    for (const selector of [".viewport-toolbar", ".viewport-footer", ".viewport-actions"]) {
      document.querySelector(selector).hidden = true;
    }
    document.querySelector(".viewport-panel").classList.add("direct-code-active");
    byId("code-workspace-toggle").setAttribute("aria-pressed", "true");
    paint();
    source.focus({ preventScroll: true });
  }

  async function renderCode(quality) {
    if (editor.requesting || editor.busy || studio()?.isBusy()) {
      studio()?.toast("Wait for the active job or cancel it in the console.");
      return;
    }
    if (!studio()?.beginCodeRequest()) return;
    editor.requesting = true;
    updateStatus();
    clearTimeout(editor.analysisTimer);
    try {
      const revision = editor.revision;
      const project = studio().getProject();
      if (!await analyze()) return;
      if (revision !== editor.revision) { queueAnalysis(); return; }
      const job = await codeRequest("render/code", {
        code: source.value, scene_name: editor.selected, quality,
      });
      studio().startJob(job, project);
      byId("footer-status").textContent = `Rendering ${editor.selected} from the Code workspace…`;
    } catch (error) { showDiagnostic(error); }
    finally { studio().endCodeRequest(); editor.requesting = false; updateStatus(); }
  }

  source.addEventListener("input", edited);
  source.addEventListener("scroll", syncScroll);
  source.addEventListener("click", updateCursor);
  source.addEventListener("keyup", updateCursor);
  source.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const start = source.selectionStart, end = source.selectionEnd;
    if (start === end && !event.shiftKey) {
      source.setRangeText("    ", start, end, "end");
    } else {
      const lineStart = source.value.lastIndexOf("\n", start - 1) + 1;
      const selected = source.value.slice(lineStart, end);
      const replacement = event.shiftKey
        ? selected.replace(/^(?: {1,4}|\t)/gm, "") : selected.replace(/^/gm, "    ");
      source.setRangeText(replacement, lineStart, end, "select");
    }
    edited();
  });
  selector.addEventListener("change", () => { editor.selected = selector.value; persist(); });
  byId("code-workspace-toggle").addEventListener("click", toggle);
  byId("direct-code-reset").addEventListener("click", reset);
  byId("direct-code-draft").addEventListener("click", () => renderCode("low"));
  byId("direct-code-production").addEventListener("click", () => renderCode("high"));
  byId("direct-code-copy").addEventListener("click", async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source.value);
      else {
        const start = source.selectionStart, end = source.selectionEnd;
        source.focus(); source.select();
        const copied = document.execCommand("copy");
        source.setSelectionRange(start, end);
        if (!copied) throw new Error("Copy was unavailable. Select the code and copy it manually.");
      }
      studio()?.toast("Code copied to clipboard.");
    } catch (error) { studio()?.toast(error.message, true); }
  });
  byId("direct-code-download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([source.value], { type: "text/x-python;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = (editor.selected || "scene") + ".py"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener("beforeunload", persist);
  try {
    const draft = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (draft && typeof draft.code === "string" && draft.code.length <= 200000) {
      editor.custom = true; source.value = draft.code;
      editor.selected = typeof draft.scene === "string" ? draft.scene : "";
      queueAnalysis();
    }
  } catch { /* A missing or invalid browser draft never prevents opening the studio. */ }
  window.CodeWorkspace = {
    syncVisual, visualError, leave,
    setBusy: (busy) => { editor.busy = busy; updateStatus(); },
  };
  paint();
  // Handle a cached/deferred script loading after the initial visual compilation.
  const project = studio()?.getProject();
  if (project && studio().getCode()) syncVisual(project, studio().getCode());
  else if (project) codeRequest("compile/visual", project)
    .then((data) => syncVisual(project, data.code)).catch((error) => visualError(error.message));
})();
