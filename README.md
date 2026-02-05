# Codex Chat — Obsidian Plugin

Chat with [OpenAI Codex](https://github.com/openai/codex) directly inside Obsidian. Uses the local Codex CLI — no API keys needed, just sign in with your ChatGPT account.

## Features

- **Chat sidebar** — A persistent right-panel chat view with streaming Markdown responses, status indicators, and cancel support.
- **Vault context injection** — Automatically includes the current note (and optionally linked notes) as context in every prompt. Configurable via settings.
- **Conversation memory** — Prior messages are prepended to the prompt so Codex has context of your full conversation, not just the last message.
- **Chat history persistence** — Messages survive sidebar close and Obsidian reloads. Start a new conversation with the `+` button.
- **Send selection to Codex** — Editor command that grabs your selection (or the full note) and sends it to the chat for analysis.
- **Insert/replace response** — Paste the last Codex response at your cursor, or replace selected text with it.
- **Auth status indicator** — Green/red dot in the sidebar header shows whether you're signed in. Click to sign in.
- **Copy button** — Hover over any assistant response to copy it to the clipboard.
- **Configurable** — Binary path, sandbox mode (read-only / workspace-write / full-access), context mode, max context length, model override, and reasoning effort.

## Prerequisites

1. **Codex CLI** installed globally:
   ```bash
   npm install -g @openai/codex
   ```
2. A **ChatGPT account**. No separate API key is needed.
3. **Obsidian** 1.0.0 or later (desktop only — the plugin uses Node.js child processes).

## Installation

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/infernosalex/codex_in_obsidian/releases).
2. Create a folder in your vault: `<Vault>/.obsidian/plugins/codex-chat/`
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Codex Chat** in **Settings → Community plugins**.

### From source

```bash
git clone https://github.com/infernosalex/codex_in_obsidian.git
cd codex_in_obsidian
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, `styles.css` to your vault's plugin folder.

## Usage

### Sign in

1. Open the command palette and run **Codex Chat: Sign in to codex**, or click the red dot in the chat sidebar header.
2. A modal will display a URL and device code. Open the URL in your browser and enter the code to authenticate.

### Chat

- Click the 💬 ribbon icon or use the **Codex Chat: Open chat** command to open the sidebar.
- Type a question and press **Ctrl+Enter** (or click Send).
- Responses stream in real time with status indicators (Thinking, Reasoning, Running command...).
- Click the **Cancel** button to abort a response.
- Hover over any assistant message and click the 📋 icon to copy.
- Click the **+** button in the header to start a new conversation.

### Editor commands

| Command | Description |
|---|---|
| **Open chat** | Open or focus the Codex Chat sidebar |
| **Send selection to codex** | Send selected text (or full note) to the chat |
| **Insert last codex response at cursor** | Insert response at cursor, or replace selected text |
| **Sign in to codex** | Trigger the device-code auth flow |

## Configuration

All settings are in **Settings → Codex Chat**:

| Setting | Default | Description |
|---|---|---|
| Binary path | `codex` | Path to the Codex CLI binary. Supports auto-detection from your shell's PATH. |
| Sandbox mode | Read-only | Controls Codex's file system access: `read-only`, `workspace-write`, `full-access` |
| Context mode | Current note | What vault context to include: `none`, `current-note`, `current-and-linked` |
| Max context length | 10,000 chars | Maximum characters of vault content to include in prompts |
| Model override | (default) | Optionally specify a model name (e.g., `o3-mini`) |
| Reasoning effort | Medium | Low / Medium / High reasoning effort |

## Development

```bash
npm install          # Install dependencies
npm run dev          # Build in watch mode
npm run build        # Production build (with type checking)
npm run lint         # Run ESLint
```

## Roadmap

- **`@file` references** — Type `@filename` in chat to include any vault file as context
- **Multi-session tabs** — Multiple named conversations with a session switcher
- **Export chat to note** — Save conversations as Markdown notes
- **Prompt templates** — Reusable templates with `{{selection}}`, `{{note}}`, `{{title}}` variables  
- **Slash commands** — `/clear`, `/new`, `/export`, `/model` for quick actions

## License

MIT
