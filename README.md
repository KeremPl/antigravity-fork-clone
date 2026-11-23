# Antigravity Fork & Clone

**Native message-level conversation forking and instant full-chat cloning inside the Google Antigravity Desktop App** — with a Git-graph timeline side panel powered directly by Antigravity's own built-in `ForkConversation` engine.

- **Zero SQLite / Protobuf writes** — delegates the actual fork directly to Antigravity's local Language Server (`ForkConversation` + `UpdateConversationAnnotations`)
- **Real native conversations** — forked chats appear immediately in the exact same project with full native message bubbles, tool cards, and history (no copy-paste summary prompts, no app restarts)
- **Zero external dependencies** — pure Node.js standard library (`node:sqlite` read-only + `sidecar_sdk`), zero extra LLM tokens

<!-- Add a screenshot of the side panel here once captured:
![Fork & Clone side panel preview](assets/preview.png)
-->

---

## Why This Exists

Antigravity's CLI (`agy`) has `/fork` and `/rewind`, while the **Antigravity Desktop App** (as of v2.34.0) still lacks a graphical button to fork from a specific message or clone a conversation.

Interestingly, Antigravity Desktop's local Language Server **already implements `ForkConversation(sourceCascadeId, forkAtStepIndex, targetForkWorkspace)` natively** — it just isn't wired to a UI control yet. This plugin puts a clean, native-feeling side panel on top of Google's own engine.

| Approach | Native chat bubbles? | Any past turn (`1..K`)? | Touches SQLite/Protobuf? | Needs restart / external browser? |
| :--- | :---: | :---: | :---: | :---: |
| **Antigravity Fork & Clone (this plugin)** | **Yes** | **Yes** | **No** (read-only) | **No** (native side panel) |
| Prompt-summary forkers | No (pasted Turn 1 summary) | Yes | No | No |
| External SQLite/protobuf forkers | Yes | Yes | Yes | External web UI / restart |
| CLI `/fork` + `/rewind` | CLI only | 2 steps | No | Terminal only |

---

## Features

- **Git-Graph Chronological Timeline**: Displays turns `#1` (top) to `HEAD` (bottom) matching the chat flow, auto-scrolls to `HEAD`, and shows a floating `↓ HEAD` jump button when scrolling up.
- **Live Keep / Cut Hover Preview**: Hovering **Fork here** or **Before** highlights the preserved ancestry rail (`1..K`) and dims the turns that will be discarded (`K+1..N`).
- **Fork After or Before Any Turn**:
  - **Fork here**: keeps turns `1..K` including turn `K`'s assistant reply.
  - **Before**: keeps turns `1..K-1` so you can rewrite turn `K` cleanly.
  - **Clone**: duplicates the entire conversation from its latest completed step.
- **Inline Turn Inspector**: Click any turn card to inspect the full user prompt, assistant reply, tools invoked, and per-turn context token growth (`+Xk`).
- **Parent ↔ Child Branch Navigation**: Tracks local fork lineage in the sidecar's isolated `lineage.json` so branched chats appear as clickable branch chips right on the turn they forked from, and child chats display a `↖ Forked from #K` breadcrumb to jump back to the parent.
- **Built-in EN / TR Language Toggle**: Switch instantly between English and Turkish (`EN` / `TR` button in the header).
- **`/fork` Slash Command**: Includes a companion `skills/fork/SKILL.md` to open the panel directly from chat.

---

## Installation

Requires **Google Antigravity Desktop** (v2.34+) and **Node.js 22+** (or Antigravity's bundled Node runtime).

### Option 1: One-command install via `agy` CLI
```bash
agy plugin install https://github.com/<your-username>/antigravity-fork-clone
```

### Option 2: Clone & install locally
```bash
git clone https://github.com/<your-username>/antigravity-fork-clone.git
cd antigravity-fork-clone
node install.mjs
```

To uninstall:
```bash
node install.mjs --uninstall
```

---

## Usage

1. Open any conversation in **Antigravity Desktop**.
2. Click **`+`** in the right-hand side panel and select **Fork & Clone** (right-click the tab → **Pin Tab** to keep it handy across sessions).
3. Or type `/fork` in chat.
4. Click **Clone** for a full copy, or click **Fork here** / **Before** on any completed turn.
5. Press `/` to search messages (`Esc` to clear).

---

## How It Works (Architecture)

```text
sidecars/fork_panel/
  main.mjs      Read-only transcript.jsonl + conversation_summaries.db parser
                + POST /api/fork -> LanguageServerService/ForkConversation
                + UpdateConversationAnnotations (optional custom title)
  index.html    Native side-pane Web UI (synced to host theme tokens via /preload.js)
  styles.css    Light/dark theme-aware Git-graph timeline styles
  app.js        Timeline polling, hover cut preview, inline inspector, EN/TR i18n
```

- **Read-only on Antigravity's data**: Never writes to `conversations/*.db` or `conversation_summaries.db`.
- **Safe rewind deduplication**: Properly handles append-only `transcript.jsonl` entries when messages were edited or cancelled.
- **Isolated lineage**: Stores branch links only inside the sidecar's own data directory (`lineage.json`).

---

## Platform Status & Contributing

- **Tested on:** Windows 11 + Antigravity Desktop `v2.34.0`
- **macOS / Linux:** Written with pure cross-platform Node.js (`path.join`, `homedir()`), but community testing and PRs on macOS & Linux are very welcome!
- **Known limitation:** Antigravity's `sidecar_sdk` iframe bridge does not currently expose a `scrollToStep` method to scroll the main chat pane to a clicked message; clicking a card instead expands the full prompt, reply, and tool list inline.

Issues, bug reports, and pull requests are welcome.

## License

[MIT](LICENSE)
