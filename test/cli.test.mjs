// CLI 集成测试:验证 stderr/stdout 分离与 --format json 事件流
// 运行: node test/cli.test.mjs

import http from "node:http"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PORT = 18778
const BASE = `http://127.0.0.1:${PORT}/v1`

const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "你好,这是最终答复" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(chunks.join(""))
  })
})

const results = []
const check = (name, cond) => {
  results.push([name, cond])
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`)
}

await new Promise((r) => server.listen(PORT, r))

try {
  const dir = mkdtempSync(path.join(tmpdir(), "lite-cli-"))
  const entry = fileURLToPath(new URL("../src/index.js", import.meta.url))

  // ---------- --format json:stdout 应是 JSON Lines,stderr 是 UI ----------
  const env = {
    ...process.env,
    MINICODE_BASE_URL: BASE,
    MINICODE_MODEL: "test-model",
    MINICODE_SESSION_DIR: dir,
  }
  const jsonRun = await runCli(entry, ["-y", "--format", "json", "打招呼"], env)
  const stdoutLines = jsonRun.stdout.trim().split("\n").filter(Boolean)
  const allJson = stdoutLines.every((l) => {
    try {
      JSON.parse(l)
      return true
    } catch {
      return false
    }
  })
  check("json 模式 stdout 全是合法 JSON 行", allJson && stdoutLines.length > 0)
  const types = stdoutLines.map((l) => JSON.parse(l).type)
  check("json 流含 message.part.updated(text)", types.includes("message.part.updated"))
  check("json 流含 session.status idle", types.some((t) => {
    const e = JSON.parse(stdoutLines[types.indexOf(t)])
    return t === "session.status" && e.status?.type === "idle"
  }))
  check("json 模式 UI 状态走 stderr", jsonRun.stderr.includes("模型:"))

  // ---------- 默认模式:最终文本走 stdout,状态走 stderr ----------
  const defRun = await runCli(entry, ["-y", "打招呼"], env)
  check("默认模式最终文本在 stdout", defRun.stdout.includes("你好,这是最终答复"))
  check("默认模式状态在 stderr", defRun.stderr.includes("模型:"))
} finally {
  server.close()
}

function runCli(entry, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
