# Changelog

All notable changes to minicode are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/).

## [0.1.0] - 2026-08-30

First public release.

### Added
- Agent loop (`agent.js`): streaming LLM calls, tool-call accumulation, result backfill, multi-turn until the model stops calling tools.
- Seven core tools ported from opencode `packages/core/src/tool/`: `bash`, `read`, `write`, `grep`, `glob`, `apply_patch` (full V4A patch algorithm), `webfetch`.
- Pure-ANSI TUI (`tui.js`): alternate screen, scrolling output area with scrollbar, PageUp/PageDown, mouse-wheel scrolling (SGR mouse reporting, alternate-scroll disabled), bracketed paste, wide-character (CJK) cursor positioning, forms, `/config` wizard, `/history` session loader.
- Token usage tracking in the bottom-right corner (`xx.xk used`), including usage delivered in standalone SSE chunks (choices-less frames).
- JSON session persistence with list/load (`session.js`).
- Config resolution: env vars > `~/.config/minicode/config.json` > defaults; compatible with `OPENAI_*` variables (`config.js`).
- CLI: TUI by default on TTY, readline fallback, `-y` non-interactive mode, `--format json` event stream.
- Portable installer (`install.sh`): PATH persistence on POSIX (bash/zsh/profile) and Windows (user environment variables), idempotent re-install, optional API env vars at install time.
- Test suite: 108 unit tests (tools/smoke/cli/tui) plus e2e suites (tui-e2e, toolview-e2e, paste-e2e, config-e2e) with automatic SKIP when no pty is available.

[0.1.0]: https://github.com/OWNER/minicode/releases/tag/v0.1.0
