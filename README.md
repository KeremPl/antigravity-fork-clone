# Antigravity Fork & Clone

Native message-level conversation forking and instant full-chat cloning inside the **Google Antigravity Desktop App** — powered directly by Antigravity's built-in `ForkConversation` and `UpdateConversationAnnotations` Language Server RPCs.

No SQLite database hacking, no protobuf patching, no app restarts, zero extra LLM tokens.

## Features

- **100% Native Forking (`ForkConversation`)**: Creates real Antigravity conversations in the exact same project with full native chat history and bubbles, immediately appearing in the left sidebar.
- **Git-Graph Chronological Timeline**: Displays turns `#1` (top) to `HEAD` (bottom) matching the chat flow, with auto-scroll to `HEAD` and a floating jump button.
- **Live Keep / Cut Hover Preview**: Hovering over **Buradan Forkla** or **Öncesinden** highlights the preserved ancestry rail (`1..K`) and dims the turns that will be discarded (`K+1..N`).
- **One-Click Full Clone**: Clone the entire conversation from its latest completed step with one click.
- **Inline Turn Inspector**: Click any turn card to expand the full user prompt, assistant reply, tool badges, and token delta (`+Xk`).
- **Parent ↔ Child Branch Navigation**: Persists fork lineage locally so branched conversations appear as clickable branch chips right on the turn they forked from, and child chats show a `↖ Forked from` breadcrumb to jump back to the parent.
- **`/fork` Slash Command**: Includes a companion `skills/fork/SKILL.md` to surface the panel directly from chat.

## Install

Requires **Google Antigravity Desktop** (v2.34+) and **Node.js**.

```bash
node install.mjs
```

To uninstall:

```bash
node install.mjs --uninstall
```

## Usage

1. In Antigravity Desktop, click **`+`** in the right-hand side pane and select **Fork & Clone** (right-click the tab -> **Pin Tab** to keep it always available).
2. Or type `/fork` in any conversation.
3. Click **Clone** to duplicate the full chat, or click **Buradan Forkla** / **Öncesinden** on any completed turn.

## License

MIT
