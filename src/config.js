// 配置:优先级 环境变量 > 配置文件 > 默认值
// 环境变量:MINICODE_* 优先,兼容 OPENAI_*(行业标准)作为后备

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CONFIG_PATHS = [
  path.join(os.homedir(), ".config", "minicode", "config.json"),
  path.join(os.homedir(), ".minicode", "config.json"),
  path.join(process.cwd(), "minicode.json"),
]

function loadFile() {
  for (const p of CONFIG_PATHS) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"))
    } catch {}
  }
  return {}
}

function first(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v
  }
  return undefined
}

export function loadConfig(overrides = {}) {
  const file = loadFile()
  const base = first(
    overrides.baseUrl,
    process.env.MINICODE_BASE_URL,
    process.env.OPENAI_BASE_URL,
    file.baseUrl,
    "https://api.openai.com/v1",
  )
  const key = first(
    overrides.apiKey,
    process.env.MINICODE_API_KEY,
    process.env.OPENAI_API_KEY,
    file.apiKey,
  )
  const model = first(
    overrides.model,
    process.env.MINICODE_MODEL,
    process.env.OPENAI_MODEL,
    file.model,
    "gpt-4o-mini",
  )
  return {
    baseUrl: base.replace(/\/+$/, ""),
    apiKey: key ?? "",
    model,
    shell: first(overrides.shell, process.env.MINICODE_SHELL, file.shell, defaultShell()),
    maxTurns: Number(first(overrides.maxTurns, file.maxTurns, 25)),
    timeout: Number(first(overrides.timeout, file.timeout, 120_000)),
    sessionDir: first(
      overrides.sessionDir,
      process.env.MINICODE_SESSION_DIR,
      file.sessionDir,
      path.join(os.homedir(), ".minicode", "sessions"),
    ),
  }
}

function defaultShell() {
  if (process.platform === "win32") return "bash"
  return "/bin/bash"
}

// 用户级配置文件路径(配置向导写入的目标)
export function userConfigPath() {
  return path.join(os.homedir(), ".config", "minicode", "config.json")
}

// 保存配置到用户级配置文件,保留已有字段
// 返回写入的文件路径
export function saveConfig(partial) {
  const file = userConfigPath()
  let existing = {}
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {}
  const next = { ...existing, ...partial }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8")
  return file
}

export function checkConfig(cfg) {
  // 本地端点(Ollama / vLLM 等)不需要 API Key
  const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])/i.test(cfg.baseUrl)
  if (!cfg.apiKey && !local) {
    console.error(
      "缺少 API Key。请设置环境变量 MINICODE_API_KEY(或 OPENAI_API_KEY),或写入 ~/.config/minicode/config.json",
    )
    return false
  }
  return true
}
