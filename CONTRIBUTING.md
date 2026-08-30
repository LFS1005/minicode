# Contributing to minicode

Thanks for your interest in contributing. minicode has one hard constraint that shapes every decision:

> **Zero npm dependencies. Under 100 KB of source. Runs on armv7.**

If a change breaks any of these three, it will not be merged — no matter how good the feature is.

## Ground rules

1. **Node.js built-ins only.** No `npm install`. If you need a library, implement the subset you need in plain JS (see `tools.js` for how grep/glob/HTML→Markdown were done without ripgrep/turndown).
2. **No build step.** Everything must run with `node src/index.js` directly. No bundler, no transpile, no TypeScript.
3. **armv7 is the floor.** If it doesn't run on a low-power ARM box with Node's official linux-armv7l build, it doesn't ship.
4. **Stable tool semantics.** Tool descriptions, parameter shapes, and edge-case behavior must stay stable and documented. When in doubt, keep the existing contract rather than inventing a new one.

## Before you open a PR

```bash
npm test                # 108 unit tests must pass
node test/tui-e2e.mjs   # e2e (needs winpty/script; auto-SKIPs without a pty)
```

Also check:

- `du -sb src/` — must stay under 100 KB
- `node --check` passes on every file you touched
- No new file in `src/` unless the feature genuinely can't fit an existing one

## Style

- Plain ESM JavaScript, JSDoc for non-obvious types
- Comments explain *why*, not just what
- Keep functions small; prefer deletion over abstraction

## Reporting bugs

Include: OS/arch, Node version (`node -v`), the exact command run, and the full terminal output. If it involves a provider, include the base URL shape (never your API key).

## License

By contributing you agree your contributions are licensed under the MIT license.
