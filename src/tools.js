// 六个核心工具,逻辑照搬 opencode packages/core/src/tool/ 下的实现:
// bash / read / write / grep / glob / apply_patch
// 去掉 effect 与 ripgrep 二进制依赖,改用 Node 内置模块,保证零依赖、可在 armv7 Linux 上运行

import { execFile } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

// ============================================================
// 照搬 opencode core/src/filesystem/ignore.ts
// ============================================================

const IGNORE_FOLDERS = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  "vendor",
  ".npm",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "bin",
  "obj",
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  ".idea",
  ".turbo",
  ".output",
  "desktop",
  ".sst",
  ".cache",
  ".webkit-cache",
  "__pycache__",
  ".pytest_cache",
  "mypy_cache",
  ".history",
  ".gradle",
])

const IGNORE_FILES = [
  "**/*.swp",
  "**/*.swo",
  "**/*.pyc",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/logs/**",
  "**/tmp/**",
  "**/temp/**",
  "**/*.log",
  "**/coverage/**",
  "**/.nyc_output/**",
]

function globToRegExp(pattern) {
  // 支持 ** / * / ? / {a,b} 花括号展开,照搬 ripgrep glob 的常用子集
  const expand = (parts) => {
    if (parts.length === 0) return [""]
    const [head, ...rest] = parts
    const results = []
    for (const r of expand(rest)) {
      for (const h of head) results.push(h + r)
    }
    return results
  }
  const tokens = pattern.split(/(\{[^{}]*\})/g).filter(Boolean)
  const variants = expand(tokens.map((t) => (t.startsWith("{") ? t.slice(1, -1).split(",") : [t])))
  const one = (p) => {
    // 顶层 **/ 允许匹配零段(src/**/*.js 也能匹配 src/y.js)
    const lead = p.startsWith("**/") ? "(?:.*/)?" : ""
    const body = p.replace(/^\*\*\//, "")
    return (
      lead +
      body
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*")
        .replace(/\?/g, "[^/]")
    )
  }
  return new RegExp("^(?:" + variants.map(one).join("|") + ")$")
}

function isIgnored(filepath, { extra = [] } = {}) {
  const parts = filepath.split(/[/\\]/)
  for (const part of parts) {
    if (IGNORE_FOLDERS.has(part)) return true
  }
  for (const pattern of [...IGNORE_FILES, ...extra]) {
    if (globToRegExp(pattern).test(filepath)) return true
  }
  return false
}

// ============================================================
// 工具注册表
// ============================================================

export function makeRegistry() {
  const tools = new Map()
  const register = (t) => tools.set(t.name, t)
  const definitions = () =>
    [...tools.values()].map(({ name, description, parameters }) => ({
      type: "function",
      function: { name, description, parameters },
    }))
  const get = (name) => tools.get(name)
  return { register, definitions, get }
}

// ============================================================
// bash —— 照搬 core/src/tool/bash.ts
// ============================================================

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
const MAX_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_CAPTURE_BYTES = 1024 * 1024

// 照搬 defaultShell:POSIX 用 /bin/sh,Windows 用 COMSPEC 或 cmd.exe
const defaultShell = () => (process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh")

const bashTool = {
  name: "bash",
  description:
    "Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: 120000; maximum: 600000). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command string to execute" },
      workdir: {
        type: "string",
        description:
          "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
      },
      timeout: {
        type: "number",
        description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
      },
    },
    required: ["command"],
  },
  async execute({ command, workdir, timeout }, ctx) {
    const cwd = workdir ? path.resolve(ctx.cwd, workdir) : ctx.cwd
    const effectiveTimeout = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const shell = ctx.shell ?? defaultShell()

    const result = await runCommand(command, { cwd, shell, timeout: effectiveTimeout, maxBytes: MAX_CAPTURE_BYTES })

    if (result.timedOut) {
      return (
        `Command exceeded timeout of ${effectiveTimeout} ms. Retry with a larger timeout if the command is expected to take longer.`
      )
    }
    const output = result.output || "(no output)"
    const notice = result.truncated ? "[output capture truncated at the in-memory safety limit]" : undefined
    const body = notice ? `${output}\n\n${notice}` : output
    const exitLine = result.timedOut
      ? "Command timed out before completion."
      : `Command exited with code ${result.exitCode}.`
    return `${body}\n\n${exitLine}`
  },
}

function runCommand(command, { cwd, shell, timeout, maxBytes }) {
  return new Promise((resolve) => {
    // POSIX shell 用 -c;Windows cmd.exe 用 /d /s /c(照搬 opencode 的平台默认 shell 语义)
    const args = /[\\/]cmd\.exe$/i.test(shell) ? ["/d", "/s", "/c", command] : ["-c", command]
    const child = execFile(
      shell,
      args,
      { cwd, timeout, maxBuffer: maxBytes + 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !err.killed && !/ETIMEDOUT|Timed out/i.test(err.message)) {
          // 非超时的执行失败:退出码非 0,stdout/stderr 仍可用
          resolve({
            exitCode: typeof err.code === "number" ? err.code : 1,
            output: [stdout, stderr].filter(Boolean).join("\n"),
            truncated: stdout.length + stderr.length >= maxBytes,
            timedOut: false,
          })
          return
        }
        if (err) {
          // 超时(被 kill)
          resolve({ exitCode: null, output: "", truncated: false, timedOut: true })
          return
        }
        resolve({
          exitCode: 0,
          output: [stdout, stderr].filter(Boolean).join("\n"),
          truncated: stdout.length + stderr.length >= maxBytes,
          timedOut: false,
        })
      },
    )
  })
}

// ============================================================
// read —— 照搬 core/src/tool/read.ts + read-filesystem.ts
// ============================================================

const MAX_READ_LINES = 2_000
const MAX_READ_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2_000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

// 照搬 read-filesystem.ts 的二进制检测
const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo",
])

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

function isBinary(resource, bytes) {
  if (BINARY_EXTENSIONS.has(path.extname(resource).toLowerCase())) return true
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}

const readTool = {
  name: "read",
  description:
    "Read a text file or supported image, page through a large UTF-8 text file by line offset, or list a directory page. Relative paths resolve from the current location; absolute paths inside it are accepted, while external absolute paths require external_directory approval.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: {
        type: "number",
        description: "The 1-based directory entry or text line offset to start reading from",
      },
      limit: { type: "number", description: "The maximum number of directory entries or text lines to read" },
    },
    required: ["path"],
  },
  async execute({ path: input, offset, limit }, ctx) {
    const absolute = path.isAbsolute(input) ? input : path.resolve(ctx.cwd, input)
    let stat
    try {
      stat = await fsp.stat(absolute)
    } catch (err) {
      return `Unable to read ${input}: ${err.message}`
    }

    if (stat.isDirectory()) {
      // 照搬 list():目录优先、按名排序、分页
      let entries
      try {
        entries = await fsp.readdir(absolute, { withFileTypes: true })
      } catch (err) {
        return `Unable to read ${input}: ${err.message}`
      }
      const visible = entries
        .filter((e) => e.isFile() || e.isDirectory())
        .map((e) => ({ name: e.name + (e.isDirectory() ? path.sep : ""), type: e.isDirectory() ? "directory" : "file" }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
      const start = offset ?? 1
      const lim = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES)
      const selected = visible.slice(start - 1, start - 1 + lim)
      const truncated = start - 1 + selected.length < visible.length
      const next = truncated ? start + selected.length : undefined
      const body = selected.map((e) => `${e.name}`).join("\n")
      const meta = `Directory ${absolute} (${visible.length} entries, showing ${start}-${start + selected.length - 1})`
      return `${meta}\n${body}${truncated ? `\n...(more entries; next offset ${next})` : ""}`
    }

    if (!stat.isFile()) return `Unable to read ${input}: not a file or directory`

    const size = stat.size
    const paged = size > MAX_READ_BYTES || offset !== undefined || limit !== undefined
    const start = offset ?? 1
    const lim = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES)

    try {
      if (!paged) {
        const content = await fsp.readFile(absolute, "utf8")
        if (isBinary(input, Buffer.from(content))) return `Cannot read binary file: ${absolute}`
        return content
      }
      // 照搬 read() 的分页逻辑(行截断、50KB 上限、next 偏移)
      const buffer = await fsp.readFile(absolute)
      if (isBinary(input, buffer)) return `Cannot read binary file: ${absolute}`
      const text = buffer.toString("utf8").replace(/^\uFEFF/, "")
      const lines = text.split("\n")
      if (lines.at(-1) === "") lines.pop()

      const collected = []
      let bytes = 0
      let next
      for (let i = start - 1; i < lines.length; i++) {
        if (collected.length >= lim || bytes >= MAX_READ_BYTES) {
          next = i + 1
          break
        }
        const raw = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i]
        const shown = raw.length > MAX_LINE_LENGTH ? raw.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : raw
        const sizeBytes = Buffer.byteLength(shown, "utf8") + (collected.length > 0 ? 1 : 0)
        if (bytes + sizeBytes > MAX_READ_BYTES) {
          next = i + 1
          break
        }
        collected.push(shown)
        bytes += sizeBytes
      }
      const truncated = next !== undefined
      const meta = `File ${absolute} (${lines.length} lines total, showing ${start}-${start + collected.length - 1}${truncated ? `, truncated` : ""})`
      const body = collected.join("\n")
      const tail = truncated ? `\n...(more lines; next offset ${next})` : ""
      return `${meta}\n${body}${tail}`
    } catch (err) {
      return `Unable to read ${input}: ${err.message}`
    }
  },
}

// ============================================================
// write —— 照搬 core/src/tool/write.ts
// ============================================================

const writeTool = {
  name: "write",
  description:
    "Write content to one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "File path to write. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
      },
      content: { type: "string", description: "Content to write to the file" },
    },
    required: ["path", "content"],
  },
  async execute({ path: input, content }, ctx) {
    const absolute = path.isAbsolute(input) ? input : path.resolve(ctx.cwd, input)
    try {
      await fsp.mkdir(path.dirname(absolute), { recursive: true })
      // 照搬 writeTextPreservingBom:已有文件带 BOM 则保留
      let existing = ""
      try {
        existing = await fsp.readFile(absolute, "utf8")
      } catch {}
      const bom = existing.startsWith("\uFEFF")
      const body = bom ? `\uFEFF${content}` : content
      await fsp.writeFile(absolute, body, "utf8")
      return `${bom ? "Wrote" : "Created"} file successfully: ${absolute}`
    } catch (err) {
      return `Unable to write ${input}: ${err.message}`
    }
  },
}

// ============================================================
// grep —— 照搬 core/src/tool/grep.ts(输出格式 + ignore 规则,纯 JS 实现)
// ============================================================

const grepTool = {
  name: "grep",
  description:
    "Search file contents by regular expression within the active Location or an absolute managed tool-output file. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for in file contents" },
      path: { type: "string", description: "Relative directory to search. Defaults to the active Location." },
      include: {
        type: "string",
        description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
      },
      limit: { type: "number", description: "Maximum matches to return" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path: input, include, limit }, ctx) {
    const root = input ? path.resolve(ctx.cwd, input) : ctx.cwd
    let re
    try {
      re = new RegExp(pattern)
    } catch (err) {
      return `Unable to grep for ${pattern}: ${err.message}`
    }
    const max = limit ?? Number.MAX_SAFE_INTEGER
    const matches = []
    const includeRe = include ? globToRegExp(include) : null

    const walk = async (dir) => {
      if (matches.length >= max) return
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (matches.length >= max) return
        const full = path.join(dir, e.name)
        const rel = path.relative(ctx.cwd, full)
        if (isIgnored(rel)) continue
        if (e.isDirectory()) {
          await walk(full)
        } else if (e.isFile()) {
          if (includeRe && !includeRe.test(path.basename(full))) continue
          try {
            const content = await fsp.readFile(full, "utf8")
            const lines = content.split("\n")
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= max) break
              if (re.test(lines[i])) {
                matches.push({ path: rel.replaceAll("\\", "/"), line: i + 1, text: lines[i].slice(0, 300) })
              }
            }
          } catch {}
        }
      }
    }
    await walk(root)

    // 照搬 grep.ts toModelOutput 的格式
    if (matches.length === 0) return "No files found"
    const lines = [`Found ${matches.length} matches`]
    let current = ""
    for (const match of matches) {
      if (current !== match.path) {
        if (current) lines.push("")
        current = match.path
        lines.push(`${match.path}:`)
      }
      lines.push(`  Line ${match.line}: ${match.text}`)
    }
    return lines.join("\n")
  },
}

// ============================================================
// glob —— 照搬 core/src/tool/glob.ts
// ============================================================

const globTool = {
  name: "glob",
  description:
    "Find files by glob pattern within the active Location. Returns concise relative file resources. Use a relative path to narrow the search and limit to bound the result count.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match files against" },
      path: { type: "string", description: "Relative directory to search. Defaults to the active Location." },
      limit: { type: "number", description: "Maximum results to return" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path: input, limit }, ctx) {
    const root = input ? path.resolve(ctx.cwd, input) : ctx.cwd
    const max = limit ?? Number.MAX_SAFE_INTEGER
    const results = []
    const re = globToRegExp(pattern)

    const walk = async (dir) => {
      if (results.length >= max) return
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (results.length >= max) return
        const full = path.join(dir, e.name)
        const rel = path.relative(ctx.cwd, full)
        if (isIgnored(rel)) continue
        if (e.isDirectory()) {
          await walk(full)
        } else if (e.isFile() && re.test(rel.replaceAll("\\", "/"))) {
          results.push(rel.replaceAll("\\", "/"))
        }
      }
    }
    await walk(root)

    // 照搬 glob.ts toModelOutput:每行一个相对路径
    if (results.length === 0) return "No files found"
    return results.join("\n")
  },
}

// ============================================================
// apply_patch —— 完整照搬 core/src/patch.ts 的解析与匹配算法
// ============================================================

function stripHeredoc(input) {
  return input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)?.[2] ?? input
}

function splitBom(text) {
  return text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
}

// 照搬 seek 的四种匹配策略:exact / rstrip / trim / normalized
const exact = (l, r) => l === r
const rstrip = (l, r) => l.trimEnd() === r.trimEnd()
const trim = (l, r) => l.trim() === r.trim()
const normalized = (l, r) => normalize(l.trim()) === normalize(r.trim())

function normalize(value) {
  return value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ")
}

function seek(lines, pattern, start, eof = false) {
  if (pattern.length === 0) return -1
  for (const compare of [exact, rstrip, trim, normalized]) {
    if (eof) {
      const offset = lines.length - pattern.length
      if (offset >= start && matches(lines, pattern, offset, compare)) return offset
    }
    for (let offset = start; offset <= lines.length - pattern.length; offset++) {
      if (matches(lines, pattern, offset, compare)) return offset
    }
  }
  return -1
}

function matches(lines, pattern, offset, compare) {
  return pattern.every((line, index) => compare(lines[offset + index], line))
}

// 照搬 patch.ts parse:解析 *** Begin Patch / *** End Patch 包裹的 hunks
function parsePatch(patchText) {
  const lines = stripHeredoc(patchText.trim()).split("\n")
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  const end = lines.findIndex((line) => line.trim() === "*** End Patch")
  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error("Invalid patch format: missing Begin/End markers")
  }

  const hunks = []
  let index = begin + 1
  while (index < end) {
    const line = lines[index]
    if (line.startsWith("*** Add File:")) {
      const p = line.slice("*** Add File:".length).trim()
      if (!p) throw new Error("Invalid add file path")
      const parsed = parseAdd(lines, index + 1)
      hunks.push({ type: "add", path: p, contents: parsed.content })
      index = parsed.next
      continue
    }
    if (line.startsWith("*** Delete File:")) {
      const p = line.slice("*** Delete File:".length).trim()
      if (!p) throw new Error("Invalid delete file path")
      hunks.push({ type: "delete", path: p })
      index++
      continue
    }
    if (line.startsWith("*** Update File:")) {
      const p = line.slice("*** Update File:".length).trim()
      if (!p) throw new Error("Invalid update file path")
      let next = index + 1
      let movePath
      if (lines[next]?.startsWith("*** Move to:")) {
        movePath = lines[next].slice("*** Move to:".length).trim()
        if (!movePath) throw new Error("Invalid move file path")
        next++
      }
      const parsed = parseUpdate(lines, next)
      if (parsed.chunks.length === 0) throw new Error(`Invalid update hunk for ${p}: expected at least one @@ chunk`)
      hunks.push({ type: "update", path: p, movePath, chunks: parsed.chunks })
      index = parsed.next
      continue
    }
    throw new Error(`Invalid patch line: ${line}`)
  }
  return hunks
}

function parseAdd(lines, start) {
  const content = []
  let index = start
  while (index < lines.length && !lines[index].startsWith("***")) {
    if (!lines[index].startsWith("+")) throw new Error(`Invalid add file line: ${lines[index]}`)
    content.push(lines[index].slice(1))
    index++
  }
  return { content: content.join("\n"), next: index }
}

function parseUpdate(lines, start) {
  const chunks = []
  let index = start
  while (index < lines.length && !lines[index].startsWith("***")) {
    if (!lines[index].startsWith("@@")) throw new Error(`Invalid update file line: ${lines[index]}`)
    const changeContext = lines[index].slice(2).trim() || undefined
    const oldLines = []
    const newLines = []
    let endOfFile = false
    index++
    while (index < lines.length && !lines[index].startsWith("@@")) {
      const line = lines[index]
      if (line === "*** End of File") {
        endOfFile = true
        index++
        break
      }
      if (line.startsWith("***")) break
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith("-")) oldLines.push(line.slice(1))
      else if (line.startsWith("+")) newLines.push(line.slice(1))
      else throw new Error(`Invalid update chunk line: ${line}`)
      index++
    }
    chunks.push({ oldLines, newLines, changeContext, endOfFile: endOfFile || undefined })
  }
  return { chunks, next: index }
}

// 照搬 patch.ts computeReplacements + derive
function computeReplacements(lines, filePath, chunks) {
  const replacements = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seek(lines, [chunk.changeContext], lineIndex)
      if (context === -1) throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`)
      lineIndex = context + 1
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines])
      continue
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let found = seek(lines, oldLines, lineIndex, chunk.endOfFile)
    if (found === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1)
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1)
      found = seek(lines, oldLines, lineIndex, chunk.endOfFile)
    }
    if (found === -1) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`)
    }
    replacements.push([found, oldLines.length, newLines])
    lineIndex = found + oldLines.length
  }
  return replacements.sort((l, r) => l[0] - r[0])
}

function derivePatch(filePath, chunks, original) {
  const source = splitBom(original)
  const lines = source.text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const replacements = computeReplacements(lines, filePath, chunks)
  const updated = [...lines]
  for (const [start, remove, insert] of [...replacements].reverse()) updated.splice(start, remove, ...insert)
  if (updated.at(-1) !== "") updated.push("")
  const next = splitBom(updated.join("\n"))
  return { content: next.text, bom: source.bom || next.bom }
}

const applyPatchTool = {
  name: "apply_patch",
  description:
    "Apply one patch containing add, update, and delete file operations. All targets are resolved and approved before target contents are read. Operations apply sequentially; if a later operation fails, earlier operations remain applied and the failure reports them explicitly. Moves and atomic rollback are not supported yet.",
  parameters: {
    type: "object",
    properties: {
      patchText: { type: "string", description: "The full patch text describing add, update, and delete operations" },
    },
    required: ["patchText"],
  },
  async execute({ patchText }, ctx) {
    const applied = []
    const appliedSummary = () =>
      applied.length === 0 ? "" : ` Applied: ${applied.map((i) => i.resource).join(", ")}.`
    try {
      if (!patchText.trim()) return "patchText is required"
      const hunks = parsePatch(patchText)
      if (hunks.length === 0) return "patch rejected: empty patch"
      const move = hunks.find((h) => h.type === "update" && h.movePath !== undefined)
      if (move) return "apply_patch moves are not supported yet"

      for (const hunk of hunks) {
        const absolute = path.isAbsolute(hunk.path) ? hunk.path : path.resolve(ctx.cwd, hunk.path)
        if (hunk.type === "add") {
          const content =
            hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`
          await fsp.mkdir(path.dirname(absolute), { recursive: true })
          await fsp.writeFile(absolute, content, "utf8")
          applied.push({ type: "add", resource: absolute })
          continue
        }
        let original
        try {
          original = await fsp.readFile(absolute, "utf8")
        } catch {
          return `Unable to apply patch at ${absolute}${appliedSummary()}`
        }
        if (hunk.type === "delete") {
          await fsp.unlink(absolute)
          applied.push({ type: "delete", resource: absolute })
          continue
        }
        // update
        const before = original.replace(/^\uFEFF/, "")
        const update = derivePatch(hunk.path, hunk.chunks, original)
        await fsp.writeFile(absolute, update.bom ? `\uFEFF${update.content}` : update.content, "utf8")
        applied.push({ type: "update", resource: absolute })
      }

      // 照搬 toModelOutput 的格式
      const lines = ["Applied patch sequentially:"]
      for (const item of applied) {
        lines.push(`${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`)
      }
      return lines.join("\n")
    } catch (err) {
      const prefix = `Unable to apply patch${appliedSummary()}`
      return `${prefix}\n${err.message}`
    }
  },
}

// ============================================================
// webfetch —— 照搬 core/src/tool/webfetch.ts 的语义
// (Accept 头 / 浏览器 UA / 5MB 上限 / 超时 / mime 过滤 / script-style 跳过)
// HTML→Markdown 用纯 JS 实现(原版用 htmlparser2 + turndown,这里零依赖替代)
// ============================================================

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120

// 照搬 acceptHeader / headers / browserUserAgent
const acceptHeader = (format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
  return "*/*"
}

const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

const webfetchTool = {
  name: "webfetch",
  description: `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.`,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The HTTP or HTTPS URL to fetch content from" },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "The format to return the content in. Defaults to markdown.",
      },
      timeout: {
        type: "number",
        description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
      },
    },
    required: ["url"],
  },
  async execute({ url, format = "markdown", timeout }, ctx) {
    try {
      // 照搬 assertHttpUrl
      const parsed = new URL(url)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `Unable to fetch ${url}: URL must use http:// or https://`
      }

      const ctrl = new AbortController()
      const seconds = Math.min(timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
      const timer = setTimeout(() => ctrl.abort(), seconds * 1000)

      let res
      try {
        res = await fetch(url, {
          headers: {
            "User-Agent": browserUserAgent,
            Accept: acceptHeader(format),
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
          signal: ctrl.signal,
        })
      } catch (err) {
        return `Unable to fetch ${url}: ${err.message}`
      } finally {
        clearTimeout(timer)
      }

      const contentType = res.headers.get("content-type") ?? ""
      const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
      // 照搬 isImageAttachment / isTextualMime
      if (mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet") {
        return `Unable to fetch ${url}: Unsupported fetched image content type: ${mime}`
      }
      const textual =
        !mime ||
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime.endsWith("+json") ||
        mime === "application/xml" ||
        mime.endsWith("+xml") ||
        mime === "application/javascript" ||
        mime === "application/x-javascript"
      if (!textual) {
        return `Unable to fetch ${url}: Unsupported fetched file content type: ${mime}`
      }

      // 照搬 collectBoundedResponseBody:5MB 上限
      const reader = res.body.getReader()
      const chunks = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > MAX_RESPONSE_BYTES) {
          return `Unable to fetch ${url}: Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`
        }
        chunks.push(value)
      }
      const body = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      const content = body.toString("utf8")

      // 照搬 convert:非 HTML 直接返回;HTML 按 format 转换
      let output = content
      if (contentType.includes("text/html")) {
        if (format === "markdown") output = convertHTMLToMarkdown(content)
        else if (format === "text") output = extractTextFromHTML(content)
      }
      return output
    } catch (err) {
      return `Unable to fetch ${url}: ${err.message}`
    }
  },
}

// 照搬 webfetch.ts extractTextFromHTML:跳过 script/style/noscript/iframe/object/embed
function extractTextFromHTML(html) {
  let text = ""
  let skipDepth = 0
  const skip = new Set(["script", "style", "noscript", "iframe", "object", "embed"])
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g
  let last = 0
  let m
  while ((m = re.exec(html))) {
    const closing = m[1] === "/"
    const tag = m[2].toLowerCase()
    if (skipDepth === 0) text += html.slice(last, m.index)
    if (closing) {
      if (skipDepth > 0) skipDepth--
    } else if (skipDepth > 0 || skip.has(tag)) {
      skipDepth++
    }
    last = re.lastIndex
  }
  if (skipDepth === 0) text += html.slice(last)
  return text.replace(/\s+/g, " ").trim()
}

// HTML→Markdown 的零依赖替代(原版 turndown 的常用子集)
function inline(s) {
  return s
    .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => `[${txt.replace(/<[^>]*>/g, "").trim()}](${href})`)
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, "![$2]($1)")
    .replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi, "![$1]($2)")
    .replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, "![]($1)")
    .replace(/<[^>]*>/g, "")
}

function convertHTMLToMarkdown(html) {
  // 照搬 turndown.remove(["script", "style", "meta", "link"])
  let h = html.replace(/<(script|style|meta|link|noscript|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
  h = h.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => `${"#".repeat(+n)} ${inline(inner).trim()}\n\n`)
  h = h.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\`\`\`\n${c.replace(/<[^>]*>/g, "").trim()}\n\`\`\`\n\n`)
  h = h.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c) => `> ${inline(c).trim()}\n\n`)
  h = h.replace(/<hr[^>]*\/?>/gi, "---\n\n")
  h = h.replace(/<br\s*\/?>/gi, "\n")
  h = h.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, c) =>
    `${[...c.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => `- ${inline(m[1]).trim()}`).join("\n")}\n\n`,
  )
  h = h.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, c) =>
    `${[...c.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m, i) => `${i + 1}. ${inline(m[1]).trim()}`).join("\n")}\n\n`,
  )
  h = h.replace(/<(p|div)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, c) => `${inline(c).trim()}\n\n`)
  h = inline(h)
  return h.replace(/\n{3,}/g, "\n\n").trim()
}

// ============================================================
// 构建注册表
// ============================================================

export function buildTools(config) {
  const reg = makeRegistry()
  for (const t of [bashTool, readTool, writeTool, grepTool, globTool, applyPatchTool, webfetchTool]) {
    reg.register(t)
  }
  return reg
}

export {
  bashTool,
  readTool,
  writeTool,
  grepTool,
  globTool,
  applyPatchTool,
  webfetchTool,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  isIgnored,
  globToRegExp,
  extractTextFromHTML,
  convertHTMLToMarkdown,
}
