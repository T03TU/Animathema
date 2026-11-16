/* Manim-compatible camera projection, spatial preview and local viewport navigation. */
"use strict";
((root) => {
  const DEG = Math.PI / 180;
  const colors = { X: "#ee8c91", Y: "#76cda7", Z: "#829ff5" };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const mul = (a, n) => a.map((v) => v * n);
  const normalizeTheta = (n) => ((((n + 180) % 360) + 360) % 360) - 180;
  const spatialKinds = new Set(["ThreeDAxes", "Surface", "Cube", "Sphere"]);
  let hooks,
    frame,
    hits,
    primitives = [],
    pickPrimitives = [],
    snapFrame = 0,
    wheelTimer;

  // Matches ThreeDCamera.generate_rotation_matrix: Rx(-phi) Rz(-theta - 90°).
  function rotation(phi, theta) {
    const a = (-theta - 90) * DEG,
      p = phi * DEG;
    const c = Math.cos(a),
      s = Math.sin(a),
      cp = Math.cos(p),
      sp = Math.sin(p);
    return [
      [c, -s, 0],
      [cp * s, cp * c, sp],
      [-sp * s, -sp * c, cp],
    ];
  }
  const rotate = (point, matrix) => matrix.map((row) => dot(row, point));
  const inverse = (point, matrix) =>
    [0, 1, 2].map((i) => point.reduce((n, v, j) => n + v * matrix[j][i], 0));
  function cameraState() {
    const c = hooks.state.project.camera;
    const auto =
      c.dimension == null &&
      c.auto_3d &&
      hooks.state.project.objects.some(
        (o) => o.visible && spatialKinds.has(o.kind),
      );
    const depth = hooks.state.project.objects.some(
      (o) => o.visible && o.position[2] !== 0,
    );
    const dimension =
      c.dimension ||
      (auto || c.phi !== 0 || c.theta !== -90 || depth ? "3D" : "2D");
    return {
      dimension,
      phi: dimension === "2D" ? 0 : auto ? 65 : c.phi,
      theta: dimension === "2D" ? -90 : auto ? -45 : c.theta,
      zoom: c.zoom ?? 1,
      center: [...(c.frame_center || [0, 0, 0])],
      projection:
        dimension === "2D" ? "orthographic" : c.projection || "perspective",
      distance: c.focal_distance || 20,
    };
  }
  function sync() {
    if (!hooks?.state.project) return;
    const c = cameraState(),
      three = c.dimension === "3D";
    hooks.state.is3d = three;
    hooks.state.zoom = c.zoom;
    document.querySelector(".studio").classList.toggle("dimension-3d", three);
    const viewport = document.getElementById("viewport");
    viewport.dataset.dimension = c.dimension;
    viewport.dataset.projection = c.projection;
    document.getElementById("view-3d").textContent = c.dimension;
    document.getElementById("view-3d").classList.toggle("active", three);
    document
      .getElementById("view-3d")
      .setAttribute("aria-pressed", String(three));
    document.getElementById("view-preset").value = "";
    if (hooks.state.mode === "stage") {
      document.getElementById("viewport-caption").textContent = three
        ? `${c.projection.toUpperCase()} / 3D`
        : "ORTHOGRAPHIC / XY";
      document.getElementById("viewport-help").textContent = three
        ? "MMB / Alt+drag orbit · Shift+MMB / RMB pan · Wheel zoom"
        : "Drag objects · MMB / RMB pan · Wheel zoom";
    }
    const hud = document.getElementById("camera-hud");
    hud.textContent = `φ ${c.phi.toFixed(1)}°  θ ${c.theta.toFixed(1)}°  Zoom ${c.zoom.toFixed(2)}×`;
    hud.hidden = hooks.state.mode !== "stage";
    document.getElementById("axis-gizmo").hidden = hooks.state.mode !== "stage";
    drawGizmo(c);
  }
  function projectWorld(point, c, f, fixed = false) {
    const unit = f.baseUnit ?? f.h / 8;
    if (fixed)
      return [
        f.x + f.w / 2 + point[0] * unit,
        f.y + f.h / 2 - point[1] * unit,
        0,
      ];
    const center =
      c.dimension === "2D" ? [c.center[0], c.center[1], 0] : c.center;
    const world = c.dimension === "2D" ? [point[0], point[1], 0] : point;
    const q = rotate(
      world.map((n, i) => n - center[i]),
      rotation(c.phi, c.theta),
    );
    if (c.projection === "perspective" && q[2] > c.distance - 0.1) return null;
    const factor =
      c.projection === "perspective" ? c.distance / (c.distance - q[2]) : 1;
    return [
      f.x + f.w / 2 + q[0] * unit * c.zoom * factor,
      f.y + f.h / 2 - q[1] * unit * c.zoom * factor,
      q[2],
    ];
  }
  function project(x, y, z = 0, fixed = false) {
    return (
      projectWorld([x, y, z], cameraState(), frame, fixed) || [
        NaN,
        NaN,
        -Infinity,
      ]
    );
  }
  function screenDelta(dx, dy, origin, fixed = false) {
    const c = cameraState(),
      r = rotation(c.phi, c.theta);
    const depth = fixed
      ? 0
      : rotate(
          origin.map((n, i) => n - c.center[i]),
          r,
        )[2];
    const factor =
      !fixed && c.projection === "perspective"
        ? c.distance / (c.distance - depth)
        : 1;
    const unit = frame.baseUnit * (fixed ? 1 : c.zoom) * factor;
    return fixed || c.dimension === "2D"
      ? [dx / unit, -dy / unit, 0]
      : inverse([dx / unit, -dy / unit, 0], r);
  }
  function worldAt(event) {
    const rect = document.getElementById("viewport").getBoundingClientRect(),
      c = cameraState();
    const sx =
      (event.clientX - rect.left - frame.x - frame.w / 2) /
      (frame.baseUnit * c.zoom);
    const sy =
      -(event.clientY - rect.top - frame.y - frame.h / 2) /
      (frame.baseUnit * c.zoom);
    if (c.dimension === "2D") return [sx + c.center[0], sy + c.center[1], 0];
    const r = rotation(c.phi, c.theta);
    const origin = add(
      c.center,
      inverse(
        c.projection === "perspective" ? [0, 0, c.distance] : [sx, sy, 0],
        r,
      ),
    );
    const direction = inverse(
      c.projection === "perspective" ? [sx, sy, -c.distance] : [0, 0, -1],
      r,
    );
    if (Math.abs(direction[2]) < 0.00001)
      return add(c.center, inverse([sx, sy, 0], r));
    const t = -origin[2] / direction[2];
    if (c.projection === "perspective" && t < 0)
      return add(c.center, inverse([sx, sy, 0], r));
    return add(origin, mul(direction, t));
  }

  function segment(ctx, a, b, color, width = 1) {
    if (!a || !b || ![...a, ...b].every(Number.isFinite)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  function grid(ctx) {
    const c = cameraState(),
      three = c.dimension === "3D";
    if (hooks.state.grid) {
      for (let n = -10; n <= 10; n++) {
        segment(
          ctx,
          project(n, -10, 0),
          project(n, 10, 0),
          n % 5 === 0 ? "#a299bd19" : "#a299bd0b",
        );
        segment(
          ctx,
          project(-10, n, 0),
          project(10, n, 0),
          n % 5 === 0 ? "#a299bd19" : "#a299bd0b",
        );
      }
    }
    const axes = three ? [0, 1, 2] : [0, 1];
    axes.forEach((axis) => {
      const a = [0, 0, 0],
        b = [0, 0, 0];
      a[axis] = -6;
      b[axis] = 6;
      const name = "XYZ"[axis],
        color = colors[name];
      segment(ctx, project(...a), project(0, 0, 0), color + "44");
      segment(ctx, project(0, 0, 0), project(...b), color + "99", 1.2);
      const end = project(...b);
      if (end && end.every(Number.isFinite)) {
        ctx.font = "9px ui-monospace,monospace";
        ctx.fillStyle = color;
        ctx.fillText(name, end[0] + 5, end[1] - 5);
      }
      for (let n = -5; n <= 5; n++) {
        if (!n) continue;
        const tick = [0, 0, 0];
        tick[axis] = n;
        const p = project(...tick);
        if (!p.every(Number.isFinite)) continue;
        segment(ctx, [p[0] - 2, p[1] + 2], [p[0] + 2, p[1] - 2], color + "66");
      }
    });
  }
  function drawGizmo(c) {
    const svg = document.getElementById("gizmo-lines"),
      is3d = c.dimension === "3D";
    const r = rotation(c.phi, c.theta),
      endpoints = [];
    svg.replaceChildren();
    for (const axis of ["X", "Y", "Z"])
      for (const sign of [1, -1]) {
        const button = document.querySelector(
          `[data-view-axis="${sign > 0 ? "+" : "-"}${axis}"]`,
        );
        button.hidden = !is3d && (axis === "Z" || sign < 0);
        if (button.hidden) continue;
        const v = [0, 0, 0];
        v["XYZ".indexOf(axis)] = sign;
        const q = rotate(v, r);
        endpoints.push({
          button,
          axis,
          q,
          x: 45 + q[0] * 28,
          y: 45 - q[1] * 28,
        });
      }
    // Label hit areas must remain distinct when axes line up in projection.
    // Keep front endpoints exact and move rear labels only as far as needed.
    const placed = [];
    endpoints.sort((a, b) => b.q[2] - a.q[2]);
    for (const endpoint of endpoints) {
      let { x, y } = endpoint;
      const free = (px, py) =>
        placed.every((p) => Math.hypot(px - p[0], py - p[1]) >= 23);
      if (!free(x, y)) {
        search: for (let radius = 2; radius <= 70; radius += 2)
          for (let step = 0; step < 24; step++) {
            const angle = (step * Math.PI) / 12,
              px = x + Math.cos(angle) * radius,
              py = y + Math.sin(angle) * radius;
            if (px >= 10 && px <= 80 && py >= 10 && py <= 80 && free(px, py)) {
              x = px;
              y = py;
              break search;
            }
          }
      }
      placed.push([x, y]);
      const { button, axis, q } = endpoint;
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      button.style.setProperty("--axis-color", colors[axis]);
      button.style.zIndex = String(10 + Math.round(q[2] * 5));
      button.classList.toggle("rear", q[2] < -0.05);
      const line = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "line",
      );
      for (const [k, value] of Object.entries({
        x1: 45,
        y1: 45,
        x2: x,
        y2: y,
        stroke: colors[axis],
        opacity: q[2] < 0 ? 0.28 : 0.7,
      }))
        line.setAttribute(k, value);
      svg.append(line);
    }
    document
      .getElementById("axis-gizmo")
      .setAttribute(
        "aria-label",
        is3d ? "3D camera orientation; click an axis to align" : "2D XY axes",
      );
  }

  function appearance(o) {
    const state = hooks.state;
    let opacity = o.opacity,
      progress = 1,
      angle = 0,
      position = [...o.position];
    if (state.simulate) {
      for (const a of state.project.animations
        .filter((a) => a.object_id === o.id)
        .sort((a, b) => a.start - b.start)) {
        const t = clamp((state.time - a.start) / a.duration, 0, 1);
        if (["Create", "Write"].includes(a.kind)) progress *= t;
        if (a.kind === "FadeIn") opacity *= t;
        if (a.kind === "FadeOut") opacity *= 1 - t;
        if (a.kind === "Rotate") angle += t * a.angle * DEG;
        if (a.kind === "Indicate" && t > 0 && t < 1)
          opacity *= 0.6 + 0.4 * Math.sin(t * Math.PI);
        if (
          ["Transform", "ReplacementTransform", "MoveAlongPath"].includes(
            a.kind,
          )
        ) {
          const target = state.project.objects.find(
            (x) => x.id === a.target_id,
          );
          if (target)
            position = position.map((v, i) => v + (target.position[i] - v) * t);
        }
      }
    }
    return { opacity, progress, angle, position };
  }
  function buildObject(ctx, o, layer) {
    const p = o.params,
      s = o.scale,
      k = o.kind,
      a = appearance(o),
      fixed = !!o.fixed_in_frame;
    if (a.opacity <= 0 || a.progress <= 0) return;
    const c = cameraState(),
      ca = Math.cos(a.angle),
      sa = Math.sin(a.angle);
    function local(v) {
      return add(a.position, [
        s * (v[0] * ca - v[1] * sa),
        s * (v[0] * sa + v[1] * ca),
        s * (v[2] || 0),
      ]);
    }
    function emit(points, options = {}) {
      const world = points.map(local),
        projected = world.map((v) => projectWorld(v, c, frame, fixed));
      if (projected.some((v) => !v)) return;
      primitives.push({
        points: projected,
        world,
        depth: fixed
          ? Infinity
          : projected.reduce((n, v) => n + v[2], 0) / projected.length,
        id: o.id,
        layer,
        fixed,
        color: o.color,
        opacity: a.opacity,
        width: Math.max(0.65, (o.stroke_width * frame.baseUnit) / 55),
        ...options,
      });
    }
    const path = (points, options = {}) =>
      emit(
        points.slice(0, Math.max(2, Math.ceil(points.length * a.progress))),
        options,
      );
    const evalAt = (expr, vars) => hooks.mathExpression(expr, vars);
    const circle = (radius, z = 0, count = 64) =>
      Array.from({ length: count + 1 }, (_, i) => [
        radius * Math.cos((i / count) * 2 * Math.PI),
        radius * Math.sin((i / count) * 2 * Math.PI),
        z,
      ]);
    function text(value, center, size = 20, mono = false) {
      const fontSize = size / 48;
      ctx.font = `${fontSize}px ${mono ? "Georgia,serif" : '"Segoe UI",sans-serif'}`;
      const w = Math.max(0.01, ctx.measureText(String(value)).width),
        h = fontSize * 1.2;
      emit(
        [
          [center[0] - w / 2, center[1] - h / 2, center[2] || 0],
          [center[0] + w / 2, center[1] - h / 2, center[2] || 0],
          [center[0] + w / 2, center[1] + h / 2, center[2] || 0],
          [center[0] - w / 2, center[1] + h / 2, center[2] || 0],
        ],
        {
          text: String(value),
          center: projectWorld(local(center), c, frame, fixed),
          right: projectWorld(local(add(center, [1, 0, 0])), c, frame, fixed),
          up: projectWorld(local(add(center, [0, 1, 0])), c, frame, fixed),
          fontSize,
          mono,
          opacity: a.opacity * a.progress,
        },
      );
    }
    if (["Text", "Title", "MathTex"].includes(k)) {
      const value = String(p.text || "Mathematics").replace(
        /\\(sum|int|infty|to)/g,
        (_, n) => ({ sum: "Σ", int: "∫", infty: "∞", to: "→" })[n],
      );
      text(value, [0, 0, 0], Number(p.font_size || 32), k === "MathTex");
    } else if (["Axes", "ThreeDAxes", "NumberPlane"].includes(k)) {
      if (k === "NumberPlane")
        for (let n = -6; n <= 6; n++) {
          path(
            [
              [n, -3, 0],
              [n, 3, 0],
            ],
            { opacity: a.opacity * 0.2 },
          );
          if (Math.abs(n) <= 3)
            path(
              [
                [-6, n, 0],
                [6, n, 0],
              ],
              { opacity: a.opacity * 0.2 },
            );
        }
      const axes =
        c.dimension === "3D" && k !== "NumberPlane" ? [0, 1, 2] : [0, 1];
      for (const axis of axes) {
        const end = axis === 0 ? 6 : 3,
          v1 = [0, 0, 0],
          v2 = [0, 0, 0];
        v1[axis] = -end;
        v2[axis] = end;
        path([v1, v2], { color: colors["XYZ"[axis]] });
        for (let n = -end + 1; n < end; n++) {
          const t1 = [0, 0, 0],
            t2 = [0, 0, 0];
          t1[axis] = t2[axis] = n;
          t1[(axis + 1) % 3] = -0.045;
          t2[(axis + 1) % 3] = 0.045;
          path([t1, t2], { color: colors["XYZ"[axis]] });
        }
      }
    } else if (k === "Circle" || k === "Dot") {
      path(circle(Number(p.radius ?? (k === "Dot" ? 0.08 : 1))), {
        fill: k === "Dot",
      });
    } else if (k === "Square" || k === "Polygon") {
      const n = k === "Square" ? 4 : Number(p.sides || 3),
        r =
          k === "Square"
            ? Number(p.side_length || 2) / Math.SQRT2
            : Number(p.radius || 1.3);
      path(
        Array.from({ length: n + 1 }, (_, i) => {
          const t =
            (i / n) * 2 * Math.PI +
            (k === "Square" ? Math.PI / 4 : -Math.PI / 2);
          return [r * Math.cos(t), r * Math.sin(t), 0];
        }),
      );
    } else if (k === "Line" || k === "Vector") {
      const end = [Number(p.x ?? 2), Number(p.y ?? 1), Number(p.z ?? 0)];
      path([[0, 0, 0], end], { arrow: k === "Vector" });
    } else if (k === "FunctionGraph" || k === "ParametricFunction") {
      const min = Number(
          k === "FunctionGraph" ? (p.x_min ?? -5) : (p.t_min ?? 0),
        ),
        max = Number(
          k === "FunctionGraph" ? (p.x_max ?? 5) : (p.t_max ?? 6.283),
        );
      let points = [];
      for (let i = 0; i <= 240; i++) {
        const v = min + ((max - min) * i) / 240;
        let xyz;
        if (k === "FunctionGraph")
          xyz = [v, evalAt(p.expression || "sin(x)", { x: v }), 0];
        else
          xyz = ["x", "y", "z"].map((axis) =>
            evalAt(
              p[axis + "_expression"] ||
                { x: "2*cos(t)", y: "2*sin(t)", z: "0" }[axis],
              { t: v },
            ),
          );
        if (xyz.every((v) => Number.isFinite(v) && Math.abs(v) < 1000))
          points.push(xyz);
        else {
          if (points.length > 1) path(points);
          points = [];
        }
      }
      if (points.length > 1) path(points);
    } else if (k === "Surface" || k === "Sphere" || k === "Cube") {
      if (k === "Cube") {
        const r = Number(p.side_length || 2) / 2;
        for (const axis of [0, 1, 2])
          for (const sign of [-1, 1]) {
            const face = [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1],
            ].map(([x, y]) => {
              const v = [0, 0, 0];
              v[axis] = sign * r;
              v[(axis + 1) % 3] = x * r;
              v[(axis + 2) % 3] = y * r;
              return v;
            });
            emit(face, {
              fill: true,
              opacity: a.opacity * a.progress,
              face: true,
            });
          }
      } else {
        const nu = k === "Sphere" ? 24 : 22,
          nv = k === "Sphere" ? 14 : 22;
        const u0 = k === "Sphere" ? 0 : Number(p.u_min ?? -3),
          u1 = k === "Sphere" ? 2 * Math.PI : Number(p.u_max ?? 3);
        const v0 = k === "Sphere" ? 0 : Number(p.v_min ?? -3),
          v1 = k === "Sphere" ? Math.PI : Number(p.v_max ?? 3);
        const r = Number(p.radius || 1);
        const point = (i, j) => {
          const u = u0 + ((u1 - u0) * i) / nu,
            v = v0 + ((v1 - v0) * j) / nv;
          return k === "Sphere"
            ? [
                r * Math.cos(u) * Math.sin(v),
                r * Math.sin(u) * Math.sin(v),
                r * Math.cos(v),
              ]
            : [u, v, evalAt(p.expression || "sin(u)*cos(v)", { u, v })];
        };
        for (let i = 0; i < nu; i++)
          for (let j = 0; j < nv; j++)
            emit(
              [
                point(i, j),
                point(i + 1, j),
                point(i + 1, j + 1),
                point(i, j + 1),
              ],
              {
                fill: true,
                face: true,
                opacity: a.opacity * a.progress,
                width: 0.35,
              },
            );
      }
    } else if (k === "VectorField") {
      for (let x = -5; x <= 5; x++)
        for (let y = -3; y <= 3; y++) {
          const dx = evalAt(p.x_expression || "-y/3", { x, y }),
            dy = evalAt(p.y_expression || "x/3", { x, y });
          const len = Math.hypot(dx, dy) || 1;
          path(
            [
              [x, y, 0],
              [x + (dx / len) * 0.45, y + (dy / len) * 0.45, 0],
            ],
            { arrow: true, width: 1 },
          );
        }
    } else if (k === "Brace") {
      const w = Number(p.width || 3);
      path([
        [-w / 2, 0, 0],
        [-w / 2, -0.15, 0],
        [-0.15, -0.15, 0],
        [0, -0.3, 0],
        [0.15, -0.15, 0],
        [w / 2, -0.15, 0],
        [w / 2, 0, 0],
      ]);
    } else if (k === "Matrix" || k === "Table") {
      const values =
          typeof p.values === "string"
            ? JSON.parse(p.values)
            : p.values || [
                [1, 0],
                [0, 1],
              ],
        cell = 0.7,
        w = values[0].length * cell,
        h = values.length * cell;
      values.forEach((row, j) =>
        row.forEach((v, i) => {
          const x = i * cell - w / 2,
            y = h / 2 - j * cell;
          text(v, [x + cell / 2, y - cell / 2, 0], 20, true);
          if (k === "Table")
            path([
              [x, y, 0],
              [x + cell, y, 0],
              [x + cell, y - cell, 0],
              [x, y - cell, 0],
              [x, y, 0],
            ]);
        }),
      );
      if (k === "Matrix")
        for (const sign of [-1, 1])
          path([
            [sign * (w / 2 + 0.15), -h / 2, 0],
            [sign * (w / 2 + 0.15), h / 2, 0],
          ]);
    }
  }
  function paintPrimitive(ctx, p) {
    const pts = p.points;
    ctx.save();
    ctx.globalAlpha = p.opacity;
    ctx.strokeStyle = p.color;
    ctx.fillStyle = p.color;
    ctx.lineWidth = p.width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (p.face && p.world.length >= 3) {
      const a = p.world[1].map((v, i) => v - p.world[0][i]),
        b = p.world[2].map((v, i) => v - p.world[0][i]);
      const normal = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
      const intensity =
        0.58 +
        (0.42 * Math.abs(dot(normal, [-0.45, -0.58, 0.68]))) /
          (Math.hypot(...normal) || 1);
      const rgb = [1, 3, 5].map((i) =>
        Math.round(parseInt(p.color.slice(i, i + 2), 16) * intensity),
      );
      ctx.fillStyle = ctx.strokeStyle = `rgb(${rgb.join(",")})`;
    }
    if (p.text && p.center && p.right && p.up) {
      ctx.transform(
        p.right[0] - p.center[0],
        p.right[1] - p.center[1],
        p.center[0] - p.up[0],
        p.center[1] - p.up[1],
        p.center[0],
        p.center[1],
      );
      ctx.font = `${p.fontSize}px ${p.mono ? "Georgia,serif" : '"Segoe UI",sans-serif'}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(p.text, 0, 0);
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      pts.slice(1).forEach((v) => ctx.lineTo(v[0], v[1]));
      if (p.fill) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();
      if (p.arrow && pts.length > 1) {
        const a = pts.at(-2),
          b = pts.at(-1),
          t = Math.atan2(b[1] - a[1], b[0] - a[0]);
        segment(
          ctx,
          b,
          [b[0] - 7 * Math.cos(t - 0.4), b[1] - 7 * Math.sin(t - 0.4)],
          p.color,
          p.width,
        );
        segment(
          ctx,
          b,
          [b[0] - 7 * Math.cos(t + 0.4), b[1] - 7 * Math.sin(t + 0.4)],
          p.color,
          p.width,
        );
      }
    }
    ctx.restore();
    const xs = pts.map((v) => v[0]),
      ys = pts.map((v) => v[1]);
    const x = Math.min(...xs),
      y = Math.min(...ys),
      right = Math.max(...xs),
      bottom = Math.max(...ys),
      old = hits.get(p.id);
    hits.set(
      p.id,
      old
        ? {
            x: Math.min(old.x, x),
            y: Math.min(old.y, y),
            w: Math.max(old.x + old.w, right) - Math.min(old.x, x),
            h: Math.max(old.y + old.h, bottom) - Math.min(old.y, y),
          }
        : { x, y, w: right - x, h: bottom - y },
    );
    pickPrimitives.push(p);
  }
  function drawSpatial(ctx) {
    primitives = [];
    pickPrimitives = [];
    hooks.state.project.objects.forEach((o, i) => {
      if (!o.visible) return;
      try {
        buildObject(ctx, o, i);
      } catch {
        const p = project(...o.position);
        ctx.font = "10px sans-serif";
        ctx.fillStyle = "#d99bad";
        ctx.fillText(o.kind + " · check expression", p[0], p[1]);
      }
    });
    primitives.sort((a, b) =>
      a.fixed !== b.fixed
        ? a.fixed
          ? 1
          : -1
        : a.depth - b.depth || a.layer - b.layer,
    );
    primitives.forEach((p) => paintPrimitive(ctx, p));
  }
  function drawObject(ctx, o) {
    primitives = [];
    buildObject(ctx, o, hooks.state.project.objects.indexOf(o));
    primitives.forEach((p) => paintPrimitive(ctx, p));
  }
  function hitTest(x, y) {
    if (
      x < frame.x ||
      x > frame.x + frame.w ||
      y < frame.y ||
      y > frame.y + frame.h
    )
      return null;
    const distance = (p, a, b) => {
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        len = dx * dx + dy * dy,
        t = len
          ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len, 0, 1)
          : 0;
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    for (let i = pickPrimitives.length - 1; i >= 0; i--) {
      const p = pickPrimitives[i],
        o = hooks.state.project.objects.find((o) => o.id === p.id);
      if (!o || o.locked) continue;
      const points = p.points;
      let inside = false;
      if (p.fill || p.text)
        for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
          const q = points[a],
            r = points[b];
          if (
            q[1] > y !== r[1] > y &&
            x < ((r[0] - q[0]) * (y - q[1])) / (r[1] - q[1]) + q[0]
          )
            inside = !inside;
        }
      if (
        inside ||
        points.slice(1).some((b, j) => distance([x, y], points[j], b) < 6)
      )
        return o;
    }
    return null;
  }

  function writeCamera(values) {
    const c = hooks.state.project.camera,
      current = cameraState();
    Object.assign(
      c,
      {
        dimension: current.dimension,
        phi: current.phi,
        theta: current.theta,
        zoom: current.zoom,
        frame_center: current.center,
        projection: current.projection,
        auto_3d: false,
      },
      values,
    );
  }
  function redraw() {
    hooks.draw();
    if (hooks.state.selectionType === "camera") hooks.renderProperties();
    hooks.queueCompile();
  }
  function setDimension(three) {
    cancelAnimationFrame(snapFrame);
    hooks.snapshot();
    const current = cameraState();
    writeCamera(
      three
        ? { dimension: "3D", phi: 65, theta: -45, projection: "perspective" }
        : {
            dimension: "2D",
            phi: 0,
            theta: -90,
            projection: "orthographic",
            frame_center: [current.center[0], current.center[1], 0],
          },
    );
    hooks.changed(true);
  }
  function preset(name, animated = true) {
    if (name === "reset") {
      cancelAnimationFrame(snapFrame);
      hooks.snapshot();
      writeCamera({
        phi: hooks.state.is3d ? 65 : 0,
        theta: hooks.state.is3d ? -45 : -90,
        zoom: 1,
        frame_center: [0, 0, 0],
        projection: hooks.state.is3d ? "perspective" : "orthographic",
      });
      hooks.state.simulate = false;
      hooks.changed(true);
      return;
    }
    const views = {
      top: [0, -90],
      front: [90, -90],
      side: [90, 0],
      iso: [65, -45],
      "+X": [90, 0],
      "-X": [90, 180],
      "+Y": [90, 90],
      "-Y": [90, -90],
      "+Z": [0, -90],
      "-Z": [180, -90],
    };
    if (!views[name]) return;
    if (!hooks.state.is3d && ["+X", "+Y"].includes(name)) return;
    const current = cameraState(),
      [phi, theta] = views[name],
      dimension =
        !hooks.state.is3d && (name === "top" || name === "+Z") ? "2D" : "3D";
    hooks.snapshot();
    cancelAnimationFrame(snapFrame);
    const start = performance.now(),
      dtheta = normalizeTheta(theta - current.theta),
      duration = animated ? 230 : 0;
    function step(now) {
      const t = duration ? clamp((now - start) / duration, 0, 1) : 1,
        e = t * t * (3 - 2 * t);
      writeCamera({
        dimension,
        phi: current.phi + (phi - current.phi) * e,
        theta: normalizeTheta(current.theta + dtheta * e),
        projection: name === "iso" ? "perspective" : "orthographic",
      });
      hooks.draw();
      if (t < 1) snapFrame = requestAnimationFrame(step);
      else hooks.changed(true);
    }
    snapFrame = requestAnimationFrame(step);
  }
  function navigate(event) {
    if (hooks.state.mode !== "stage") return false;
    const rect = document.getElementById("viewport").getBoundingClientRect();
    const hit = hooks.state.is3d
      ? hitTest(event.clientX - rect.left, event.clientY - rect.top)
      : null;
    const middle = event.button === 1,
      right = event.button === 2,
      alt = event.altKey && event.button === 0;
    const empty = event.button === 0 && hooks.state.is3d && !hit;
    if (!middle && !right && !alt && !empty) return false;
    event.preventDefault();
    cancelAnimationFrame(snapFrame);
    document.getElementById("viewport").focus({ preventScroll: true });
    const pan = !hooks.state.is3d || right || event.shiftKey;
    const original = cameraState(),
      sx = event.clientX,
      sy = event.clientY;
    let moved = false;
    const move = (e) => {
      const dx = e.clientX - sx,
        dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      if (!moved) {
        hooks.snapshot();
        moved = true;
      }
      if (pan) {
        const delta = inverse(
          [
            -dx / (frame.baseUnit * original.zoom),
            dy / (frame.baseUnit * original.zoom),
            0,
          ],
          rotation(original.phi, original.theta),
        );
        writeCamera({ frame_center: add(original.center, delta) });
      } else
        writeCamera({
          phi: clamp(original.phi + dy * 0.35, 0.2, 179.8),
          theta: normalizeTheta(original.theta - dx * 0.4),
          projection: "perspective",
        });
      redraw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (moved) hooks.changed(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return true;
  }
  function zoom(event) {
    if (hooks.state.mode !== "stage") return;
    event.preventDefault();
    cancelAnimationFrame(snapFrame);
    if (!wheelTimer) hooks.snapshot();
    const c = cameraState();
    writeCamera({
      zoom: clamp(
        c.zoom * Math.exp(-clamp(event.deltaY, -200, 200) * 0.0015),
        0.1,
        5,
      ),
    });
    redraw();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      hooks.changed(true);
    }, 180);
  }
  function attach(options) {
    hooks = options;
    document.getElementById("view-preset").onchange = (e) =>
      preset(e.target.value);
    document.getElementById("axis-gizmo").onclick = (e) => {
      const axis = e.target.closest("[data-view-axis]");
      if (axis) preset(axis.dataset.viewAxis);
    };
    const viewport = document.getElementById("viewport");
    viewport.addEventListener("contextmenu", (e) => {
      if (hooks.state.mode === "stage") e.preventDefault();
    });
    viewport.addEventListener("auxclick", (e) => {
      if (hooks.state.mode === "stage") e.preventDefault();
    });
    viewport.addEventListener("keydown", (e) => {
      const views = {
        Numpad1: "front",
        Numpad3: "side",
        Numpad7: "top",
        Home: "reset",
      };
      if (views[e.code] && e.target === viewport) {
        e.preventDefault();
        preset(views[e.code]);
      }
    });
    sync();
  }
  root.StageViewport = {
    attach,
    sync,
    cameraState,
    project,
    worldAt,
    screenDelta,
    grid,
    drawSpatial,
    drawObject,
    hitTest,
    navigate,
    zoom,
    setDimension,
    preset,
    begin: (f, h) => {
      frame = f;
      hits = h;
      pickPrimitives = [];
      primitives = [];
      sync();
    },
    math: { rotation, rotate, inverse, projectWorld },
  };
})(globalThis);
