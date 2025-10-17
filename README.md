# MeerAI for VS Code

Bring the MeerAI local-first coding assistant into your Visual Studio Code workflow. This extension wraps the [`meer`](https://github.com/meer-ai/meer) CLI to provide workspace-aware chat, code explanations, and quick prompts without leaving the editor.

## Features

- **Tabbed chat sidebar** – keep multiple conversations side-by-side, rename or delete threads, and pick up where you left off.
- **Workspace context** – commands run from the active workspace folder so the CLI can collect relevant files.
- **Selection tools** – explain selected code directly from the editor.
- **Configurable CLI command** – point the extension at a custom MeerAI binary or script.

## Requirements

- Node.js 20 or later (required by the MeerAI CLI).
- The [`meer` CLI](https://github.com/meer-ai/meer) installed and configured locally, or an alternative command compatible with `meer ask`.

## Extension Settings

| Setting | Description | Default |
| --- | --- | --- |
| `meerai.cliCommand` | Command used to invoke the MeerAI CLI (`meer`, `node /path/to/meer/dist/index.js`, etc.). | `meer` |
| `meerai.maxBuffer` | Maximum kilobytes of response text retained in memory per request. | `1024` |

## Commands

| Command | Description |
| --- | --- |
| `MeerAI: Ask Workspace` | Prompt for a question and stream the answer into the MeerAI output channel. |
| `MeerAI: Explain Selection` | Explain the highlighted code using `meer ask`. |
| `MeerAI: Configure Provider` | Pick a provider (Ollama, OpenAI, Anthropics, etc.) and store credentials in `~/.meer/config.yaml`. |
| `MeerAI: New Chat` | Open the MeerAI view, spawn a fresh conversation tab, and focus the input. |

## Getting Started

1. Install dependencies and build the extension:

   ```bash
   npm install
   npm run compile
   ```

2. Open this folder in VS Code, press `F5` to launch an Extension Development Host, and open a workspace that is compatible with the MeerAI CLI.
3. Run `MeerAI: Configure Provider` from the Command Palette (or click the gear icon in the MeerAI view) to select a provider, enter API keys, and choose a default model. The extension updates `~/.meer/config.yaml` for you.
4. Optionally run `MeerAI: New Chat` to spin up a fresh thread in the sidebar.
5. Ensure the `meer` command is reachable on your PATH—use the Settings menu to tweak `MeerAI › Cli Command` if needed—or set it to an absolute path (e.g. `node D:/DevOps/devai/dist/index.js`).
6. Open the **MeerAI** activity-bar view to start chatting, switch between conversations, or run the commands from the Command Palette.

## Development

- `npm run watch` – compile on file changes.
- `npm run package` – create a `.vsix` using `@vscode/vsce`.

## Troubleshooting

- If you see `MeerAI CLI command not found`, check that `meerai.cliCommand` resolves to a runnable binary.
- `spawn EINVAL` usually means Windows rejected the CLI command. Adjust the `MeerAI › Cli Command` setting (gear icon → Settings) to point at a valid executable such as `meer.cmd` or `node D:/DevOps/devai/dist/index.js`.
- Responses longer than the configured buffer are truncated to the most recent text.
- The chat view streams stdout from `meer ask`; verbose CLI logging still appears in the VS Code output channel named **MeerAI**.

## License

MIT
