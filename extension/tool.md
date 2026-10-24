Run Luau in the current Tern window with its real `tern` API, injected `cx`, and `omp` helpers. Use this when inspecting or controlling that live window, or when building an interactive Tern view.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT`.
</system-conventions>

## Inputs

- `code`: Luau source; it runs as a function receiving fresh `cx` and `omp`.
- `timeout`: optional seconds, 1–300; defaults to 30 and bounds execution/action waits.
- `waitForAction`: optional; wait for the first `omp.emit` after the script returns.

Use short synchronous scripts. Every Tern callback, including `tern.timer` ticks, has a 50 ms budget: one overrun disables every timer of the bridge plugin until Tern reloads it, stopping your live updates and the bridge's discovery of new sessions. Keep ticks to cheap state changes plus one `omp.show`; move process, file and network work into `tern.process`/`fetch` callbacks. A `cx` is valid only during the call that received it: `tern.timer(ms, function(cx) … end)`, `tern.process.run(…, function(result, cx) … end)` and `:next(function(value, err, cx) … end)` each pass a fresh one, so use that and never a `cx` captured from an earlier call (it fails with "userdata has been destructed"). In later callbacks, wrap context-dependent helpers in `omp.with_context(cx, fn)`. `omp.emit(data)` does not require a context.

## The window `cx`

`cx` is Tern's real window context, not a sandbox. Beyond `cx.session` (panes, tabs, `read`, `surface`) and `cx.layout`, it carries `cx.agents` (list, start, ask, wait on, read transcripts of, interrupt agent panes such as other omp sessions), `cx.docs`, `cx.git`, `cx.procs`, `cx.browser`, `cx.db`, `cx.notebook`, `cx.board`, `cx.screen` and `cx.canvas`. Async members return awaitables: chain `:next(function(value, err, cx) ... end)`. When unsure of a signature, inspect it at runtime (`tern.json.encode` a result, `pcall` a call) rather than guessing.

## Tern views

`omp.show(id, { placement = "inline" | "beside", view = Node, title?, css?, dock?, about?, focus? })` creates or updates a named view; placement defaults to beside and focus defaults to false. Use inline for a view attached to this tool result; use beside for a separate Tern canvas pane (`dock` is its bottom bar, `about` its purpose). Close with `omp.close(id)`; `omp.view(id)` returns the pane number, the inline id, or nil when absent. `Node` is a native TSP tree shaped as `{ k, p?, c? }`; build it with `tern.ui`.

Besides Tern's semantic kinds (card, table, chart, meter, checklist, tree, code, diff, md, …), `el` nodes are plain HTML elements (`tern.ui.el(tag, props, children)`: `div`, `p`, `span`, `button`, `label`, `form`, `input` checkbox/radio, tables, lists, …) styled only by `css`. An inline view's `css` is confined to omp's surface; a canvas's `css` is app-wide. Either way, give the view's root a distinctive class and start every selector with it.

`omp.on_action(id, fn)` handles native UI events as `fn(event, cx)`: `type == "action"` with `act` (and form `values` inside an `el` form), `type == "control"` when an `el` checkbox or radio flips (`checked`, `value`, `name`, `values`), plus `toggle`/`select`/`change`. Canvases report clicks on `actions` only, so put checkbox/radio forms inline or read their state through a button's action. Return `true` when consumed; return `false` for the default, which emits events with `act` or `type == "action"`. `omp.emit(data)` sends structured data back as an aside. Keep action payloads JSON-safe.

```lua
local view = {
  k = "card",
  p = { head = "Review", actions = { click = "toggle" } },
  c = {
    { k = "text", p = { text = "Click the card to report its state." } },
    { k = "badge", p = { text = "Ready", tone = "success" } },
  },
}

omp.show("review", { placement = "inline", view = view })
omp.on_action("review", function(event, cx)
  if event.type == "action" and event.act == "toggle" then
    omp.with_context(cx, function()
      omp.emit({ view = "review", action = event.act })
    end)
    return true
  end
  return false
end)
return "Review opened"
```

## Action waits

Use `waitForAction: true` only when the caller needs an inline interaction result. The tool returns `{ result, action }` for the first emit after script completion; emits before completion and later emits remain asides. Only one action-waiting call may run per Tern session. The wait is bounded by `timeout`.

## Critical

- MUST target the current Tern window; NEVER invent a pane or session.
- MUST return JSON-safe values; unsupported results fail the tool call.
- MUST use `omp.with_context` for context-dependent helpers in callbacks.
- Keep scripts short; move delayed or network work into callbacks.
