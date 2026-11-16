"use strict";
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uid = (prefix) =>
  prefix + "_" + crypto.getRandomValues(new Uint32Array(2)).join("_");
const copy = (value) => JSON.parse(JSON.stringify(value));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v) => Math.round(v * 1000) / 1000;
const state = {
  project: null,
  catalog: null,
  selection: null,
  selectionType: "object",
  mode: "stage",
  library: "objects",
  category: "All",
  time: 0,
  playing: false,
  simulate: false,
  grid: true,
  safe: false,
  is3d: false,
  zoom: 1,
  px: 68,
  crop: false,
  inspector: "properties",
  code: "",
  job: null,
  undo: [],
  redo: [],
  dirty: false,
  expanded: new Set(),
};
let autosaveTimer,
  codeTimer,
  toastTimer,
  rafTime,
  compileSequence = 0,
  pendingJob = false;
const video = $("monitor");

async function api(path, options = {}) {
  const response = await fetch("/api/" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    let data;
    try {
      data = await response.json();
    } catch {
      throw Error(`Request failed (${response.status})`);
    }
    throw Error(
      typeof data.detail === "string"
        ? data.detail
        : JSON.stringify(data.detail),
    );
  }
  return response.json();
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(
    () => ($("toast").hidden = true),
    error ? 9000 : 3500,
  );
}
function fail(error) {
  console.error(error);
  toast(error.message || String(error), true);
  $("footer-status").textContent =
    "Action needs attention · see the message above";
}
function snapshot() {
  if (!state.project) return;
  state.undo.push(JSON.stringify(state.project));
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
  updateHistory();
}
function updateHistory() {
  $("undo").disabled = !state.undo.length;
  $("redo").disabled = !state.redo.length;
}
function undo(redo = false) {
  const from = redo ? state.redo : state.undo,
    to = redo ? state.undo : state.redo;
  if (!from.length) return;
  to.push(JSON.stringify(state.project));
  state.project = JSON.parse(from.pop());
  normalizeSelection();
  changed(true);
  updateHistory();
}
function normalizeSelection() {
  if (state.selectionType === "camera") return;
  const items =
    state.selectionType === "object"
      ? state.project.objects
      : state.selectionType === "animation"
        ? state.project.animations
        : state.project.clips;
  if (!items.some((i) => i.id === state.selection)) {
    state.selection = state.project.objects[0]?.id;
    state.selectionType = "object";
  }
}
function selected() {
  if (state.selectionType === "camera") return state.project.camera;
  return (
    state.selectionType === "object"
      ? state.project.objects
      : state.selectionType === "animation"
        ? state.project.animations
        : state.project.clips
  ).find((o) => o.id === state.selection);
}
function select(id, type = "object") {
  state.selection = id;
  state.selectionType = type;
  renderOutliner();
  renderProperties();
  renderTimeline();
  draw();
  if (type === "clip" && state.mode === "render") syncMonitor(true);
}
function totalDuration() {
  return Math.max(
    state.project.duration,
    ...state.project.animations.map((a) => a.start + a.duration),
    ...state.project.clips.map((c) => c.start + clipDuration(c)),
    0.1,
  );
}
function clipDuration(c) {
  return (c.out_point - c.in_point) / c.speed;
}
function changed(full = false) {
  state.project.camera ??= { phi: 0, theta: -90, zoom: 1, auto_3d: true };
  window.StageViewport?.sync();
  state.dirty = true;
  $("save-state").textContent = "Unsaved changes";
  $("project-name").innerHTML = esc(state.project.name) + " <span>⌄</span>";
  $("scene-label").textContent = state.project.name;
  $("fps-label").textContent = state.project.fps + " FPS";
  if (full) {
    renderOutliner();
    renderProperties();
  }
  renderTimeline();
  draw();
  queueCompile();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveProject(false), 1300);
}
async function saveProject(notify = true) {
  try {
    await api("project", {
      method: "PUT",
      body: JSON.stringify(state.project),
    });
    state.dirty = false;
    $("save-state").textContent = "Saved locally";
    if (notify) toast("Project saved to your local workspace.");
  } catch (e) {
    $("save-state").textContent = "Save failed";
    fail(e);
  }
}
function queueCompile() {
  clearTimeout(codeTimer);
  codeTimer = setTimeout(compile, 250);
}
async function compile() {
  const n = ++compileSequence;
  try {
    const data = await api("compile", {
      method: "POST",
      body: JSON.stringify(state.project),
    });
    if (n !== compileSequence) return;
    state.code = data.code;
    highlightCode();
    window.CodeWorkspace?.syncVisual(state.project, data.code);
    $("footer-status").textContent = state.project.code_override
      ? "Manual Python override is active."
      : "All changes are local. Your next idea is one drag away.";
  } catch (e) {
    if (n === compileSequence) {
      window.CodeWorkspace?.visualError(e.message);
      $("footer-status").textContent = e.message;
      if (state.inspector === "code") {
        $("code-highlight").textContent = e.message;
      }
    }
  }
}
function highlightCode() {
  if (!$("code-editor").hidden) return;
  const tokens =
    /(#[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:from|import|class|def|self|lambda|return|for|in|if|else|True|False|None)\b|\b\d+(?:\.\d+)?\b)/g;
  let out = "",
    last = 0;
  for (const m of state.code.matchAll(tokens)) {
    out += esc(state.code.slice(last, m.index));
    const token = m[0],
      cls =
        token[0] === "#"
          ? "comment"
          : /^["']/.test(token)
            ? "str"
            : /^\d/.test(token)
              ? "num"
              : "kw";
    out += `<span class="${cls}">${esc(token)}</span>`;
    last = m.index + token.length;
  }
  out += esc(state.code.slice(last));
  $("code-highlight").innerHTML = out;
  $("code-warning").hidden = !state.project.code_override;
}
function objectPreset(kind) {
  return state.catalog.objects.find((o) => o.kind === kind);
}
function renderLibrary() {
  const animation = state.library === "animations";
  const cats = [
    "All",
    ...new Set(state.catalog.objects.map((o) => o.category)),
  ];
  $("category-filters").hidden = animation;
  $("category-filters").innerHTML = cats
    .map(
      (c) =>
        `<button class="${state.category === c ? "active" : ""}" data-category="${esc(c)}">${esc(c)}</button>`,
    )
    .join("");
  const q = $("preset-search").value.toLowerCase();
  let items = animation
    ? state.catalog.animations.map((kind, i) => ({
        kind,
        icon: ["↗", "✎", "↥", "↧", "⇄", "⇆", "◎", "∿", "⟳", "◈", "⤾", "Ⅱ"][i],
      }))
    : state.catalog.objects.filter(
        (o) => state.category === "All" || o.category === state.category,
      );
  items = items.filter((o) => o.kind.toLowerCase().includes(q));
  $("preset-cards").innerHTML =
    items
      .map(
        (o) =>
          `<button class="preset-card ${animation ? "animation-card" : ""}" draggable="true" data-preset="${esc(o.kind)}" data-type="${animation ? "animation" : "object"}" title="${esc(o.kind)} · drag to stage or click to add"><span class="preset-icon">${o.icon}</span><span class="preset-name">${esc(o.kind)}</span></button>`,
      )
      .join("") || '<p class="inspector-note">No matching presets.</p>';
}
function addObject(kind, position = [0, 0, 0]) {
  const p = objectPreset(kind);
  if (!p) return;
  snapshot();
  const color = ["#a78bfa", "#5eead4", "#f5b65b", "#f29bae"][
    state.project.objects.length % 4
  ];
  const o = {
    id: uid("obj"),
    kind,
    name: kind,
    position,
    scale: 1,
    color,
    stroke_width: ["Text", "Title", "MathTex", "Matrix", "Table"].includes(kind)
      ? 0
      : 3,
    opacity: 1,
    visible: true,
    locked: false,
    params: copy(p.params),
  };
  state.project.objects.push(o);
  state.selection = o.id;
  state.selectionType = "object";
  state.simulate = false;
  changed(true);
  toast(kind + " added to scene.");
}
function addAnimation(kind, start = state.time, objectId = null, track = null) {
  const obj = objectId
    ? state.project.objects.find((o) => o.id === objectId)
    : state.selectionType === "object"
      ? selected()
      : state.project.objects.find((o) => o.id === selected()?.object_id);
  if (!["Wait", "MoveCamera", "AmbientRotation"].includes(kind) && !obj) {
    toast("Select an object before adding an animation.", true);
    return;
  }
  const targetKinds = ["Transform", "ReplacementTransform", "MoveAlongPath"];
  const target = targetKinds.includes(kind)
    ? state.project.objects.find((o) => o.id !== obj?.id)
    : null;
  if (targetKinds.includes(kind) && !target) {
    toast("Add a second object to use as the target or path.", true);
    return;
  }
  snapshot();
  const same = state.project.animations.filter((a) => a.object_id === obj?.id);
  let at = Math.max(0, start);
  while (
    same.some(
      (a) => at < a.start + a.duration - 0.001 && at + 1.5 > a.start + 0.001,
    )
  ) {
    at = Math.max(
      ...same
        .filter((a) => at < a.start + a.duration && at + 1.5 > a.start)
        .map((a) => a.start + a.duration),
    );
  }
  const a = {
    id: uid("anim"),
    kind,
    object_id: ["Wait", "MoveCamera", "AmbientRotation"].includes(kind)
      ? null
      : obj.id,
    target_id: target?.id ?? null,
    start: round(at),
    duration: 1.5,
    easing: kind === "Indicate" ? "there_and_back" : "smooth",
    track:
      track ?? (obj && ["Text", "Title", "MathTex"].includes(obj.kind) ? 1 : 2),
    angle: 90,
  };
  state.project.animations.push(a);
  state.selection = a.id;
  state.selectionType = "animation";
  changed(true);
  toast(`${kind} added at ${at.toFixed(1)}s.`);
}
function renderOutliner() {
  $("object-count").textContent = state.project.objects.length;
  $("viewport-object").textContent = state.project.objects.length + " OBJECTS";
  $("outliner").innerHTML = state.project.objects
    .map(
      (o) =>
        `<div class="outliner-row ${state.selection === o.id ? "selected" : ""} ${!o.visible ? "invisible" : ""}" data-object="${o.id}" draggable="true" title="${esc(o.kind)} · drag rows to reorder layers"><button class="expand-object" data-expand="${o.id}" title="Show animations" aria-label="Show animations for ${esc(o.name)}">${state.expanded.has(o.id) ? "⌄" : "›"}</button><span class="object-symbol" style="color:${o.color}">${objectPreset(o.kind)?.icon || "◇"}</span><span class="object-name">${esc(o.name)}</span><button data-visibility="${o.id}" class="row-control ${o.visible ? "on" : ""}" title="${o.visible ? "Hide" : "Show"} object" aria-label="${o.visible ? "Hide" : "Show"} ${esc(o.name)}">${o.visible ? "◉" : "○"}</button><button data-lock="${o.id}" class="row-control ${o.locked ? "on" : ""}" title="${o.locked ? "Unlock" : "Lock"} object" aria-label="${o.locked ? "Unlock" : "Lock"} ${esc(o.name)}">${o.locked ? "▣" : "▫"}</button></div>${
          state.expanded.has(o.id)
            ? state.project.animations
                .filter((a) => a.object_id === o.id)
                .map(
                  (a) =>
                    `<button class="outliner-animation ${state.selection === a.id ? "selected" : ""}" data-outliner-animation="${a.id}">⤳ ${esc(a.kind)} <span>${a.start.toFixed(1)}s</span></button>`,
                )
                .join("")
            : ""
        }`,
    )
    .join("");
}
const field = (label, content, vertical = false) =>
  `<label class="field ${vertical ? "vertical" : ""}"><span>${label}</span>${content}</label>`;
const input = (name, value, type = "number", extra = "") =>
  `<input data-field="${esc(name)}" type="${type}" value="${esc(typeof value === "number" ? round(value) : value)}" ${type === "number" && !extra.includes("step=") ? 'step="0.1"' : ""} ${extra}>`;
const dropdown = (name, value, options) =>
  `<select data-field="${esc(name)}">${options.map((o) => `<option value="${esc(typeof o === "string" ? o : o.value)}" ${(typeof o === "string" ? o : o.value) === value ? "selected" : ""}>${esc(typeof o === "string" ? o : o.label)}</option>`).join("")}</select>`;
const section = (title, body) =>
  `<section class="prop-section"><h3>${title}<span>⌄</span></h3>${body}</section>`;
function renderProperties() {
  const o = selected();
  let html = "";
  if (!o) {
    html =
      '<div class="empty-properties">Select an object, animation, or video clip to edit its properties.</div>' +
      section(
        "Scene",
        field(
          "Duration",
          input(
            "scene.duration",
            state.project.duration,
            "number",
            'min="0.1"',
          ),
        ) +
          field(
            "Frame rate",
            input(
              "scene.fps",
              state.project.fps,
              "number",
              'min="1" max="120"',
            ),
          ),
      );
    $("properties").innerHTML = html;
    return;
  }
  if (state.selectionType === "camera") {
    const viewCamera = window.StageViewport?.cameraState() || o;
    html =
      '<div class="selection-summary"><span class="object-icon">◉</span><div><h3>Scene camera</h3><p>Manim / 3D camera</p></div></div>' +
      section(
        "Orientation",
        field(
          "Auto 3D view",
          `<input data-field="scene.camera.auto_3d" type="checkbox" ${o.auto_3d ? "checked" : ""}>`,
        ) +
          field(
            "Phi / degrees",
            input("scene.camera.phi", viewCamera.phi, "number", `min="0" max="180" ${state.is3d ? "" : "disabled"}`),
          ) +
          field(
            "Theta / degrees",
            input(
              "scene.camera.theta",
              viewCamera.theta,
              "number",
              `min="-360" max="360" ${state.is3d ? "" : "disabled"}`,
            ),
          ) +
          field(
            "Zoom",
            input("scene.camera.zoom", o.zoom, "number", 'min="0.1" max="5"'),
          ) +
          '<p class="inspector-note">The 2D/3D toggle controls the stage and render camera. Orbit with MMB or Alt+drag; pan with Shift+MMB or RMB. Auto 3D keeps legacy projects compatible.</p>',
      ) +
      section(
        "Camera motion",
        '<div class="object-actions"><button id="camera-move" class="quiet-button">Move camera</button><button id="camera-ambient" class="quiet-button">Ambient rotation</button></div>',
      );
    $("properties").innerHTML = html;
    $("selection-label").textContent = "Scene camera";
    return;
  }
  const type = state.selectionType,
    icon =
      type === "object"
        ? objectPreset(o.kind)?.icon
        : type === "clip"
          ? "▷"
          : "⤳";
  html = `<div class="selection-summary"><span class="object-icon">${icon || "◇"}</span><div><h3>${esc(type === "animation" ? o.kind : o.name)}</h3><p>${type === "object" ? esc(o.kind) + " / Mobject" : type === "clip" ? "Video / Non-destructive edits" : "Animation / " + esc(state.project.objects.find((x) => x.id === o.object_id)?.name || "Scene")}</p></div></div>`;
  if (type === "object") {
    html += section(
      "Transform",
      `<div class="${o.locked ? "prop-locked" : ""}"><label class="field">Position</label><div class="position-inputs">${(state.is3d ? ["X", "Y", "Z"] : ["X", "Y"]).map((axis, i) => `<label class="axis-input" data-axis="${axis}"><span>${axis}</span>${input("position." + i, o.position[i], "number", 'aria-label="Position ' + axis + '"')}</label>`).join("")}</div>${field("Scale", input("scale", o.scale, "number", 'min="0.01" max="100"'))}</div>`,
    );
    html += section(
      "Appearance",
      field(
        "Color",
        `<span class="color-field">${input("color", o.color, "color")}${input("color", o.color, "text", 'pattern="#[0-9a-fA-F]{6}"')}</span>`,
      ) +
        field(
          "Stroke width",
          input("stroke_width", o.stroke_width, "number", 'min="0" max="30"'),
        ) +
        field(
          "Opacity",
          input("opacity", o.opacity, "range", 'min="0" max="1" step="0.01"'),
        ),
    );
    let params = "";
    for (const [key, value] of Object.entries({
      ...objectPreset(o.kind)?.params,
      ...o.params,
    })) {
      if (!state.is3d && ["z", "z_expression", "z_min", "z_max"].includes(key)) continue;
      const label = key
        .replace(/_/g, " ")
        .replace(/^\w/, (x) => x.toUpperCase());
      params += field(
        label,
        key === "text" || key === "values"
          ? `<textarea data-field="params.${key}" rows="2">${esc(value)}</textarea>`
          : input(
              "params." + key,
              value,
              typeof value === "number" ? "number" : "text",
            ),
        typeof value !== "number",
      );
    }
    if (o.kind === "MathTex")
      params += field(
        "LaTeX templates",
        `<select id="latex-template"><option value="">Insert a template…</option>${Object.keys(
          state.catalog.latex,
        )
          .map((k) => `<option>${k}</option>`)
          .join("")}</select>`,
        true,
      );
    if (params) html += section("Object settings", params);
    html += section("Viewport overlay", field("Fixed in frame", `<input data-field="fixed_in_frame" type="checkbox" ${o.fixed_in_frame ? "checked" : ""}>`));
    const anims = state.project.animations.filter((a) => a.object_id === o.id);
    html += section(
      "Motion",
      field(
        "Add animation",
        `<select id="quick-animation"><option value="">Choose transition…</option>${state.catalog.animations
          .filter((k) => !["Wait", "MoveCamera", "AmbientRotation"].includes(k))
          .map((k) => `<option>${k}</option>`)
          .join("")}</select>`,
      ) +
        anims
          .map(
            (a) =>
              `<button class="prop-chip" data-select-animation="${a.id}" style="margin:3px 3px 0 0">${esc(a.kind)} · ${a.start.toFixed(1)}s</button>`,
          )
          .join("") +
        (!anims.length
          ? '<p class="inspector-note">Add a transition to bring this object to life.</p>'
          : ""),
    );
    html += section(
      "Object",
      field("Name", input("name", o.name, "text")) +
        `<div class="object-actions"><button id="duplicate-object" class="quiet-button">⧉ Duplicate</button><button id="delete-selection" class="danger-button">Delete</button></div><div class="object-actions"><button id="layer-down" class="quiet-button">↓ Layer</button><button id="layer-up" class="quiet-button">↑ Layer</button></div>`,
    );
  } else if (type === "animation") {
    html += section(
      "Timing",
      field("Start / seconds", input("start", o.start, "number", 'min="0"')) +
        field(
          "Duration",
          input("duration", o.duration, "number", 'min="0.05"'),
        ) +
        field(
          "Track",
          dropdown("track", String(o.track), [
            { value: "0", label: "Structure" },
            { value: "1", label: "Typography" },
            { value: "2", label: "Animation" },
          ]),
        ) +
        field(
          "Easing",
          dropdown("easing", o.easing, [
            "smooth",
            "linear",
            "there_and_back",
            "ease_in_sine",
            "ease_out_sine",
          ]),
        ) +
        `<div class="easing-preview"><svg viewBox="0 0 200 32"><path d="${o.easing === "linear" ? "M5 27L195 5" : o.easing === "there_and_back" ? "M5 27Q100 -18 195 27" : "M5 27C95 27 105 5 195 5"}" fill="none" stroke="#b39af8" stroke-width="1.5"/></svg></div>`,
    );
    const opts = state.project.objects.map((x) => ({
      value: x.id,
      label: x.name,
    }));
    if (o.object_id)
      html += section(
        "Object",
        field("Mobject", dropdown("object_id", o.object_id, opts)),
      );
    if (["Transform", "ReplacementTransform", "MoveAlongPath"].includes(o.kind))
      html += section(
        o.kind === "MoveAlongPath" ? "Path" : "Transform target",
        field(
          "Target",
          dropdown(
            "target_id",
            o.target_id,
            opts.filter((x) => x.value !== o.object_id),
          ),
        ),
      );
    if (["Rotate", "MoveCamera", "AmbientRotation"].includes(o.kind))
      html += section(
        "Rotation",
        field("Angle / degrees", input("angle", o.angle)),
      );
    html += section(
      "Animation",
      field(
        "Transition",
        dropdown(
          "kind",
          o.kind,
          state.catalog.animations.filter((k) =>
            ["Wait", "MoveCamera", "AmbientRotation"].includes(o.kind)
              ? ["Wait", "MoveCamera", "AmbientRotation"].includes(k)
              : ![
                  "Wait",
                  "MoveCamera",
                  "AmbientRotation",
                  "Transform",
                  "ReplacementTransform",
                  "MoveAlongPath",
                ].includes(k) || k === o.kind,
          ),
        ),
      ) +
        '<button id="delete-selection" class="danger-button wide">Remove animation</button>',
    );
  } else {
    html += section(
      "Clip timing",
      field("Timeline start", input("start", o.start, "number", 'min="0"')) +
        field("Source in", input("in_point", o.in_point, "number", 'min="0"')) +
        field(
          "Source out",
          input("out_point", o.out_point, "number", 'min="0.01"'),
        ) +
        field(
          "Speed",
          input("speed", o.speed, "number", 'min="0.25" max="4" step="0.05"'),
        ) +
        field(
          "Retiming",
          input("speed", o.speed, "range", 'min="0.25" max="4" step="0.05"'),
        ) +
        `<p class="inspector-note">${clipDuration(o).toFixed(2)}s on timeline · ${o.speed.toFixed(2)}× playback</p><div class="object-actions"><button id="property-split" class="quiet-button">✂ Split at playhead</button></div>`,
    );
    html += section(
      "Crop & framing",
      field(
        "Aspect ratio",
        `<select id="crop-aspect"><option value="free">Freeform</option><option value="16:9">16:9 · Landscape</option><option value="9:16">9:16 · Vertical</option><option value="1:1">1:1 · Square</option></select>`,
      ) +
        ["x", "y", "width", "height"]
          .map((k) =>
            field(
              k[0].toUpperCase() + k.slice(1),
              input(
                "crop." + k,
                o.crop[k],
                "number",
                'min="0" max="1" step="0.01"',
              ),
            ),
          )
          .join("") +
        `<div class="object-actions"><button id="show-crop" class="quiet-button">⌗ Edit crop on monitor</button><button id="reset-crop" class="quiet-button">Reset</button></div><p class="inspector-note">Crop coordinates are fractions of the source frame. Drag the frame or its corners in the monitor.</p>`,
    );
    html += section(
      "Source",
      `<p class="inspector-note">${esc(o.source)}</p><div class="object-actions"><button id="delete-selection" class="danger-button">Remove clip</button></div>`,
    );
  }
  html += section(
    "Scene settings",
    field(
      "Duration",
      input(
        "scene.duration",
        state.project.duration,
        "number",
        'min="0.1" max="3600"',
      ),
    ) +
      field(
        "Frame rate",
        input("scene.fps", state.project.fps, "number", 'min="1" max="120"'),
      ) +
      field(
        "Background",
        input("scene.background", state.project.background, "color"),
      ),
  );
  $("properties").innerHTML = html;
  $("selection-label").textContent =
    type === "object" ? o.name : type === "animation" ? o.kind : o.name;
}
function setProperty(element) {
  const key = element.dataset.field;
  if (!key) return;
  const o = selected();
  const raw =
    element.type === "checkbox"
      ? element.checked
      : element.type === "number" || element.type === "range"
        ? Number(element.value)
        : element.value;
  if (
    typeof raw === "number" &&
    (!Number.isFinite(raw) ||
      (element.min !== "" && raw < Number(element.min)) ||
      (element.max !== "" && raw > Number(element.max)))
  ) {
    toast("Enter a value within the displayed bounds.", true);
    renderProperties();
    return;
  }
  const target = key.startsWith("scene.") ? state.project : o;
  if (!target) return;
  const parts = key.replace(/^scene\./, "").split(".");
  let data = target;
  for (const part of parts.slice(0, -1)) data = data[part];
  const name = parts.at(-1);
  let value = raw;
  if (key === "track") value = Number(value);
  if (key === "color" && !/^#[0-9a-f]{6}$/i.test(value)) {
    toast("Use a six-digit hex color.", true);
    return;
  }
  if (o?.locked && (key.startsWith("position.") || key === "scale")) return;
  const previous = copy(state.project);
  snapshot();
  data[name] = value;
  if (key.startsWith("scene.camera.")) {
    const camera = state.project.camera;
    if (key === "scene.camera.auto_3d") camera.dimension = null;
    if (key === "scene.camera.phi" || key === "scene.camera.theta") {
      camera.auto_3d = false;
      camera.dimension = camera.phi === 0 && !state.is3d ? "2D" : "3D";
      camera.projection = "perspective";
    }
  }
  if (state.selectionType === "clip" && !key.startsWith("scene.")) {
    if (
      o.speed < 0.25 ||
      o.speed > 4 ||
      o.out_point <= o.in_point ||
      o.crop.x + o.crop.width > 1.000001 ||
      o.crop.y + o.crop.height > 1.000001 ||
      o.crop.width <= 0 ||
      o.crop.height <= 0
    ) {
      state.project = previous;
      state.undo.pop();
      toast(
        "Check clip bounds, crop dimensions, and the 0.25×–4× speed range.",
        true,
      );
      renderProperties();
      return;
    }
  }
  changed(true);
  if (state.mode === "render") syncMonitor(true);
}
function deleteSelection() {
  if (state.selectionType === "camera") return;
  const o = selected();
  if (!o) return;
  if (state.selectionType === "object" && o.locked) {
    toast("Unlock this object to remove it.", true);
    return;
  }
  snapshot();
  if (state.selectionType === "object") {
    state.project.objects = state.project.objects.filter((x) => x.id !== o.id);
    state.project.animations = state.project.animations.filter(
      (a) => a.object_id !== o.id && a.target_id !== o.id,
    );
  } else if (state.selectionType === "animation") {
    state.project.animations = state.project.animations.filter(
      (a) => a.id !== o.id,
    );
  } else state.project.clips = state.project.clips.filter((c) => c.id !== o.id);
  normalizeSelection();
  changed(true);
  syncMonitor(true);
}
function layer(delta) {
  const o = selected();
  if (state.selectionType !== "object" || !o || o.locked) return;
  const i = state.project.objects.indexOf(o),
    j = clamp(i + delta, 0, state.project.objects.length - 1);
  if (i === j) return;
  snapshot();
  [state.project.objects[i], state.project.objects[j]] = [
    state.project.objects[j],
    state.project.objects[i],
  ];
  changed(true);
}

function timecode(t) {
  const frames = Math.floor(Math.max(0, t) * state.project.fps + 1e-4),
    fps = state.project.fps;
  return [
    Math.floor(frames / fps / 60),
    Math.floor(frames / fps) % 60,
    frames % fps,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
function renderTimeline() {
  if (!state.project) return;
  const duration = totalDuration(),
    width = Math.max(
      $("timeline-scroll").clientWidth,
      duration * state.px + 90,
    );
  $("timeline-content").style.width = width + "px";
  $("timeline-duration").textContent = duration.toFixed(1) + "s";
  $("end-timecode").textContent = timecode(duration);
  const step = state.px < 45 ? 2 : 1;
  let marks = "";
  for (let s = 0; s < width / state.px; s += step) {
    marks += `<div class="ruler-mark" style="left:${s * state.px}px">${s}s</div>`;
    marks += `<div class="ruler-mark minor" style="left:${(s + step / 2) * state.px}px"></div>`;
  }
  $("ruler").innerHTML = marks;
  let html = "";
  for (let track = 0; track < 3; track++) {
    html += `<div class="timeline-track" data-track="${track}" style="background-size:${state.px}px 100%">`;
    for (const a of state.project.animations.filter(
      (a) => Math.min(2, a.track) === track,
    )) {
      const obj = state.project.objects.find((o) => o.id === a.object_id);
      html += block(
        a.id,
        "animation",
        a.start,
        a.duration,
        `${a.kind}${obj ? " · " + obj.name : ""}`,
        track,
        a.easing === "linear" ? "╱" : a.easing === "there_and_back" ? "⌒" : "∿",
      );
    }
    html += "</div>";
  }
  html += `<div class="timeline-track video" data-track="video" style="background-size:${state.px}px 100%">`;
  for (const c of state.project.clips) {
    html += block(
      c.id,
      "clip",
      c.start,
      clipDuration(c),
      c.name + (c.speed !== 1 ? " · " + c.speed.toFixed(2) + "×" : ""),
      "video",
      "▷",
    );
  }
  if (!state.project.clips.length)
    html +=
      '<span class="track-empty">Rendered footage lands here. Make a fast draft to get started.</span>';
  html += "</div>";
  $("timeline-tracks").innerHTML = html;
  updatePlayhead();
}
function block(id, type, start, duration, label, track, curve) {
  return `<div class="timeline-block ${track === "video" ? "video-block" : "track-" + track} ${state.selection === id ? "selected" : ""}" data-block="${id}" data-block-type="${type}" style="left:${start * state.px}px;width:${Math.max(5, duration * state.px)}px" title="${esc(label)} · ${start.toFixed(2)}s → ${(start + duration).toFixed(2)}s"><span class="block-edge left" data-edge="left"></span><span class="block-curve">${curve}</span><span class="block-text">${esc(label)}</span><span class="block-edge right" data-edge="right"></span></div>`;
}
function updatePlayhead() {
  $("playhead").style.left = state.time * state.px + "px";
  $("timecode").textContent = timecode(state.time);
}
function seek(time) {
  state.time = clamp(time, 0, totalDuration());
  updatePlayhead();
  draw();
  syncMonitor(true);
}
function togglePlay() {
  state.playing = !state.playing;
  state.simulate = state.playing;
  if (state.time >= totalDuration() - 0.001) state.time = 0;
  $("play").textContent = state.playing ? "Ⅱ" : "▶";
  $("play").setAttribute("aria-label", state.playing ? "Pause" : "Play");
  rafTime = null;
  if (state.playing) requestAnimationFrame(tick);
  else video.pause();
  draw();
}
function tick(now) {
  if (!state.playing) return;
  if (rafTime !== null) state.time += Math.min(0.1, (now - rafTime) / 1000);
  rafTime = now;
  if (state.time >= totalDuration()) {
    state.time = totalDuration();
    togglePlay();
  }
  updatePlayhead();
  draw();
  syncMonitor();
  if (state.playing) requestAnimationFrame(tick);
}
function startBlockDrag(event) {
  const element = event.target.closest("[data-block]");
  if (!element || event.button !== 0) return;
  event.preventDefault();
  const id = element.dataset.block,
    type = element.dataset.blockType;
  select(id, type);
  const item = selected(),
    original = copy(item),
    startX = event.clientX,
    edge = event.target.dataset.edge;
  let moved = false;
  const bounds = $("timeline-tracks").getBoundingClientRect();
  const move = (e) => {
    const delta = (e.clientX - startX) / state.px;
    if (Math.abs(e.clientX - startX) < 3 && !moved) return;
    if (!moved) {
      snapshot();
      moved = true;
    }
    const snap = (n) =>
      e.altKey
        ? round(n)
        : Math.round(n * state.project.fps) / state.project.fps;
    if (!edge) {
      item.start = Math.max(0, snap(original.start + delta));
      if (type === "animation")
        item.track = clamp(Math.floor((e.clientY - bounds.top) / 37), 0, 2);
    } else if (type === "animation") {
      if (edge === "right")
        item.duration = Math.max(0.05, snap(original.duration + delta));
      else {
        const end = original.start + original.duration;
        item.start = clamp(snap(original.start + delta), 0, end - 0.05);
        item.duration = end - item.start;
      }
    } else if ($("trim-mode").value === "stretch") {
      const end = original.start + clipDuration(original);
      const duration = clamp(
        clipDuration(original) + (edge === "left" ? -delta : delta),
        (original.out_point - original.in_point) / 4,
        (original.out_point - original.in_point) / 0.25,
      );
      item.speed = round((original.out_point - original.in_point) / duration);
      if (edge === "left") item.start = Math.max(0, end - duration);
    } else if (edge === "left") {
      const d = clamp(
        snap(delta),
        Math.max(-original.in_point / original.speed, -original.start),
        clipDuration(original) - 0.05,
      );
      item.start = original.start + d;
      item.in_point = original.in_point + d * original.speed;
    } else {
      const maxOut =
        mediaMetadata.get(item.source)?.duration ?? original.out_point;
      item.out_point = clamp(
        original.out_point + snap(delta) * original.speed,
        item.in_point + 0.05 * item.speed,
        maxOut,
      );
    }
    renderTimeline();
    renderProperties();
    draw();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (moved) changed();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}
// A small expression parser keeps imported scenes from executing JavaScript in the viewport.
function mathExpression(source, variables = {}) {
  const funcs = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    exp: Math.exp,
    sqrt: Math.sqrt,
    log: Math.log,
    abs: Math.abs,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    arctan: Math.atan,
    arcsin: Math.asin,
    arccos: Math.acos,
  };
  const tokens =
    String(source).match(
      /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]+|\*\*|[()+\-*/%,]/g,
    ) || [];
  if (tokens.length > 200) throw Error("Expression too long");
  let i = 0;
  const peek = () => tokens[i],
    take = () => tokens[i++];
  function atom() {
    let t = take();
    if (t === "(") {
      const v = add();
      if (take() !== ")") throw Error("Missing closing parenthesis");
      return v;
    }
    if (t in funcs) {
      if (take() !== "(") throw Error("Expected (");
      const v = add();
      if (take() !== ")") throw Error("Expected )");
      return funcs[t](v);
    }
    if (t === "pi") return Math.PI;
    if (t === "e") return Math.E;
    if (Object.hasOwn(variables, t)) return variables[t];
    const v = Number(t);
    if (!Number.isFinite(v)) throw Error("Unknown expression");
    return v;
  }
  function power() {
    let a = atom();
    if (peek() === "**") {
      take();
      const exponent = unary();
      if (Math.abs(exponent) > 20) throw Error("Exponent too large");
      a = a ** exponent;
    }
    return a;
  }
  function unary() {
    if (peek() === "-") {
      take();
      return -unary();
    }
    if (peek() === "+") {
      take();
      return unary();
    }
    return power();
  }
  function mul() {
    let a = unary();
    while (["*", "/", "%"].includes(peek())) {
      const op = take(),
        b = unary();
      a = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
    return a;
  }
  function add() {
    let a = mul();
    while (["+", "-"].includes(peek())) {
      const op = take(),
        b = mul();
      a = op === "+" ? a + b : a - b;
    }
    return a;
  }
  const result = add();
  if (i !== tokens.length) throw Error("Invalid expression");
  return result;
}
let frame = { x: 0, y: 0, w: 1, h: 1, u: 1 },
  hitBoxes = new Map();
function canvasContext(id) {
  const canvas = $(id),
    rect = $("viewport").getBoundingClientRect(),
    ratio = window.devicePixelRatio || 1;
  if (
    canvas.width !== Math.round(rect.width * ratio) ||
    canvas.height !== Math.round(rect.height * ratio)
  ) {
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, w: rect.width, h: rect.height };
}
function stageFrame(w, h) {
  const fw = Math.max(1, Math.min(w - 65, ((h - 66) * 16) / 9)),
    fh = (fw * 9) / 16;
  return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh, u: fh / 8 * state.zoom, baseUnit: fh / 8 };
}
function projectPoint(x, y, z = 0) {
  if (window.StageViewport) return window.StageViewport.project(x, y, z).slice(0, 2);
  if (state.is3d)
    return [
      frame.x + frame.w / 2 + (x * 0.86 - z * 0.5) * frame.u,
      frame.y + frame.h / 2 - (y * 0.86 + z * 0.4 + x * 0.12) * frame.u,
    ];
  return [
    frame.x + frame.w / 2 + x * frame.u,
    frame.y + frame.h / 2 - y * frame.u,
  ];
}
function worldAt(event) {
  if (window.StageViewport) return window.StageViewport.worldAt(event);
  const r = $("viewport").getBoundingClientRect();
  return [
    (event.clientX - r.left - frame.x - frame.w / 2) / frame.u,
    -(event.clientY - r.top - frame.y - frame.h / 2) / frame.u,
    0,
  ];
}
function draw() {
  if (!state.project) return;
  window.StageViewport?.sync();
  if (state.mode === "render") {
    drawCrop();
    return;
  }
  const { ctx, w, h } = canvasContext("stage");
  if (w < 1 || h < 1) return;
  frame = stageFrame(w, h);
  window.StageViewport?.begin(frame, hitBoxes);
  ctx.fillStyle = "#00000035";
  ctx.fillRect(frame.x + 5, frame.y + 7, frame.w, frame.h);
  ctx.fillStyle = state.project.background;
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.clip();
  if (window.StageViewport) window.StageViewport.grid(ctx);
  else if (state.grid) {
    ctx.strokeStyle = "#ffffff06";
    ctx.lineWidth = 1;
    for (let i = -7; i <= 7; i++) {
      line(ctx, projectPoint(i, -4), projectPoint(i, 4));
    }
    for (let i = -4; i <= 4; i++) {
      line(ctx, projectPoint(-7.111, i), projectPoint(7.111, i));
    }
  }
  hitBoxes.clear();
  if (state.is3d && window.StageViewport) window.StageViewport.drawSpatial(ctx);
  else for (const object of [...state.project.objects.filter(o => !o.fixed_in_frame), ...state.project.objects.filter(o => o.fixed_in_frame)]) {
    if (!object.visible) continue;
    try {
      drawObject(ctx, object);
    } catch (e) {
      const p = projectPoint(...object.position);
      ctx.fillStyle = "#c88c9b";
      ctx.font = "10px sans-serif";
      ctx.fillText(object.kind + " · check expression", p[0], p[1]);
    }
  }
  ctx.restore();
  ctx.strokeStyle = "#77708040";
  ctx.lineWidth = 1;
  ctx.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1);
  if (state.safe) {
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "#9f95b050";
    ctx.strokeRect(
      frame.x + frame.w * 0.05,
      frame.y + frame.h * 0.05,
      frame.w * 0.9,
      frame.h * 0.9,
    );
    ctx.strokeRect(
      frame.x + frame.w * 0.1,
      frame.y + frame.h * 0.1,
      frame.w * 0.8,
      frame.h * 0.8,
    );
    ctx.restore();
  }
  const selectedObject =
    state.selectionType === "object"
      ? state.project.objects.find((o) => o.id === state.selection)
      : null;
  if (selectedObject && hitBoxes.has(selectedObject.id)) {
    const b = hitBoxes.get(selectedObject.id);
    ctx.save();
    ctx.strokeStyle = "#bda1fa";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(b.x - 7, b.y - 7, b.w + 14, b.h + 14);
    ctx.setLineDash([]);
    for (const x of [b.x - 7, b.x + b.w + 7])
      for (const y of [b.y - 7, b.y + b.h + 7]) {
        ctx.fillStyle = "#d9c9fc";
        ctx.fillRect(x - 2, y - 2, 4, 4);
      }
    const p = window.StageViewport ? window.StageViewport.project(...selectedObject.position, selectedObject.fixed_in_frame) : projectPoint(...selectedObject.position);
    ctx.fillStyle = "#bda1fa";
    ctx.beginPath();
    ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  $("zoom-label").textContent = Math.round(state.zoom * 100) + "%";
}
function line(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(...a);
  ctx.lineTo(...b);
  ctx.stroke();
}
function drawObject(ctx, o) {
  if (window.StageViewport && (o.fixed_in_frame || ["Surface", "Sphere", "Cube", "ParametricFunction"].includes(o.kind))) {
    window.StageViewport.drawObject(ctx, o);
    return;
  }
  const [ox, oy, oz] = o.position,
    p = o.params,
    s = o.scale,
    u = frame.u * s;
  let alpha = o.opacity,
    progress = 1,
    angle = 0;
  let pos = [ox, oy, oz];
  if (state.simulate) {
    const anims = state.project.animations
      .filter((a) => a.object_id === o.id)
      .sort((a, b) => a.start - b.start);
    for (const a of anims) {
      let t = clamp((state.time - a.start) / a.duration, 0, 1);
      if (["Create", "Write", "FadeIn"].includes(a.kind)) {
        if (a.kind === "FadeIn") alpha *= t;
        else progress *= t;
      }
      if (a.kind === "FadeOut") alpha *= 1 - t;
      if (a.kind === "Rotate") angle += (t * a.angle * Math.PI) / 180;
      if (a.kind === "Indicate" && t > 0 && t < 1)
        alpha *= 0.6 + 0.4 * Math.sin(t * Math.PI);
      if (
        ["Transform", "ReplacementTransform", "MoveAlongPath"].includes(
          a.kind,
        ) &&
        state.time >= a.start
      ) {
        const target = state.project.objects.find((x) => x.id === a.target_id);
        if (target) pos = pos.map((v, i) => v + (target.position[i] - v) * t);
      }
    }
  }
  if (alpha <= 0 || progress <= 0) return;
  const [cx, cy] = projectPoint(...pos);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = Math.max(0.6, (o.stroke_width * frame.u) / 55);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.translate(cx, cy);
  ctx.rotate(-angle);
  const k = o.kind;
  let bw = u * 2,
    bh = u * 2;
  if (k === "Text" || k === "Title" || k === "MathTex") {
    let text = String(p.text || "Mathematics");
    if (k === "MathTex")
      text = text
        .replace(
          /\\(?:frac|sum|int|infty|sin|cos|lim|to|cdot|,)/g,
          (m) =>
            ({
              "\\sum": "Σ",
              "\\int": "∫",
              "\\infty": "∞",
              "\\to": "→",
              "\\cdot": "·",
              "\\,": " ",
            })[m] ?? m.slice(1),
        )
        .replace(/[{}]/g, "");
    const size = ((Number(p.font_size || 32) * frame.u) / 48) * s;
    ctx.font = `${k === "MathTex" ? "italic " : ""}${size}px ${k === "MathTex" ? "Georgia,serif" : '"Segoe UI",sans-serif'}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    bw = ctx.measureText(text).width;
    bh = size * 1.2;
    ctx.globalAlpha = alpha * progress;
    ctx.fillText(text, 0, 0);
  } else if (["Axes", "NumberPlane", "ThreeDAxes"].includes(k)) {
    bw = 12 * u;
    bh = 6 * u;
    if (k === "NumberPlane") {
      ctx.globalAlpha = alpha * 0.45;
      for (let i = -6; i <= 6; i++) line(ctx, [i * u, -3 * u], [i * u, 3 * u]);
      for (let i = -3; i <= 3; i++) line(ctx, [-6 * u, i * u], [6 * u, i * u]);
      ctx.globalAlpha = alpha;
    }
    ctx.lineWidth = Math.max(0.7, frame.u / 60);
    line(ctx, [-6 * u, 0], [-6 * u + 12 * u * progress, 0]);
    line(ctx, [0, 3 * u], [0, 3 * u - 6 * u * progress]);
    for (let x = -5; x <= 5; x++) {
      line(ctx, [x * u, -3], [x * u, 3]);
      if (x !== 0) {
        ctx.font = `${Math.max(8, u * 0.17)}px ui-monospace,monospace`;
        ctx.fillStyle = "#697187";
        ctx.textAlign = "center";
        ctx.fillText(String(x), x * u, 16);
      }
    }
    for (let y = -2; y <= 2; y++) line(ctx, [-3, y * u], [3, y * u]);
  } else if (k === "FunctionGraph") {
    const min = Number(p.x_min ?? -5),
      max = Number(p.x_max ?? 5);
    bw = (max - min) * u;
    bh = 4 * u;
    ctx.beginPath();
    let begun = false;
    const points = [];
    for (let i = 0; i <= 240 * progress; i++) {
      const x = min + ((max - min) * i) / 240,
        y = mathExpression(p.expression || "sin(x)", { x });
      if (!Number.isFinite(y) || Math.abs(y) > 50) {
        begun = false;
        continue;
      }
      const a = [x * u, -y * u];
      points.push(a);
      if (!begun) {
        ctx.moveTo(...a);
        begun = true;
      } else ctx.lineTo(...a);
    }
    ctx.stroke();
    if (points.length) {
      const xs = points.map((v) => v[0]),
        ys = points.map((v) => v[1]);
      const left = Math.min(...xs),
        top = Math.max(
          -4 * frame.u - cy + frame.y + frame.h / 2,
          Math.min(...ys),
        );
      hitBoxes.set(o.id, {
        x: cx + left,
        y: cy + top,
        w: Math.max(...xs) - left,
        h: Math.min(frame.h, Math.max(...ys) - top),
      });
    }
  } else if (k === "Circle" || k === "Dot") {
    const r = Number(p.radius ?? (k === "Dot" ? 0.08 : 1)) * u;
    bw = bh = r * 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 2 * Math.PI * progress);
    if (k === "Dot") ctx.fill();
    else ctx.stroke();
  } else if (k === "Square" || k === "Polygon") {
    const n = k === "Square" ? 4 : Number(p.sides || 3),
      r =
        k === "Square"
          ? (Number(p.side_length || 2) * u) / Math.SQRT2
          : Number(p.radius || 1.3) * u;
    bw = bh = r * 2;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a =
        (2 * Math.PI * i) / n + (k === "Square" ? Math.PI / 4 : -Math.PI / 2);
      const x = Math.cos(a) * r,
        y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else if (k === "Vector" || k === "Line") {
    const x = Number(p.x ?? 2) * u,
      y = -Number(p.y ?? 1) * u;
    line(ctx, [0, 0], [x * progress, y * progress]);
    if (k === "Vector") {
      const a = Math.atan2(y, x);
      line(
        ctx,
        [x, y],
        [x - 10 * Math.cos(a - 0.4), y - 10 * Math.sin(a - 0.4)],
      );
      line(
        ctx,
        [x, y],
        [x - 10 * Math.cos(a + 0.4), y - 10 * Math.sin(a + 0.4)],
      );
    }
    bw = Math.max(u, Math.abs(x) * 2);
    bh = Math.max(u, Math.abs(y) * 2);
  } else if (k === "Brace") {
    const width = Number(p.width ?? 3) * u;
    bw = width;
    bh = u * 0.4;
    ctx.beginPath();
    ctx.moveTo(-width / 2, -5);
    ctx.quadraticCurveTo(-width / 2, 7, -width / 4, 7);
    ctx.quadraticCurveTo(0, 7, 0, 15);
    ctx.quadraticCurveTo(0, 7, width / 4, 7);
    ctx.quadraticCurveTo(width / 2, 7, width / 2, -5);
    ctx.stroke();
  } else if (k === "Matrix" || k === "Table") {
    let vals = typeof p.values === "string" ? JSON.parse(p.values) : p.values;
    vals = vals || [
      [1, 0],
      [0, 1],
    ];
    const cell = u * 0.7;
    bw = vals[0].length * cell;
    bh = vals.length * cell;
    ctx.font = `${u * 0.38}px Georgia,serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    vals.forEach((row, y) =>
      row.forEach((v, x) => {
        ctx.fillText(
          String(v),
          (x + 0.5) * cell - bw / 2,
          (y + 0.5) * cell - bh / 2,
        );
        if (k === "Table")
          ctx.strokeRect(x * cell - bw / 2, y * cell - bh / 2, cell, cell);
      }),
    );
    if (k === "Matrix") {
      line(ctx, [-bw / 2 - 4, -bh / 2], [-bw / 2 - 4, bh / 2]);
      line(ctx, [bw / 2 + 4, -bh / 2], [bw / 2 + 4, bh / 2]);
    }
  } else if (k === "ParametricFunction") {
    const min = Number(p.t_min ?? 0),
      max = Number(p.t_max ?? 6.283);
    bw = bh = 4 * u;
    ctx.beginPath();
    for (let i = 0; i <= 200 * progress; i++) {
      const t = min + ((max - min) * i) / 200,
        x = mathExpression(p.x_expression || "2*cos(t)", { t }),
        y = mathExpression(p.y_expression || "2*sin(t)", { t }),
        z = mathExpression(p.z_expression || "0", { t });
      const pt = state.is3d
        ? [(x * 0.86 - z * 0.5) * u, -(y * 0.86 + z * 0.4 + x * 0.12) * u]
        : [x * u, -y * u];
      if (i === 0) ctx.moveTo(...pt);
      else ctx.lineTo(...pt);
    }
    ctx.stroke();
  } else if (k === "Surface") {
    bw = 6 * u;
    bh = 5 * u;
    const min = Number(p.u_min ?? -3),
      max = Number(p.u_max ?? 3),
      vmin = Number(p.v_min ?? -3),
      vmax = Number(p.v_max ?? 3);
    for (let j = 0; j <= 16; j++) {
      ctx.beginPath();
      for (let i = 0; i <= 32; i++) {
        const a = min + ((max - min) * i) / 32,
          b = vmin + ((vmax - vmin) * j) / 16,
          z = mathExpression(p.expression || "sin(u)*cos(v)", { u: a, v: b });
        const pt = [
          (a * 0.8 - b * 0.45) * u,
          (-z * 0.8 - b * 0.4 - a * 0.12) * u,
        ];
        if (i === 0) ctx.moveTo(...pt);
        else ctx.lineTo(...pt);
      }
      ctx.globalAlpha = alpha * 0.5;
      ctx.stroke();
    }
  } else if (k === "VectorField") {
    bw = 10 * u;
    bh = 6 * u;
    ctx.lineWidth = 1;
    for (let x = -5; x <= 5; x++)
      for (let y = -3; y <= 3; y++) {
        const dx = mathExpression(p.x_expression || "-y/3", { x, y }),
          dy = mathExpression(p.y_expression || "x/3", { x, y }),
          mag = Math.hypot(dx, dy) || 1,
          end = [x * u + (dx / mag) * u * 0.45, -y * u - (dy / mag) * u * 0.45];
        line(ctx, [x * u, -y * u], end);
        const a = Math.atan2(-dy, dx);
        line(ctx, end, [
          end[0] - 5 * Math.cos(a - 0.5),
          end[1] - 5 * Math.sin(a - 0.5),
        ]);
      }
  }
  if (!hitBoxes.has(o.id))
    hitBoxes.set(o.id, { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh });
  ctx.restore();
}
function stagePointer(event) {
  if (window.StageViewport?.navigate(event)) return;
  if (state.mode !== "stage" || event.button !== 0) return;
  const r = $("viewport").getBoundingClientRect(),
    x = event.clientX - r.left,
    y = event.clientY - r.top;
  let hit;
  if (state.is3d && window.StageViewport) hit = window.StageViewport.hitTest(x, y);
  const candidates = [...state.project.objects]
    .reverse()
    .filter((o) => o.visible && !o.locked);
  for (const o of candidates) {
    if (state.is3d && window.StageViewport) break;
    const b = hitBoxes.get(o.id);
    if (
      b &&
      x >= b.x - 7 &&
      x <= b.x + b.w + 7 &&
      y >= b.y - 7 &&
      y <= b.y + b.h + 7
    ) {
      hit = o;
      if (!["Axes", "NumberPlane", "ThreeDAxes"].includes(o.kind)) break;
    }
  }
  if (!hit) return;
  select(hit.id);
  const origin = copy(hit.position),
    startX = event.clientX,
    startY = event.clientY;
  let moved = false;
  const move = (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) < 3 && !moved)
      return;
    if (!moved) {
      snapshot();
      moved = true;
    }
    const delta = window.StageViewport?.screenDelta(e.clientX - startX, e.clientY - startY, origin, hit.fixed_in_frame);
    hit.position = delta ? origin.map((v, i) => round(v + delta[i])) : [round(origin[0] + (e.clientX-startX)/frame.u), round(origin[1] - (e.clientY-startY)/frame.u), origin[2]];
    if (e.shiftKey)
      hit.position = hit.position.map((v) => Math.round(v * 2) / 2);
    renderProperties();
    draw();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    if (moved) changed();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

const mediaMetadata = new Map();
let currentSource = null,
  monitorGeneration = 0;
async function metadata(source) {
  if (!mediaMetadata.has(source))
    mediaMetadata.set(
      source,
      await api("media-info?source=" + encodeURIComponent(source)),
    );
  return mediaMetadata.get(source);
}
function setMode(mode) {
  window.CodeWorkspace?.leave();
  state.mode = mode;
  window.StageViewport?.sync();
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("stage").hidden = mode !== "stage";
  $("monitor").hidden = mode !== "render";
  $("overlay").hidden = mode !== "render";
  $("monitor-empty").hidden =
    mode !== "render" || state.project.clips.length > 0;
  $("view-label").textContent =
    mode === "stage" ? "Scene / Layout" : "Footage / Monitor";
  $("viewport-caption").textContent =
    mode === "stage"
      ? state.is3d
        ? "PERSPECTIVE / 3D"
        : "PERSPECTIVE / FRONT"
      : "RENDER / SOURCE";
  $("viewport-help").textContent =
    mode === "stage"
      ? "Drag objects to position · Scroll to zoom"
      : "Source preview · Crops apply on export";
  if (mode === "stage") {
    video.pause();
    $("zoom-label").textContent = Math.round(state.zoom * 100) + "%";
  } else {
    if (state.project.clips.length && state.selectionType !== "clip")
      select(state.project.clips[0].id, "clip");
    syncMonitor(true);
  }
  draw();
}
function activeClip() {
  return [...state.project.clips]
    .sort((a, b) => a.start - b.start)
    .find(
      (c) =>
        state.time >= c.start - 0.00001 &&
        state.time < c.start + clipDuration(c) - 0.00001,
    );
}
function syncMonitor(force = false) {
  if (state.mode !== "render") return;
  let clip = activeClip();
  const picked = state.selectionType === "clip" ? selected() : null;
  if (!clip && !state.playing && force && picked) clip = picked;
  if (!clip) {
    video.pause();
    video.style.opacity = "0";
    $("zoom-label").textContent = "GAP";
    drawCrop();
    return;
  }
  video.style.opacity = "1";
  $("monitor-empty").hidden = true;
  const source = clip.source;
  if (currentSource !== source) {
    currentSource = source;
    video.src = "/media/" + source;
    const generation = ++monitorGeneration;
    metadata(source)
      .then((info) => {
        if (generation !== monitorGeneration) return;
        $("quality-label").textContent = `${info.width} × ${info.height}`;
        drawCrop();
      })
      .catch(fail);
  }
  const target =
    clip.in_point +
    clamp(state.time - clip.start, 0, clipDuration(clip)) * clip.speed;
  video.playbackRate = clip.speed;
  if (
    video.readyState >= 1 &&
    (force || Math.abs(video.currentTime - target) > 0.15)
  )
    video.currentTime = Math.min(target, clip.out_point - 0.001);
  if (state.playing && video.paused) video.play().catch(() => {});
  else if (!state.playing) video.pause();
  $("zoom-label").textContent = clip.speed.toFixed(2) + "×";
  drawCrop();
}
video.addEventListener("loadedmetadata", () => syncMonitor(true));
video.addEventListener("error", () =>
  toast(
    "This rendered source is unavailable. Check your workspace or render the scene again.",
    true,
  ),
);
function videoRect(w, h) {
  const vw = video.videoWidth || 1920,
    vh = video.videoHeight || 1080,
    scale = Math.min(w / vw, h / vh);
  return {
    x: (w - vw * scale) / 2,
    y: (h - vh * scale) / 2,
    w: vw * scale,
    h: vh * scale,
  };
}
function drawCrop() {
  if (state.mode !== "render") return;
  const { ctx, w, h } = canvasContext("overlay");
  const c = state.selectionType === "clip" ? selected() : activeClip();
  if (!c || !state.crop) return;
  const r = videoRect(w, h),
    b = {
      x: r.x + c.crop.x * r.w,
      y: r.y + c.crop.y * r.h,
      w: c.crop.width * r.w,
      h: c.crop.height * r.h,
    };
  ctx.fillStyle = "#0008";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.clearRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = "#e8cd9a";
  ctx.lineWidth = 1;
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = "#e8cd9a44";
  for (const t of [1 / 3, 2 / 3]) {
    line(ctx, [b.x + b.w * t, b.y], [b.x + b.w * t, b.y + b.h]);
    line(ctx, [b.x, b.y + b.h * t], [b.x + b.w, b.y + b.h * t]);
  }
  ctx.fillStyle = "#f5dfb9";
  for (const x of [b.x, b.x + b.w])
    for (const y of [b.y, b.y + b.h]) ctx.fillRect(x - 4, y - 4, 8, 8);
  ctx.font = "10px ui-monospace,monospace";
  ctx.fillText(
    "CROP · " +
      Math.round(c.crop.width * 100) +
      "% × " +
      Math.round(c.crop.height * 100) +
      "%",
    b.x + 8,
    b.y + 18,
  );
}
function cropPointer(event) {
  if (!state.crop || state.mode !== "render") return;
  const c = state.selectionType === "clip" ? selected() : activeClip();
  if (!c) return;
  event.preventDefault();
  const rect = $("viewport").getBoundingClientRect(),
    r = videoRect(rect.width, rect.height),
    x = event.clientX - rect.left,
    y = event.clientY - rect.top,
    b = {
      x: r.x + c.crop.x * r.w,
      y: r.y + c.crop.y * r.h,
      w: c.crop.width * r.w,
      h: c.crop.height * r.h,
    };
  let corner = null;
  for (const [name, cx, cy] of [
    ["nw", b.x, b.y],
    ["ne", b.x + b.w, b.y],
    ["sw", b.x, b.y + b.h],
    ["se", b.x + b.w, b.y + b.h],
  ])
    if (Math.hypot(x - cx, y - cy) < 16) corner = name;
  if (!corner && (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h)) return;
  const original = copy(c.crop),
    sx = event.clientX,
    sy = event.clientY;
  let moved = false;
  const move = (e) => {
    if (!moved) {
      snapshot();
      moved = true;
    }
    const dx = (e.clientX - sx) / r.w,
      dy = (e.clientY - sy) / r.h;
    if (!corner) {
      c.crop.x = clamp(original.x + dx, 0, 1 - original.width);
      c.crop.y = clamp(original.y + dy, 0, 1 - original.height);
    } else {
      let left = original.x,
        top = original.y,
        right = left + original.width,
        bottom = top + original.height;
      if (corner.includes("w")) left = clamp(left + dx, 0, right - 0.03);
      else right = clamp(right + dx, left + 0.03, 1);
      if (corner.includes("n")) top = clamp(top + dy, 0, bottom - 0.03);
      else bottom = clamp(bottom + dy, top + 0.03, 1);
      c.crop = { x: left, y: top, width: right - left, height: bottom - top };
    }
    renderProperties();
    drawCrop();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    if (moved) changed();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}
async function cropAspect(ratio) {
  const c = selected();
  if (state.selectionType !== "clip" || !c || ratio === "free") return;
  try {
    const info = await metadata(c.source),
      [rw, rh] = ratio.split(":").map(Number),
      normalized = rw / rh / (info.width / info.height);
    let width = 1,
      height = 1;
    if (normalized < 1) width = normalized;
    else height = 1 / normalized;
    snapshot();
    c.crop = { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
    state.crop = true;
    $("crop-toggle").classList.add("active");
    setMode("render");
    changed(true);
  } catch (e) {
    fail(e);
  }
}
async function splitClip() {
  if (state.selectionType !== "clip") {
    const c = activeClip();
    if (c) select(c.id, "clip");
    else {
      toast("Select a video clip and place the playhead inside it.", true);
      return;
    }
  }
  const c = selected();
  try {
    const data = await api("split", {
      method: "POST",
      body: JSON.stringify({ clip: c, time: state.time }),
    });
    snapshot();
    const i = state.project.clips.indexOf(c);
    state.project.clips.splice(i, 1, ...data.clips);
    state.selection = data.clips[1].id;
    changed(true);
    toast("Clip split. Both segments keep their source, speed and crop.");
  } catch (e) {
    fail(e);
  }
}
async function addMedia(item) {
  try {
    const info = await metadata(item.source);
    snapshot();
    const start = state.project.clips.length
      ? Math.max(...state.project.clips.map((c) => c.start + clipDuration(c)))
      : 0;
    const c = {
      id: uid("clip"),
      name: item.name || "Rendered scene",
      source: item.source,
      start,
      in_point: 0,
      out_point: info.duration,
      speed: 1,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    };
    state.project.clips.push(c);
    state.selection = c.id;
    state.selectionType = "clip";
    state.time = start;
    changed(true);
    activateInspector("properties");
    setMode("render");
    toast("Footage added to the video track.");
  } catch (e) {
    fail(e);
  }
}
function modal(title, body) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = body;
  if (!$("modal").open) $("modal").showModal();
}
function closeModal() {
  $("modal").close();
}
function download(name, content, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function showHealth() {
  try {
    const h = await api("health");
    modal(
      "Your local render engine",
      `<p>Animathema runs with Python ${esc(h.python)}. Dependencies are checked in the environment that launched the studio.</p>` +
        h.dependencies
          .map(
            (d) =>
              `<div class="dependency ${d.available ? "" : "missing"}"><strong>${esc(d.name)}</strong><span>${d.available ? "Available ✓" : "Setup needed"}</span>${d.available ? "" : `<p>${esc(d.hint)}</p>`}</div>`,
          )
          .join("") +
        '<p style="margin-top:15px">Text, geometry and the demo do not require LaTeX. Setup instructions are also in README.md.</p>',
    );
  } catch (e) {
    fail(e);
  }
}
async function updateHealth() {
  const h = await api("health"),
    missing = h.dependencies.filter((d) => !d.available),
    critical = missing.some((d) =>
      ["manim", "ffmpeg", "ffprobe"].includes(d.name),
    );
  $("system-status").innerHTML =
    `<span class="status-dot" style="background:${critical ? "#e7aa75" : "#92d7bf"}"></span> ${critical ? "Engine setup needed" : missing.length ? "Engine ready · TeX optional" : "Engine ready"}`;
}
function showProjectMenu() {
  modal(
    "Project files",
    '<p>Projects are saved in workspace/project.json. Download a JSON copy to keep multiple projects.</p><button class="menu-action" id="menu-download">↓ Download project JSON</button><button class="menu-action" id="menu-import">↑ Open a project JSON</button><button class="menu-action" id="menu-demo">◇ Load Taylor-series demo</button><button class="menu-action" id="menu-new">＋ New empty scene</button>',
  );
}
function replaceProject(project) {
  snapshot();
  state.project = project;
  state.selection = project.objects[0]?.id;
  state.selectionType = "object";
  state.time = 0;
  state.simulate = false;
  if (state.playing) togglePlay();
  state.mode = "stage";
  currentSource = null;
  video.removeAttribute("src");
  changed(true);
  activateInspector("properties");
  setMode("stage");
  closeModal();
}
async function showMedia() {
  try {
    const items = await api("media");
    modal(
      "Render library",
      items.length
        ? "<p>Footage stays in your local workspace. Add a source to the end of the video track.</p>" +
            items
              .map(
                (item, i) =>
                  `<div class="media-item"><span>${esc(item.source)}</span><button class="quiet-button" data-add-media="${i}">+ Add clip</button><a class="text-tool" href="${esc(item.url)}" download>↓</a></div>`,
              )
              .join("")
        : "<p>No footage yet. Create a fast draft or production render to build your library.</p>",
    );
    document.querySelectorAll("[data-add-media]").forEach(
      (b) =>
        (b.onclick = () => {
          addMedia(items[Number(b.dataset.addMedia)]);
          closeModal();
        }),
    );
  } catch (e) {
    fail(e);
  }
}
function showExport() {
  modal(
    "Export your sequence",
    `<p>${state.project.clips.length} video clip${state.project.clips.length === 1 ? "" : "s"} · Crops, trims and playback speed are applied to the final MP4. Gaps export as black, with source audio preserved.</p>${field("Resolution", '<select id="export-resolution"><option value="1920,1080">1920 × 1080 · Landscape</option><option value="1080,1920">1080 × 1920 · Vertical</option><option value="1080,1080">1080 × 1080 · Square</option><option value="1280,720">1280 × 720 · HD</option><option value="854,480">854 × 480 · Draft</option><option value="3840,2160">3840 × 2160 · UHD</option></select>')}${field("Frame rate", '<select id="export-fps"><option>30</option><option>60</option><option>24</option><option>15</option></select>')}<div class="modal-actions"><button id="export-cancel" class="quiet-button">Cancel</button><button id="export-submit" class="primary-button" ${state.project.clips.length ? "" : "disabled"}>Export MP4 ↗</button></div>${!state.project.clips.length ? '<p class="inspector-note">Render your scene first to create footage for the video track.</p>' : ""}`,
  );
}
async function renderProject(quality) {
  if (pendingJob || state.job) {
    toast("Wait for the active job or cancel it in the console.");
    $("console-drawer").hidden = false;
    return;
  }
  pendingJob = true;
  try {
    await saveProject(false);
    const job = await api("render", {
      method: "POST",
      body: JSON.stringify({ project: state.project, quality }),
    });
    startJob(job);
    $("footer-status").textContent =
      (quality === "draft" ? "Fast draft" : "Production render") +
      " is running locally…";
  } catch (e) {
    fail(e);
    if (/missing|Install|LaTeX/.test(e.message)) showHealth();
  } finally {
    pendingJob = false;
  }
}
function startJob(job) {
  state.job = job.id;
  window.CodeWorkspace?.setBusy(true);
  $("console-drawer").hidden = false;
  $("console-output").textContent = "Starting local process…";
  $("job-download").hidden = true;
  $("job-cancel").hidden = false;
  $("job-title").textContent =
    job.kind === "render" ? "Manim render" : "Sequence export";
  $("job-progress").value = 0;
  $("draft-render").disabled = true;
  $("production-render").disabled = true;
  pollJob(job.id);
}
async function pollJob(id) {
  try {
    const job = await api("jobs/" + id);
    $("job-status").textContent =
      job.status +
      (job.status === "running" && job.progress
        ? " · " + Math.round(job.progress) + "%"
        : "");
    $("job-progress").value = job.progress;
    $("console-output").textContent =
      job.logs.join("\n") || "Queued for the local render engine…";
    $("console-output").scrollTop = $("console-output").scrollHeight;
    $("console-count").textContent = job.logs.length;
    if (["completed", "failed", "cancelled"].includes(job.status)) {
      state.job = null;
      window.CodeWorkspace?.setBusy(false);
      $("job-cancel").hidden = true;
      $("draft-render").disabled = false;
      $("production-render").disabled = false;
      if (job.status === "completed") {
        if (job.kind === "render") {
          await addMedia(job.result);
          $("console-drawer").hidden = true;
          const count = state.project.clips.length;
          $("render-badge").hidden = false;
          $("render-badge").textContent = count;
          $("footer-status").textContent =
            "Render complete · footage is ready to edit.";
        } else {
          $("job-download").href = job.result.url;
          $("job-download").hidden = false;
          $("footer-status").textContent =
            "Export complete · your MP4 is ready.";
          toast("Your sequence is ready to download.");
        }
      } else if (job.status === "failed") {
        toast(
          "Job failed. The console contains the full error and setup details.",
          true,
        );
        $("footer-status").textContent = "Job failed · inspect the console.";
      }
      return;
    }
    setTimeout(() => pollJob(id), 700);
  } catch (e) {
    state.job = null;
    window.CodeWorkspace?.setBusy(false);
    $("draft-render").disabled = false;
    $("production-render").disabled = false;
    fail(e);
  }
}
async function submitExport() {
  const [width, height] = $("export-resolution").value.split(",").map(Number),
    fps = Number($("export-fps").value);
  if (state.job || pendingJob) {
    toast("An active render or export must finish first.", true);
    return;
  }
  pendingJob = true;
  try {
    const job = await api("export", {
      method: "POST",
      body: JSON.stringify({ project: state.project, width, height, fps }),
    });
    closeModal();
    startJob(job);
  } catch (e) {
    fail(e);
  } finally {
    pendingJob = false;
  }
}
function showHelp() {
  modal(
    "A few useful shortcuts",
    [
      ["Play / pause", "Space"],
      ["Save project", "Ctrl / ⌘ S"],
      ["Undo", "Ctrl / ⌘ Z"],
      ["Redo", "Ctrl / ⌘ Shift Z"],
      ["Split video at playhead", "S / Ctrl B"],
      ["Previous / next frame", "← / →"],
      ["Delete selection", "Delete"],
      ["Search presets", "/"],
      ["Show shortcuts", "?"],
    ]
      .map(
        ([label, key]) =>
          `<div class="shortcut-row"><span>${label}</span><kbd>${key}</kbd></div>`,
      )
      .join("") +
      '<p class="inspector-note">Hold Shift while moving an object to snap to half units. Hold Alt while dragging timeline blocks for free timing. The stage shows a schematic preview; render for final typography, geometry and camera motion.</p>',
  );
}
function renameProject() {
  modal(
    "Name your project",
    `<label class="field vertical">Project name<input id="rename-input" value="${esc(state.project.name)}" maxlength="120"></label><div class="modal-actions"><button id="rename-submit" class="primary-button">Save name</button></div>`,
  );
  $("rename-input").focus();
  $("rename-input").select();
}
function activateInspector(tab) {
  state.inspector = tab;
  document
    .querySelectorAll("[data-inspector]")
    .forEach((b) => b.classList.toggle("active", b.dataset.inspector === tab));
  $("properties").hidden = tab !== "properties";
  $("code-panel").hidden = tab !== "code";
  if (tab === "code") compile();
}
function editCode() {
  if (!$("code-editor").hidden) return;
  $("code-editor").value = state.code;
  $("code-editor").hidden = false;
  $("code-highlight").hidden = true;
  $("apply-code").hidden = false;
  $("code-warning").hidden = false;
  $("code-panel").classList.add("editing-code");
  $("code-editor").focus();
}
function closeCodeEditor() {
  $("code-editor").hidden = true;
  $("code-highlight").hidden = false;
  $("apply-code").hidden = true;
  $("code-panel").classList.remove("editing-code");
  highlightCode();
}
async function applyCode() {
  try {
    const code = $("code-editor").value;
    await api("compile", {
      method: "POST",
      body: JSON.stringify({ ...state.project, code_override: code }),
    });
    snapshot();
    state.project.code_override = code;
    state.code = code;
    closeCodeEditor();
    changed();
    toast("Manual Python is active. Render to run this code locally.");
  } catch (e) {
    fail(e);
  }
}
function toggleCrop() {
  if (state.selectionType !== "clip") {
    const c = activeClip() || state.project.clips[0];
    if (!c) {
      toast("Render a scene first to enable video cropping.");
      return;
    }
    select(c.id, "clip");
  }
  state.crop = !state.crop;
  $("crop-toggle").classList.toggle("active", state.crop);
  setMode("render");
  drawCrop();
}
function bindResize(id, css, initial, min, max, axis, reverse = false) {
  $(id).addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const style = getComputedStyle(document.documentElement);
    let value = parseFloat(style.getPropertyValue(css)) || initial;
    if (css === "--library")
      value = $("outliner-resizer").offsetTop - $("studio").offsetTop;
    const start = axis === "x" ? e.clientX : e.clientY;
    document.body.classList.add("resizing");
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    const move = (ev) => {
      const delta = (axis === "x" ? ev.clientX : ev.clientY) - start;
      const next = clamp(value + (reverse ? -delta : delta), min, max);
      document.documentElement.style.setProperty(css, next + "px");
      draw();
      renderTimeline();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  });
}
function bindEvents() {
  $("preset-search").oninput = renderLibrary;
  document.querySelectorAll("[data-library]").forEach(
    (b) =>
      (b.onclick = () => {
        state.library = b.dataset.library;
        document
          .querySelectorAll("[data-library]")
          .forEach((x) => x.classList.toggle("active", x === b));
        renderLibrary();
      }),
  );
  $("category-filters").onclick = (e) => {
    const b = e.target.closest("[data-category]");
    if (b) {
      state.category = b.dataset.category;
      renderLibrary();
    }
  };
  $("preset-cards").onclick = (e) => {
    const b = e.target.closest("[data-preset]");
    if (b)
      (b.dataset.type === "object" ? addObject : addAnimation)(
        b.dataset.preset,
      );
  };
  $("preset-cards").ondragstart = (e) => {
    const b = e.target.closest("[data-preset]");
    if (b)
      e.dataTransfer.setData(
        "application/animathema",
        JSON.stringify({ kind: b.dataset.preset, type: b.dataset.type }),
      );
  };
  for (const el of [$("viewport"), $("timeline-tracks")]) {
    el.ondragover = (e) => {
      e.preventDefault();
      if (el === $("viewport")) $("drop-hint").hidden = false;
    };
    el.ondragleave = (e) => {
      if (!el.contains(e.relatedTarget)) $("drop-hint").hidden = true;
    };
    el.ondrop = (e) => {
      e.preventDefault();
      $("drop-hint").hidden = true;
      try {
        const data = JSON.parse(
          e.dataTransfer.getData("application/animathema"),
        );
        if (data.type === "object") {
          addObject(
            data.kind,
            el === $("viewport") ? worldAt(e).map(round) : [0, 0, 0],
          );
        } else {
          const tr = e.target.closest("[data-track]"),
            rect = $("timeline-content").getBoundingClientRect();
          let targetId = null;
          if (el === $("viewport") && state.mode === "stage") {
            const vr = $("viewport").getBoundingClientRect(),
              x = e.clientX - vr.left,
              y = e.clientY - vr.top;
            targetId = [...state.project.objects].reverse().find((o) => {
              const b = hitBoxes.get(o.id);
              return (
                o.visible &&
                !o.locked &&
                b &&
                x >= b.x &&
                x <= b.x + b.w &&
                y >= b.y &&
                y <= b.y + b.h
              );
            })?.id;
          }
          addAnimation(
            data.kind,
            el === $("viewport")
              ? state.time
              : Math.max(0, (e.clientX - rect.left) / state.px),
            targetId,
            tr && tr.dataset.track !== "video"
              ? Number(tr.dataset.track)
              : null,
          );
        }
      } catch (error) {
        fail(error);
      }
    };
  }
  $("outliner").onclick = (e) => {
    const expand = e.target.closest("[data-expand]"),
      anim = e.target.closest("[data-outliner-animation]");
    if (expand) {
      const id = expand.dataset.expand;
      state.expanded.has(id)
        ? state.expanded.delete(id)
        : state.expanded.add(id);
      renderOutliner();
      return;
    }
    if (anim) {
      select(anim.dataset.outlinerAnimation, "animation");
      activateInspector("properties");
      return;
    }
    const visibility = e.target.closest("[data-visibility]"),
      lock = e.target.closest("[data-lock]");
    if (visibility || lock) {
      const o = state.project.objects.find(
        (x) => x.id === (visibility?.dataset.visibility || lock?.dataset.lock),
      );
      snapshot();
      if (visibility) o.visible = !o.visible;
      else o.locked = !o.locked;
      changed(true);
      return;
    }
    const row = e.target.closest("[data-object]");
    if (row) select(row.dataset.object);
  };
  $("outliner").ondragstart = (e) => {
    const row = e.target.closest("[data-object]");
    if (row)
      e.dataTransfer.setData(
        "application/animathema-layer",
        row.dataset.object,
      );
  };
  $("outliner").ondragover = (e) => e.preventDefault();
  $("outliner").ondrop = (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("application/animathema-layer"),
      to = e.target.closest("[data-object]")?.dataset.object;
    if (!id || !to || id === to) return;
    const o = state.project.objects.find((x) => x.id === id);
    if (!o || o.locked) return;
    snapshot();
    state.project.objects = state.project.objects.filter((x) => x.id !== id);
    const i = state.project.objects.findIndex((x) => x.id === to);
    state.project.objects.splice(i, 0, o);
    changed(true);
  };
  $("properties").onchange = (e) => {
    if (e.target.dataset.field) setProperty(e.target);
    else if (e.target.id === "quick-animation" && e.target.value)
      addAnimation(e.target.value);
    else if (e.target.id === "latex-template" && e.target.value) {
      snapshot();
      selected().params.text = state.catalog.latex[e.target.value];
      changed(true);
    } else if (e.target.id === "crop-aspect") cropAspect(e.target.value);
  };
  $("properties").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.selectAnimation)
      select(b.dataset.selectAnimation, "animation");
    if (b.id === "delete-selection") deleteSelection();
    if (b.id === "camera-move") addAnimation("MoveCamera");
    if (b.id === "camera-ambient") addAnimation("AmbientRotation");
    if (b.id === "duplicate-object") {
      const o = selected();
      if (!o || state.selectionType !== "object") return;
      snapshot();
      const n = {
        ...copy(o),
        id: uid("obj"),
        name: o.name + " copy",
        position: [o.position[0] + 0.4, o.position[1] - 0.4, o.position[2]],
        locked: false,
      };
      state.project.objects.push(n);
      state.selection = n.id;
      changed(true);
    }
    if (b.id === "layer-up") layer(1);
    if (b.id === "layer-down") layer(-1);
    if (b.id === "property-split") splitClip();
    if (b.id === "show-crop") {
      state.crop = false;
      toggleCrop();
    }
    if (b.id === "reset-crop") {
      snapshot();
      selected().crop = { x: 0, y: 0, width: 1, height: 1 };
      changed(true);
    }
  };
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  document
    .querySelectorAll("[data-inspector]")
    .forEach((b) => (b.onclick = () => activateInspector(b.dataset.inspector)));
  $("stage").onpointerdown = stagePointer;
  $("overlay").onpointerdown = cropPointer;
  $("viewport").addEventListener(
    "wheel",
    (e) => {
      if (state.mode !== "stage") return;
      if (window.StageViewport) { window.StageViewport.zoom(e); return; }
      e.preventDefault();
      state.zoom = clamp(state.zoom * (e.deltaY > 0 ? 0.93 : 1.07), 0.4, 2.5);
      draw();
    },
    { passive: false },
  );
  $("grid-toggle").onclick = () => {
    state.grid = !state.grid;
    $("grid-toggle").classList.toggle("active", state.grid);
    draw();
  };
  $("safe-toggle").onclick = () => {
    state.safe = !state.safe;
    $("safe-toggle").classList.toggle("active", state.safe);
    draw();
  };
  $("view-3d").onclick = () => {
    if (window.StageViewport) { window.StageViewport.setDimension(!state.is3d); return; }
    state.is3d = !state.is3d;
    $("view-3d").textContent = state.is3d ? "3D" : "2D";
    $("view-3d").classList.toggle("active", state.is3d);
    $("viewport-caption").textContent = state.is3d
      ? "PERSPECTIVE / 3D"
      : "PERSPECTIVE / FRONT";
    draw();
  };
  $("fit-view").onclick = () => {
    if (window.StageViewport) { window.StageViewport.preset("reset"); return; }
    state.zoom = 1;
    state.simulate = false;
    draw();
  };
  $("select-tool").onclick = () => {
    state.crop = false;
    $("crop-toggle").classList.remove("active");
    setMode("stage");
  };
  $("crop-toggle").onclick = toggleCrop;
  $("timeline-tracks").onpointerdown = startBlockDrag;
  $("ruler").onpointerdown = (e) => {
    e.preventDefault();
    const move = (ev) => {
      const rect = $("timeline-content").getBoundingClientRect();
      seek((ev.clientX - rect.left) / state.px);
      state.simulate = true;
      draw();
    };
    move(e);
    const up = () => window.removeEventListener("pointermove", move);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };
  $("timeline-tracks").ondblclick = (e) => {
    if (!e.target.closest("[data-block]")) {
      const rect = $("timeline-content").getBoundingClientRect();
      seek((e.clientX - rect.left) / state.px);
    }
  };
  $("play").onclick = togglePlay;
  $("jump-start").onclick = () => seek(0);
  $("jump-end").onclick = () => seek(totalDuration());
  $("step-back").onclick = () => seek(state.time - 1 / state.project.fps);
  $("step-forward").onclick = () => seek(state.time + 1 / state.project.fps);
  $("timeline-zoom").oninput = (e) => {
    state.px = Number(e.target.value);
    renderTimeline();
  };
  $("zoom-in").onclick = () => {
    state.px = clamp(state.px + 15, 30, 180);
    $("timeline-zoom").value = state.px;
    renderTimeline();
  };
  $("zoom-out").onclick = () => {
    state.px = clamp(state.px - 15, 30, 180);
    $("timeline-zoom").value = state.px;
    renderTimeline();
  };
  $("split-clip").onclick = splitClip;
  $("add-wait").onclick = () => addAnimation("Wait");
  $("add-text").onclick = () => addObject("Text");
  $("draft-render").onclick = () => renderProject("draft");
  $("production-render").onclick = () => renderProject("production");
  $("empty-render").onclick = () => renderProject("draft");
  $("export-open").onclick = showExport;
  $("system-status").onclick = showHealth;
  $("select-camera").onclick = () => {
    select("camera", "camera");
    activateInspector("properties");
  };
  $("media-open").onclick = showMedia;
  $("console-toggle").onclick = () =>
    ($("console-drawer").hidden = !$("console-drawer").hidden);
  $("console-close").onclick = () => ($("console-drawer").hidden = true);
  $("job-cancel").onclick = async () => {
    if (state.job)
      try {
        await api("jobs/" + state.job, { method: "DELETE" });
      } catch (e) {
        fail(e);
      }
  };
  $("save-project").onclick = () => saveProject();
  $("undo").onclick = () => undo();
  $("redo").onclick = () => undo(true);
  $("project-menu").onclick = showProjectMenu;
  $("project-name").onclick = renameProject;
  $("help-open").onclick = showHelp;
  $("modal-close").onclick = closeModal;
  $("modal").onclick = (e) => {
    if (e.target === $("modal")) {
      const r = $("modal").getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        closeModal();
    }
  };
  $("modal-body").onclick = async (e) => {
    const id = e.target.closest("button")?.id;
    try {
      if (id === "export-submit") submitExport();
      if (id === "export-cancel") closeModal();
      if (id === "rename-submit") {
        const name = $("rename-input").value.trim();
        if (name) {
          snapshot();
          state.project.name = name;
          changed(true);
          closeModal();
        }
      }
      if (id === "menu-download") {
        download(
          state.project.name + ".json",
          JSON.stringify(state.project, null, 2),
          "application/json",
        );
        closeModal();
      }
      if (id === "menu-import") {
        $("project-file").click();
      }
      if (id === "menu-demo") replaceProject(await api("demo"));
      if (id === "menu-new")
        replaceProject({
          version: 1,
          name: "Untitled scene",
          background: "#10131d",
          duration: 12,
          fps: 30,
          objects: [],
          animations: [],
          clips: [],
          code_override: null,
        });
    } catch (error) {
      fail(error);
    }
  };
  $("project-file").onchange = async (e) => {
    try {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2e6) throw Error("Project files must be under 2 MB.");
      const project = JSON.parse(await file.text());
      const result = await api("compile", {
        method: "POST",
        body: JSON.stringify(project),
      });
      if (result.code) replaceProject(result.project);
    } catch (error) {
      fail(error);
    } finally {
      e.target.value = "";
    }
  };
  $("edit-code").onclick = editCode;
  $("apply-code").onclick = applyCode;
  $("reset-code").onclick = () => {
    snapshot();
    state.project.code_override = null;
    closeCodeEditor();
    changed();
    toast("Python will now follow the visual scene.");
  };
  $("download-code").onclick = () => download("scene.py", state.code);
  $("code-editor").onkeydown = (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.target,
        a = el.selectionStart,
        b = el.selectionEnd;
      el.setRangeText("    ", a, b, "end");
    }
  };
  document.addEventListener("keydown", (e) => {
    const editing =
      ["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement.tagName,
      ) || document.activeElement.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProject();
      return;
    }
    if (editing || $("modal").open) return;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo(e.shiftKey);
      return;
    }
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      splitClip();
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      seek(state.time - 1 / state.project.fps);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      seek(state.time + 1 / state.project.fps);
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelection();
    }
    if (e.key.toLowerCase() === "s" && !mod) splitClip();
    if (e.key === "/") {
      e.preventDefault();
      $("preset-search").focus();
    }
    if (e.key === "?") showHelp();
  });
  bindResize("left-resizer", "--left", 246, 145, 420, "x");
  bindResize("right-resizer", "--right", 282, 215, 520, "x", true);
  bindResize("timeline-resizer", "--timeline", 272, 210, 480, "y", true);
  bindResize("outliner-resizer", "--library", 280, 185, 650, "y");
  new ResizeObserver(() => {
    draw();
    renderTimeline();
  }).observe($("viewport"));
  window.addEventListener("beforeunload", (e) => {
    if (state.job || state.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}
async function init() {
  try {
    [state.project, state.catalog] = await Promise.all([
      api("project"),
      api("presets"),
    ]);
    state.project.camera ??= { phi: 0, theta: -90, zoom: 1, auto_3d: true };
    window.StageViewport?.attach({ state, draw, changed, snapshot, queueCompile, renderProperties, mathExpression });
    window.StudioPanes?.init({ refresh: () => { draw(); renderTimeline(); } });
    state.selection =
      state.project.objects.find((o) => o.kind === "FunctionGraph")?.id ||
      state.project.objects[0]?.id;
    $("project-name").innerHTML = esc(state.project.name) + " <span>⌄</span>";
    $("scene-label").textContent = state.project.name;
    bindEvents();
    renderLibrary();
    renderOutliner();
    renderProperties();
    renderTimeline();
    updateHistory();
    draw();
    await compile();
    await updateHealth();
    for (const c of state.project.clips) metadata(c.source).catch(() => {});
    if (state.project.clips.length) {
      $("render-badge").hidden = false;
      $("render-badge").textContent = state.project.clips.length;
    }
  } catch (e) {
    console.error(e);
    const error = document.createElement("div");
    error.className = "loading-error";
    error.innerHTML =
      "<h2>The studio could not open.</h2><p>" +
      esc(e.message) +
      "</p><p>Start the app with <code>python main.py</code>, then reload this page. Check the terminal if the saved project needs attention.</p>";
    document.body.append(error);
  }
}
// An additive bridge lets the dedicated code workspace use the existing job,
// console and media workflow without changing the visual editor's state model.
window.AnimathemaStudio = {
  getProject: () => state.project,
  getCode: () => state.code,
  isBusy: () => pendingJob || Boolean(state.job),
  beginCodeRequest: () => {
    if (pendingJob || state.job) return false;
    pendingJob = true;
    return true;
  },
  endCodeRequest: () => { pendingJob = false; },
  startJob,
  toast,
  pause: () => { if (state.playing) togglePlay(); else video.pause(); },
};
init();
