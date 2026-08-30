// TUI 端到端冒烟:winpty(或 script)伪终端 + 本地假 OpenAI 服务器
// 验证真实 TTY 下:渲染、流式文本、工具状态、退出
// 运行: node test/tui-e2e.mjs

import http from "node:http"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const PORT = 18779
const BASE = `http://127.0.0.1:${PORT}/v1`

let requestCount = 0
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    requestCount++
    const chunks = []
    if (requestCount === 1) {
      // 第一轮:工具调用 bash
      const toolCall = {
        id: "call_1",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: "echo tui-works" }) },
      }
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`)
    } else {
      // 第二轮:最终文本
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "TUI 流式文本输出" } }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
    }
    chunks.push("data: [DONE]\n\n")
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(chunks.join(""))
  })
})

await new Promise((r) => server.listen(PORT, r))

const results = []
const check = (name, cond) => {
  results.push([name, cond])
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`)
}

// 找 pty 包装器:winpty(Windows,需 -Xallow-non-tty)或 script(POSIX)
function findPty() {
  if (process.platform === "win32") {
    try {
      execSync("where winpty", { stdio: "ignore" })
      return { bin: "winpty", args: ["-Xallow-non-tty"] }
    } catch {}
    return null
  }
  try {
    execSync("which script", { stdio: "ignore" })
    return { bin: "script", args: ["-q", "-c"] }
  } catch {}
  return null
}

const pty = findPty()
if (!pty) {
  console.log("SKIP: 无 winpty/script,跳过 TUI 端到端(单元测试已覆盖渲染与按键)")
  server.close()
  process.exit(0)
}

try {
  const dir = mkdtempSync(path.join(tmpdir(), "lite-tui-e2e-"))
  const entry = fileURLToPath(new URL("../src/index.js", import.meta.url))
  const env = {
    ...process.env,
    MINICODE_BASE_URL: BASE,
    MINICODE_MODEL: "test-model",
    MINICODE_SESSION_DIR: dir,
  }

  const fullCmd = [process.execPath, entry]
  const child = spawn(pty.bin, [...pty.args, ...(pty.bin === "script" ? [fullCmd.join(" ")] : fullCmd)], {
    env,
  })

  let output = ""
  const all = (d) => (output += String(d))

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TUI 启动超时")), 8000)
    child.stdout.on("data", (d) => {
      all(d)
      // 等提示符出现
      if (output.includes(">")) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on("error", reject)
  })

  // 发送一条消息 + 回车
  child.stdin.write("测试\n")
  await new Promise((r) => setTimeout(r, 4000))
  child.stdin.write("\u0003") // Ctrl+C 退出
  await new Promise((r) => setTimeout(r, 500))
  child.kill()

  check("渲染了模型 banner", output.includes("test-model"))
  check("渲染了流式文本", output.includes("TUI 流式文本输出"))
  // 工具状态现在显示命令摘要(参照 opencode tool.ts 的 bash 展示规则)
  check("渲染了工具命令摘要", output.includes("$ echo tui-works"))
} finally {
  server.close()
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
