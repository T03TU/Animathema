# Animathema

A local visual studio for **mathematics in motion**. Compose Manim scenes, sequence animations, render footage, and edit an MP4 without a frontend build or a hosted service.

## Run

Use Python 3.11 or newer. From this directory:

```bash
python -m venv .venv
# Linux / macOS
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python main.py
```

On systems where Python is named `python3`, use that name to create the environment. In this checkout an environment is already prepared; launch directly with `.venv/bin/python main.py` on Linux/macOS.

The launcher opens **http://127.0.0.1:8000** in your browser. Stop it with Ctrl+C. Use `python main.py --no-browser --port 8001` for a different port or to suppress the browser. The application binds to loopback only. Use `--workspace /path/to/project-data` to choose a separate project and media directory.

### System dependencies

Manim needs Cairo, Pango, and FFmpeg. Install these before installing Python requirements. For example:

- **Ubuntu/Debian:** `sudo apt install build-essential python3-dev pkg-config libcairo2-dev libpango1.0-dev ffmpeg`
- **macOS (Homebrew):** `brew install cairo pango pkg-config ffmpeg`
- **Windows:** install Python and FFmpeg, add FFmpeg's `bin` directory to PATH, then follow Manim's platform installation guide if a native dependency is missing.

**LaTeX is optional for the included demo, Text, geometry, and plots.** MathTex and Matrix require a TeX distribution with `latex` and `dvisvgm` on PATH. Install TeX Live or MiKTeX; on Ubuntu, `texlive-latex-extra texlive-fonts-recommended texlive-science dvisvgm` supplies common packages. Restart the app after changing PATH. The engine status button shows dependency checks and actionable guidance.

Primary references: [Manim installation](https://docs.manim.community/en/stable/installation.html), [Manim render settings](https://docs.manim.community/en/stable/guides/configuration.html), [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html).

## Studio workflow

1. **Compose.** The preloaded “A little closer to sine” project compares sine with first- and third-order Taylor approximations. Search or filter the preset shelf. Click a card or drag it onto the stage. Select objects through the canvas or scene collection. Drag to position; hold Shift to snap to half units. Edit position, scale, color, expressions, text, and geometry on the right. Outliner visibility, locks, drag ordering, and layer buttons control composition.
2. **Animate.** Switch the shelf to Animations. Select a Mobject and click or drop a transition onto the stage or timeline. For transforms and paths, choose the target in Properties. Drag blocks to change start time or pull their edges to change duration. Properties also expose easing, timing, tracks, and rotation angle. Independent objects can animate concurrently; competing animations on the same object are rejected with an explanation. Wait blocks extend the scene. Click Camera in the outliner footer to edit angles, zoom, and automatic 3D framing. Expand object rows to select their animations. Camera blocks rotate the 3D camera; scenes containing ThreeDAxes or Surface start with an oblique camera.
3. **Render.** Fast draft uses Manim `-ql` (480p15); Production uses `-qh` (1080p60). Jobs run asynchronously, with console output, progress, cancellation, and isolated output directories. Successful renders are automatically added to the video track. Earlier renders are available in the Render library, including after a restart.
4. **Edit.** Select a video block, scrub the ruler, and split at the playhead with **S** or **Ctrl+B**. Set a speed between 0.25× and 4×. Drag clip edges in Trim mode or choose Rate stretch. Trim cannot extend past source bounds. Crop in Properties or use the monitor's crop frame; drag a corner to resize or drag inside to move. Aspect presets offer landscape, portrait, and square framing. Crop values use normalized source coordinates, independent of output resolution.
5. **Export.** Choose output resolution and frame rate. FFmpeg applies cuts, speed, and crops; scales footage to fit the output; preserves and retimes source audio; fills timeline gaps with black/silence; and concatenates the clips into H.264/AAC MP4. Clips on the video track must not overlap. The completed job offers a download.

The **Code** tab shows syntax-highlighted standalone Python. Download it as `scene.py`, or edit and apply a manual override defining `AnimathemaScene`. Reset the override to resume visual code generation. Manual code executes as local Python when rendering, so only run code you trust. Visual state remains stored alongside the override; arbitrary Python is not reverse-parsed into objects.

## Collapsible panes & focus mode

Use the small chevrons in pane headers to collapse the library/scene sidebar, properties/code inspector, viewport, or timeline. Side panes become narrow restore rails; the timeline keeps its playback toolbar available. Click the rail or chevron to expand a pane again. At least one main pane stays open, so every layout remains usable.

The preset library and scene collection can also fold individually, giving their vertical space to the other section. Click a Properties section heading to fold its controls; values and selections are preserved, including when selecting another object.

**⛶ Focus** in the workspace bar hides surrounding panes and expands the viewport. Click **Exit focus** to restore the preceding layout. **↺ Expand all panes** reopens every pane and inspector section. The `/` search shortcut reveals the preset library when necessary.

Collapse and fold preferences are remembered in this browser, independently of project JSON. Existing resize widths survive collapse/restore during the session; layouts also work on narrow screens. Hidden panes retain their contents, code drafts, and running render jobs.

## 2D/3D stage navigation

The dimension toggle controls the stage grid, object projection, axis gizmo, available coordinates, and generated Manim camera together.

- **2D:** flat XY orthographic view, with coral X and green Y axes. Z controls and Z gizmo endpoints are hidden; stored object depth is preserved for switching back. Rotation is locked to `phi=0°`, `theta=-90°`. Middle/right drag pans, and the wheel zooms.
- **3D:** perspective projection through a Manim-compatible spherical camera, with an XY ground grid, X/Y/Z axes, and depth-sorted geometry. Middle drag or Alt+left drag orbits. Left drag on empty canvas also orbits. Shift+middle drag or right drag pans. The wheel changes zoom. Dragging an object moves it in the camera's view plane; Shift snaps to half units.
- **Navigation gizmo:** the top-right indicator shows +X/+Y in 2D and all six positive/negative endpoints in 3D. Click an endpoint to smoothly align to an orthographic axis view. Endpoint hit areas remain separate even when projected axes overlap.
- **View presets:** choose Top, Front, Side, or Isometric 3D, or click Reset View. While the viewport has keyboard focus, Numpad 1/3/7 select Front/Side/Top and Home resets the view. The HUD shows live Manim `phi`, `theta`, and zoom.
- **Camera persistence:** navigation is saved with the project and participates in undo/redo. Generated visual source uses the saved dimension, angles, zoom, projection, and orbit target. Standard Axes become ThreeDAxes in 3D; NumberPlane remains an XY grid. In 2D, coordinate axes and depth coordinates render flat. World geometry is centered on the saved orbit target while fixed overlays remain in screen space. Existing projects without dimension metadata keep their legacy automatic-camera behavior until a dimension/navigation choice is saved.
- **Fixed overlays:** select an object and enable Properties → Viewport overlay → Fixed in frame. The stage pins it to screen coordinates and the compiler registers it with `add_fixed_in_frame_mobjects`. The demo's title and subtitle are pinned. Cube and Sphere presets are also available on the Geometry shelf.

Camera changes update generated visual code. A manually authored Python override remains independent and is rendered exactly as written.

## Code workspace & direct rendering

Click **</> Code** beside Stage preview and Render monitor to open the full-size Python editor. It includes line numbers, live Python highlighting, Tab/Shift+Tab indentation, Copy Code, and Download .py, with no CDN or build dependencies.

- **Synced with Visual Scene:** visual object, property, and animation changes automatically update the source. This source is compiled from the visual graph even if the original right-hand inspector has a separate legacy override.
- **Custom Code Override:** typing or pasting freezes automatic updates to this editor. Your custom draft and selected scene are retained in this browser across mode switches and reloads. Download .py to keep a portable file; the draft is separate from project JSON and from the original inspector's `AnimathemaScene` override.
- **Reset to Visual Scene:** replaces this editor's draft with freshly generated visual code. It does not remove objects, animations, clips, or the original inspector's override.
- **Scene selection:** valid Python is inspected with `ast`, without importing or executing it, to discover scene classes. Direct Manim bases, imported aliases, qualified bases such as `mn.Scene`, and local subclasses populate the dropdown. Dynamic class factories are not statically detected. The installed Manim version determines which scene types are available; legacy types such as GraphScene may require updating the pasted code.
- **Render Code · Draft / Production:** renders the exact current source and selected class through the existing async job and console workflow. When no Manim import is present, the execution script adds `from manim import *`, after any module docstring and future imports. Syntax diagnostics refer to the editor's original lines and columns. Runtime errors appear in the existing console with tracebacks.

Successful renders open in the Render monitor and are added to the existing video track. Splitting, speed changes, trimming, cropping, and export work identically for these clips. Timestamped source and footage are stored under `workspace/custom_renders/`, and appear in the Render library. Rendering executes Python on your machine with the same privileges as the application; static validation checks syntax and scene names, not the safety of arbitrary code.

The existing endpoints and right-hand Code inspector remain available. New API endpoints are:

| Endpoint | Request / result |
| --- | --- |
| `POST /api/code/analyze` | `{ "code": "..." }` → scene names, execution source, and whether a Manim import was added |
| `POST /api/compile/visual` | Existing project JSON → generated source, ignoring the legacy override without modifying it |
| `POST /api/render/code` | `{ "code": "...", "scene_name": "MyScene", "quality": "low" }` → HTTP 202 and an existing-format render job |

`scene_name` is optional and defaults to the first detected class. Quality accepts `low` (480p15, default) or `high` (1080p60). Poll `GET /api/jobs/{id}` for logs/status; a completed job's `result` includes `url`, `source`, `scene_name`, and `script` paths. Syntax failures return HTTP 400 with a readable `detail` and a `diagnostic` containing one-based `line` and `column`, end positions, and source text.

## Preview scope

The canvas is an interactive **layout and motion preview** using Manim's camera rotation and perspective convention. Text, LaTeX, curves, paths, animation interpolation, and tessellated 3D geometry remain approximations. Use a Manim render for exact typography, complex transforms, animated camera moves, and production geometry. The monitor plays source footage at the clip speed, with a crop overlay; the crop and final output framing are applied during export. A single video track is supported, with gaps and sequential clips, rather than compositing overlapping footage.

Three visual animation lanes are provided; their labels organize blocks and do not change Manim's absolute timing. Same-object animations must run sequentially, even on different lanes. ReplacementTransform updates subsequent references to the replacement object. An AmbientRotation block rotates the camera by its configured angle over its configured duration; it does not continue beyond the block.

## Project files

- Changes auto-save to `workspace/project.json`; Ctrl+S saves immediately.
- Use the **⋯** project menu to download/open JSON, reload the demo, or start an empty project. Loading a project replaces the active scene; undo can restore it.
- Renders, generated Python, and exports stay under `workspace/renders/` and `workspace/exports/`. These are intentionally excluded from version control. Keep the referenced media alongside a project JSON when moving it to another checkout.
- Undo/redo keeps the last 60 editing steps during the current browser session. Jobs and logs are held for the current server session; their output media persists.
- Backend scene validation, restricted mathematical expressions, same-origin mutation checks, and workspace-scoped media paths protect normal visual editing. The application is intended for one trusted local user, with one active editing tab.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Play/pause | Space |
| Save | Ctrl/⌘ S |
| Undo / redo | Ctrl/⌘ Z / Ctrl/⌘ Shift Z |
| Split selected video | S or Ctrl/⌘ B |
| Step one frame | Left / Right |
| Delete selection | Delete / Backspace |
| Search presets | / |
| Shortcut help | ? |

## Development & verification

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
node --check frontend/app.js  # optional syntax check; Node is not needed to run the app
```

The regression suite checks project validation, every preset's generated syntax, expression restrictions, timeline conflict handling, split/retime math, crop bounds, media confinement, API behavior, and cross-origin protection. Additional integration checks render the actual demo and export split, retimed, cropped footage with a gap. Browser verification covers the studio and editing controls using installed Chrome.

```text
main.py                     Python launcher, local server, browser opening
backend/models.py           Validated project, object, animation, clip schemas
backend/presets.py          Preset catalog, LaTeX templates, demo scene
backend/scene_compiler.py   JSON → standalone Manim Python
backend/render_engine.py    Async jobs, subprocesses, diagnostics, cancellation
backend/video_editor.py     FFprobe metadata, split logic, FFmpeg export
backend/app.py              FastAPI routes, persistence, static UI
frontend/                   HTML, CSS, vanilla JavaScript studio
workspace/                  Local projects, scripts, videos, exports
```

`python -m tests.verify_media` verifies real rendering, exact object appearance timing, editing, audio retiming, export, and camera animation in an isolated temporary workspace. `python -m tests.verify_browser` launches an isolated server with a disposable temporary workspace and verifies the interactive browser workflow without touching your active project. It uses installed Chrome, `ANIMATHEMA_CHROME`, or Playwright Chromium (`python -m playwright install chromium`). Screenshots are written to your system temporary directory.

`python -m tests.verify_code_workspace` uses an isolated server/workspace to verify visual synchronization, protection and persistence of custom drafts, scene selection, syntax diagnostics, clipboard/download, real draft and production code renders, runtime failures, and the existing NLE export pipeline. It leaves your active project untouched.

`python -m tests.verify_dimensions` verifies 2D/3D indicators, orbit/pan/zoom gestures, all six axis snaps, camera presets, 3D object dragging, preserved depth, saved camera state, and the projection matrix against Manim. It also renders a real 3D scene and checks that the fixed HUD stays pinned. All work uses a disposable temporary workspace.

`python -m tests.verify_panes` checks actual space reclamation, restoring/persisting layouts, nested pane and Properties folding, keyboard activation, focus and timeline-only layouts, resize preservation, code drafts, 3D navigation, and narrow-screen layouts in an isolated browser workspace.
