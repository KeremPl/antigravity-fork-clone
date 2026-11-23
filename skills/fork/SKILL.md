---
name: fork
description: Open the native Fork & Clone side-pane panel to fork the current Antigravity Desktop conversation from any message or clone it cleanly into the same project. Use when the user runs /fork, asks to fork/branch from an earlier message, or wants to clone the current chat.
---

# Fork & Clone Panel

Open the native **Fork & Clone** side-pane panel (`fork-clone/fork_panel`).

## Instructions

1. Check read-only whether the `fork-clone/fork_panel` sidecar is running (`~/.gemini/antigravity/sidecar_data/fork-clone/fork_panel/logs/sidecar.log` exists and is non-empty).
2. **If active**, output the one-click pill on its own line:
   `[Fork & Clone](sidecar://fork-clone/fork_panel/)`
   Tell the user they can fork from any completed message turn or clone the full conversation natively into the same project directly from the panel.
3. **If not yet enabled**, do not emit a `sidecar://` link; instead link `[Fork & Clone](customization://fork-clone)` so the user can enable the plugin.
