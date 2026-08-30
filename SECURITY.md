# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

Open a private security advisory via GitHub ("Report a vulnerability" on the Security tab), or contact the maintainer directly. Please do **not** open a public issue for security reports.

Include: affected file(s), reproduction steps, and impact. You'll get an initial response within a few days.

## Known scope / honest disclosures

minicode is a terminal agent that executes shell commands with the current user's authority. Be aware of the following before using it:

- **`bash` tool runs real commands.** There is currently **no permission-confirmation gate** — the model can execute any command without asking. This is the top item on the roadmap. Until it ships, run minicode only in environments and on codebases you trust.
- **API keys** are stored in plain text in `~/.config/minicode/config.json` or environment variables, same as most CLI tools. Never commit them.
- **Sessions** (`~/.minicode/sessions/`) contain your conversation and tool output history in plain JSON. Delete them if that matters to you.
- **`webfetch`** follows redirects and fetches attacker-controllable URLs only when the model chooses to; responses are size-capped (5 MB) and MIME-filtered.

## Hardening recommendations

- Prefer a local model endpoint (Ollama/vLLM) when working with sensitive code — nothing leaves the machine.
- Run inside a container/VM for untrusted projects.
- Keep `MINICODE_INSTALL_DIR` under your own home directory.
