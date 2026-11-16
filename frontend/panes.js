/* Collapsing panes changes layout only: scene, selection, drafts and jobs stay intact. */
"use strict";
(() => {
  const storageKey = "animathema.panes.v1";
  const main = ["left", "viewport", "inspector", "timeline"];
  const names = {
    left: "library and scene sidebar",
    viewport: "viewport",
    inspector: "properties and code inspector",
    timeline: "timeline",
  };
  const sections = { library: "preset library", outliner: "scene collection" };
  let state = {
    collapsed: {},
    sections: {},
    properties: {},
    focusReturn: null,
  };
  let hooks, studio, observer, refreshFrame;

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* Layout controls also work when browser storage is disabled. */
    }
  }
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (!saved || typeof saved !== "object") return;
      for (const key of main)
        state.collapsed[key] = saved.collapsed?.[key] === true;
      for (const key of Object.keys(sections))
        state.sections[key] = saved.sections?.[key] === true;
      if (
        saved.properties &&
        typeof saved.properties === "object" &&
        !Array.isArray(saved.properties)
      ) {
        for (const [key, value] of Object.entries(saved.properties).slice(
          0,
          80,
        )) {
          if (value === true) state.properties[key] = true;
        }
      }
      if (saved.focusReturn && typeof saved.focusReturn === "object") {
        state.focusReturn = Object.fromEntries(
          main.map((key) => [key, saved.focusReturn[key] === true]),
        );
      }
      if (main.every((key) => state.collapsed[key]))
        state.collapsed.viewport = false;
    } catch {
      /* Invalid layout preferences never prevent the studio from opening. */
    }
  }
  function refresh() {
    cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(() => hooks.refresh());
  }
  function apply() {
    const expanded = main.filter((key) => !state.collapsed[key]);
    for (const key of main) {
      const collapsed = !!state.collapsed[key],
        pane = document.getElementById("pane-" + key);
      pane.classList.toggle("pane-is-collapsed", collapsed);
      studio.classList.toggle("is-" + key + "-collapsed", collapsed);
      document.body.classList.toggle("layout-" + key + "-collapsed", collapsed);
      const rail = pane.querySelector(":scope > .pane-restore");
      if (rail) rail.hidden = !collapsed;
      for (const button of document.querySelectorAll(
        `[data-pane-toggle="${key}"]`,
      )) {
        const last = !collapsed && expanded.length === 1;
        button.disabled = last;
        button.setAttribute("aria-expanded", String(!collapsed));
        button.setAttribute(
          "aria-label",
          `${collapsed ? "Expand" : "Collapse"} ${names[key]}`,
        );
        button.title = last
          ? "Keep one pane open. Expand another pane to collapse this one."
          : `${collapsed ? "Expand" : "Collapse"} ${names[key]}`;
        if (button.classList.contains("pane-collapse"))
          button.textContent =
            key === "timeline"
              ? collapsed
                ? "⌃"
                : "⌄"
              : key === "inspector"
                ? "›"
                : "‹";
      }
    }
    for (const [key, label] of Object.entries(sections)) {
      const collapsed = !!state.sections[key],
        pane = document.getElementById("pane-" + key);
      pane.classList.toggle("section-is-collapsed", collapsed);
      studio.classList.toggle("is-" + key + "-collapsed", collapsed);
      const button = document.querySelector(`[data-pane-section="${key}"]`);
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute(
        "aria-label",
        `${collapsed ? "Expand" : "Collapse"} ${label}`,
      );
      button.title = `${collapsed ? "Expand" : "Collapse"} ${label}`;
      button.textContent = collapsed ? "⌄" : "⌃";
    }
    const focus = document.getElementById("pane-focus");
    focus.setAttribute("aria-pressed", String(state.focusReturn !== null));
    focus.title = state.focusReturn
      ? "Restore the layout before focus mode"
      : "Focus viewport; collapse surrounding panes";
    focus.querySelector("span").textContent = state.focusReturn
      ? "Exit focus"
      : "Focus";
    for (const [id, disabled] of [
      ["left-resizer", state.collapsed.left || state.collapsed.viewport],
      ["right-resizer", state.collapsed.inspector || state.collapsed.viewport],
      ["timeline-resizer", state.collapsed.timeline],
      ["outliner-resizer", state.sections.library || state.sections.outliner],
    ])
      document
        .getElementById(id)
        .setAttribute("aria-disabled", String(!!disabled));
    decorateProperties();
    persist();
    refresh();
  }
  function setCollapsed(key, collapsed) {
    if (!main.includes(key)) return;
    if (
      collapsed &&
      main.every((other) => other === key || state.collapsed[other])
    )
      return;
    state.focusReturn = null;
    state.collapsed[key] = collapsed;
    apply();
    if (collapsed)
      document
        .querySelector(
          `#pane-${key} > .pane-restore, #pane-${key} [data-pane-toggle="${key}"]`,
        )
        ?.focus({ preventScroll: true });
    else
      document
        .querySelector(`#pane-${key} .pane-collapse[data-pane-toggle="${key}"]`)
        ?.focus({ preventScroll: true });
  }
  function focusViewport() {
    if (state.focusReturn) {
      state.collapsed = { ...state.focusReturn };
      state.focusReturn = null;
    } else {
      state.focusReturn = { ...state.collapsed };
      state.collapsed = {
        left: true,
        inspector: true,
        timeline: true,
        viewport: false,
      };
    }
    apply();
  }
  function expandAll() {
    state = { collapsed: {}, sections: {}, properties: {}, focusReturn: null };
    apply();
  }
  function decorateProperties() {
    for (const section of document.querySelectorAll(
      "#properties .prop-section",
    )) {
      const heading = section.querySelector(":scope > h3");
      if (!heading) continue;
      let button = heading.querySelector("[data-property-fold]");
      if (!button) {
        const title = heading.childNodes[0]?.textContent.trim() || "Properties";
        button = document.createElement("button");
        button.type = "button";
        button.className = "property-section-toggle";
        button.dataset.propertyFold = title;
        const label = document.createElement("span");
        label.className = "property-section-label";
        label.textContent = title;
        button.append(label, document.createElement("span"));
        heading.replaceChildren(button);
      }
      const collapsed = state.properties[button.dataset.propertyFold] === true;
      section.classList.toggle("property-is-collapsed", collapsed);
      button.setAttribute("aria-expanded", String(!collapsed));
      button.title = `${collapsed ? "Expand" : "Collapse"} ${button.dataset.propertyFold}`;
      button.lastElementChild.textContent = collapsed ? "›" : "⌄";
    }
  }
  function init(options) {
    if (hooks) return;
    hooks = options;
    studio = document.getElementById("studio");
    load();
    document.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-pane-toggle]");
      const sub = event.target.closest("[data-pane-section]");
      const fold = event.target.closest("[data-property-fold]");
      if (toggle)
        setCollapsed(
          toggle.dataset.paneToggle,
          !state.collapsed[toggle.dataset.paneToggle],
        );
      else if (sub) {
        state.sections[sub.dataset.paneSection] =
          !state.sections[sub.dataset.paneSection];
        apply();
      } else if (fold) {
        state.properties[fold.dataset.propertyFold] =
          !state.properties[fold.dataset.propertyFold];
        decorateProperties();
        persist();
      } else if (event.target.closest("[data-pane-focus]")) focusViewport();
      else if (event.target.closest("[data-pane-expand-all]")) expandAll();
    });
    document.addEventListener(
      "keydown",
      (event) => {
        // The studio's existing Space shortcut controls playback. Layout buttons
        // keep normal keyboard activation without also starting the transport.
        if (
          event.code === "Space" &&
          event.target.closest(
            "[data-pane-toggle], [data-pane-section], [data-property-fold], [data-pane-focus], [data-pane-expand-all]",
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.target.closest("button").click();
        }
        if (
          event.key === "/" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) &&
          !event.target.isContentEditable &&
          !document.getElementById("modal").open
        ) {
          state.collapsed.left = false;
          state.sections.library = false;
          state.focusReturn = null;
          apply();
        }
      },
      true,
    );
    observer = new MutationObserver(() => {
      // Only new/rebuilt inspector sections need decoration. Attribute changes
      // are deliberately not observed, avoiding feedback on fold/unfold.
      if (
        document.querySelector(
          "#properties .prop-section h3:not(:has([data-property-fold]))",
        )
      )
        decorateProperties();
    });
    observer.observe(document.getElementById("properties"), {
      childList: true,
      subtree: true,
    });
    apply();
  }
  window.StudioPanes = { init };
})();
