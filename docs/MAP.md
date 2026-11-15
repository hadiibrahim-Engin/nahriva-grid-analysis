# Network map (from Figma)

The dashboard colours the operator's own network map with the results of one scenario at one time: branches
(lines, transformers) by loading, busbars by voltage, switched-off equipment dashed. The map is drawn in Figma and
exported as SVG; the dashboard never contacts Figma.

```mermaid
flowchart LR
  fig[Figma network map<br/>one layer per equipment] -->|Export SVG,<br/>Include id attribute| svg["maps/&lt;name&gt;.svg<br/>next to the results database"]
  svg --> match[GET /maps/&lt;name&gt;/match<br/>layer id ↔ element of the analysis]
  db[(results database)] --> match
  match --> view[Network at a time → map]
  vals[GET /maps/&lt;name&gt;/values<br/>numbers at time t, compact] --> view
  db --> vals
```

## Drawing the map in Figma

1. Put every piece of equipment into a group named **`Elements`**. Each layer in it is one element: a line is
   a path, a transformer a group (for example two circles and its connections), a busbar a rectangle or thick line.
2. Name each layer like the PowerFactory element: its name (`Line 01 - 02`), or, when the same name exists in
   several grids, the grid and the name (`Area West Line 01 - 02`), or its full path. Case, spaces and punctuation
   do not matter (`Line_01_-_02` matches `Line 01 - 02`).
3. Everything else (background, labels, generators, legends) stays outside `Elements`; it is drawn but not
   coloured. Keep labels outside the equipment layers, otherwise they are coloured too.
4. Export the frame as **SVG** with **Include id attribute** and save it as `maps/<name>.svg` in the folder of the
   results database (or in the folder named by `OA_MAP_DIR`). Several maps are offered in a list.

What is coloured: in every equipment layer each stroke, and each fill that is not white or transparent. The
colours follow the loading bands of the dashboard (Limits dialog) and the voltage band of the run.

## In the dashboard

The map is optional and hidden by default: the button **Network map** in the section **Network at a time** shows
or hides it, and the browser remembers the choice. While it is hidden nothing of it is loaded (no code, no SVG,
no values), so the dashboard is exactly as fast as without a map.

Choose a scenario and a time (critical times or the time course). The map shows that time; hover shows name, grid, nominal voltage, value, change against REF and state; a click opens the
element in the **Asset** view. Wheel or +/− zooms, dragging moves, **Fit** resets. Below the map the dashboard lists
layers without an element, names that exist in several grids, repeated layer names (Figma appends `_2`) and
elements of the analysis that have no layer.

## Speed

Measured with a synthetic map of 20,000 equipment layers (10,000 branches, 10,000 busbars, 1.9 MB SVG, about
60,000 SVG nodes) in headless Chromium on an Apple M5, server on the same machine:

| Step | Time |
|---|---|
| Map visible after opening the section (SVG, match, values, drawing, colours) | 0.92 s |
| Next time (values of 20,000 elements + recolouring) | 0.19 s |
| Zoom (wheel, 40 steps) and hover | no frame over 25 ms, no long task |
| Move (drag) | no frame over 25 ms while moving; one frame of 40–50 ms when grabbing (the browser finds the element under the pointer) |

How: the drawing is inserted once per map; a new time changes only the colours of shapes collected once; zoom and
move change one `translate3d` transform per frame on a compositor layer, without React rendering, and the browser
redraws it sharp after a zoom off the main thread. The server matches layers once per map file and analysis (cache),
and sends the values of a time as compact columns in the order of the matched elements (550 kB raw for 20,000
elements, a few kB compressed) instead of one object per element. Before these changes the same map took 4.5 s to
appear and stalled 90–120 ms at the start and end of every zoom or move.

Controls: wheel or trackpad pinch zooms around the pointer, drag moves, double-click zooms in (Shift: out),
two-finger pinch on touch screens, +/− around the centre, **Fit** resets.

## Safety

The SVG is checked before use: a file with a DOCTYPE or entity declarations is refused (Figma writes none), the
browser removes scripts, embedded documents, event handlers and links out of the file before showing it, and the
server sends the raw file only with a policy that forbids scripts.

## Example

`scripts/try_example.sh` builds the IEEE 39-bus transmission system (39 busbars, 34 lines, 12 transformers;
topology public, loadings and planned outages synthetic) through the real import path, writes its map in the
Figma export format to `backend/data/ieee39-example/maps/ieee39.svg` and opens the dashboard. Drag that SVG into
Figma to see the expected layer structure, change it, and export it back.

## Limits

- The map is static: positions come from the drawing, not from PowerFactory.
- Measured up to 20,000 equipment layers (see Speed). Far larger maps should be split per grid or voltage level.
- Geographic routes (a JSON of line routes) are not supported yet; they would use the same matching.
