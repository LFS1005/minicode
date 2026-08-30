// TUI 工具操作详情 + token 用量统计端到端验证
// 假服务器依次返回:bash → read → write → 最终文本,带 usage
// 运行: node test/toolview-e2e.mjs (无 winpty 时 SKIP)

import http from "node:http"
import { spawn, execSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PORT = 18784
const BASE = `http://127.0.0.1:${PORT}/v1`

const tools = [
  { id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo build-ok" }) } },
  { id: "c2", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "src/agent.js" }) } },
  { id: "c3", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "out.txt", content: "hello world" }) } },
]

let requestCount = 0
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    requestCount++
    const chunks = []
    if (requestCount === 1) {
      // 三个工具并行调用
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: tools } }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 500, completion_tokens: 40 } })}\n\n`)
    } else {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "全部完成" } }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 700, completion_tokens: 60 } })}\n\n`)
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

let pty = null
try {
  execSync("where winpty", { stdio: "ignore" })
  pty = { bin: "winpty", args: ["-Xallow-non-tty"] }
} catch {}

if (!pty) {
  console.log("SKIP: 无 winpty")
  server.close()
  process.exit(0)
}

try {
  const dir = mkdtempSync(path.join(tmpdir(), "lite-toolview-"))
  const entry = path.resolve("src/index.js")
  const env = {
    ...process.env,
    MINICODE_BASE_URL: BASE,
    MINICODE_MODEL: "test-model",
    MINICODE_SESSION_DIR: dir,
  }
  const child = spawn(pty.bin, [...pty.args, process.execPath, entry], { env })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  child.stderr.on("data", (d) => (out += d))

  const waitFor = (needle, timeout = 10000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (out.includes(needle)) {
          clearInterval(iv)
          resolve()
        } else if (Date.now() - t0 > timeout) {
          clearInterval(iv)
          reject(new Error(`等不到: ${needle};尾部: ${JSON.stringify(out.slice(-200))}`))
        }
      }, 100)
    })

  await waitFor("新会话")
  child.stdin.write("跑一下测试\n")
  await waitFor("全部完成", 12000)
  await new Promise((r) => setTimeout(r, 800))

  // 工具详情展示
  check("bash 显示执行的命令", out.includes("$ echo build-ok"))
  check("read 显示读取的文件", out.includes("src/agent.js"))
  check("write 显示写入的文件", out.includes("out.txt"))
  check("write 显示字符数", out.includes("字符"))
  check("bash 显示工具完成标记", out.includes("✓"))
  check("bash 显示命令输出", out.includes("build-ok"))

  // token 用量统计:winpty 会把帧边界处的 corner 拆开(EL 序列插在 use 和 d 之间),
  // 所以断言 "used" 或被拆开的 "use\x1b[0Kd" 模式——验证 usage 确实渲染到了 corner
  const usedSeen = /use\S{0,8}d/.test(out) || out.includes("used")
  check("用量统计下角显示 k used 格式", usedSeen)

  child.stdin.write("\u0003")
  await new Promise((r) => setTimeout(r, 300))
  child.kill()
} finally {
  server.close()
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
