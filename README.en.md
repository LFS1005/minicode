<div align="center">

# minicode

**A terminal AI coding agent in under 1 MB of source code.**

*Part of the implementation references [opencode](https://github.com/sst/opencode).*

[![size](https://img.shields.io/badge/source%20size-%3C%201%20MB-brightgreen)](#size)
[![deps](https://img.shields.io/badge/dependencies-0-blue)](#size)
[![runtime](https://img.shields.io/badge/runtime-Node.js%20%E2%89%A5%2018.17-339933)](#installation)
[![arch](https://img.shields.io/badge/arch-x64%20%7C%20arm64%20%7C%20armv7-orange)](#installation)
[![tests](https://img.shields.io/badge/tests-148%20%2B%20e2e-success)](#testing)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

</div>

---

minicode is a terminal AI coding agent: **an LLM-driven agent loop + seven core tools + session persistence + TUI**. The entire implementation fits in **9 files, 2,964 lines, about 104 KB of source code**, with zero npm dependencies and zero build steps.

It runs directly on an armv7 TV box using the official Node.js binary. That is the whole point of this project.

---

## Size

| Metric | Value |
|---|---|
| Source | **9 files / 2,964 lines / ≈104 KB** |
| Portable package | Single tar.gz ≈ 40 KB |
| Runtime | Node.js built-ins, **0 dependencies** |
| Build step | None (run `node src/index.js` directly) |
| Minimum hardware | **armv7 box / Raspberry Pi / older phones** |

What was cut is the abstraction layer: dependency injection frameworks replaced with plain async/await, a database replaced with JSON files, a search binary replaced with pure JS recursion, a component framework replaced with plain ANSI escape codes. **The agent behavior model — loop, tool calls, context backfill — stays complete.**

## Core features

### Seven core tools

| Tool | Description |
|---|---|
| `bash` | Executes shell commands; full timeout / truncation / exit-code semantics |
| `read` | Paginated reading of text files and directories; 2,000-line, 50 KB, 2,000-char-per-line limits, binary detection |
| `write` | Writes files, preserving an existing BOM |
| `grep` | Regex search with clean output format, pure JS (no external search binary) |
| `glob` | Glob matching (`**` / `*` / `?` / `{a,b}`), with ignore rules |
| `apply_patch` | V4A patch algorithm: four-way matching (exact/rstrip/trim/normalized), `*** Add/Update/Delete File`, context anchors |
| `webfetch` | Fetches a URL and converts to Markdown/text; Accept header, browser UA, 5 MB cap, MIME filtering, script/style skipping; zero-dependency HTML→Markdown |

Built-in ignore rules (`node_modules`, `.git`, `dist`, `__pycache__`, about 30 entries) automatically skip irrelevant directories and files.

### Agent loop

`input → LLM (streaming SSE) → tool calls → result backfill → continue`, until the model stops calling tools. The message structure and event model (`step_start` / `message.part.updated` / `session.status` / `usage`) work with any OpenAI-compatible endpoint (OpenAI / DeepSeek / vLLM / Ollama / one-api).

### TUI (zero dependency)

- Alternate screen rendering (does not pollute shell history on exit), full clear-and-redraw per frame
- Scrolling output area + status line + input line, with a **built-in scrollbar** (PageUp/PageDown)
- **Mouse wheel scrolls the output area directly** (SGR mouse reporting, alternate-scroll disabled)
- Bracketed paste: pasting multi-line text never triggers a send; wide-character (CJK) cursor positioning uses display width
- **Esc / Ctrl+C while the agent is running interrupts the current task**, preserving the session and keeping input available
- `/config` setup wizard, `/history` session picker, `/model`, `/new`, `/exit`
- Persistent token counter in the bottom-right corner (`xx.xk used`)
- Falls back to readline without a TTY; `--no-tui` forces the fallback

### Sessions & config

- Sessions are persisted as JSON files (`~/.minicode/sessions/`); list and resume supported
- Config precedence: environment variables > `~/.config/minicode/config.json` > defaults
- Compatible with `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`

## Installation

### Portable package (recommended, any platform including armv7)

```bash
tar -xzf minicode-portable-<version>.tar.gz && cd minicode && bash install.sh
```

`install.sh` automatically:

- Copies to `~/.minicode/` and creates the `~/.local/bin/minicode` launcher
- **Persists PATH**: Linux/macOS writes to `~/.bashrc` / `~/.zshrc` / `~/.profile`; Windows writes to the user environment variables (dedupes repeated installs)
- Optionally applies API config globally when passed at install time

```bash
MINICODE_API_KEY=sk-xxx MINICODE_BASE_URL=https://api.deepseek.com/v1 MINICODE_MODEL=deepseek-chat bash install.sh
```

Custom directory: `MINICODE_INSTALL_DIR=/opt/minicode bash install.sh`

### Run from source

```bash
node src/index.js
```

Requires Node.js ≥ 18.17 (built-in fetch / fs/promises). No npm dependencies, no `npm install`.

## Quick start

```bash
# Configure (pick one)
export MINICODE_API_KEY=sk-...        # 1) environment variable
echo '{"apiKey":"sk-..."}' > ~/.config/minicode/config.json   # 2) config file
minicode   → type /config              # 3) TUI setup wizard

# Local model (e.g. Ollama), no key needed
export MINICODE_BASE_URL=http://localhost:11434/v1

# Run
minicode                          # TUI on a TTY
minicode -y "summarize this directory"   # non-interactive, exits when done
minicode -y --format json "..." | jq   # JSON event stream
```

## Architecture

```
src/                       ≈104 KB total
  index.js    (626 lines) CLI entry: TUI/readline dual paths, -y non-interactive, --format json event stream, /commands
  tui.js      (689 lines) Plain-ANSI TUI: scrolling area/scrollbar/mouse/paste/forms/wide chars/interrupt
  tools.js    (947 lines) Seven core tools + ignore rules + patch algorithm + HTML→Markdown
  agent.js    (230 lines) Agent loop, event emission, retry scheduling
  llm.js      (183 lines) OpenAI-compatible client: streaming SSE, tool-call accumulation, usage capture, cancel signal
  retry.js    ( 94 lines) Retry: retryable check + backoff strategy
  config.js   (102 lines) Config parsing and persistence
  session.js  ( 68 lines) JSON session persistence
  prompt.js   ( 25 lines) System prompt
test/                     148 unit tests + 4 e2e suites
  tools.test.mjs (30)   patch algorithm, grep/glob, bash, webfetch conversion
  smoke.test.mjs (18)   full agent loop against a fake OpenAI server
  cli.test.mjs    (6)   stdout/stderr separation, JSON event stream
  tui.test.mjs   (59)   rendering/keys/scroll/paste/wide chars/forms/wheel/interrupt
  retry.test.mjs (35)   retry check/backoff/429/500/stream interrupt/cancel
  *_e2e.mjs           real terminal e2e via winpty/pty (auto-SKIP without a pty)
```

## Testing

```bash
npm test
```

## FAQ

**Q: Why not distribute via npm?**
The portable package is about 40 KB — copy it to any machine and run `bash install.sh`; no online Node ecosystem needed. npm remains an option (`npm publish`, `package.json` is ready).

**Q: Does it support Claude / Gemini?**
Any model behind an OpenAI-compatible `/v1/chat/completions` endpoint works (including one-api / litellm proxies).

**Q: Is it safe?**
The `bash` tool executes commands with the current user's permissions. Only use it in environments you trust.

## License

[MIT](LICENSE)
