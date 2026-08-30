// 配置向导端到端:winpty 伪终端验证 /config 表单、编辑、测试连接、保存
// 运行: node test/config-e2e.mjs (无 winpty 时 SKIP)

import http from "node:http"
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"

const PORT = 18781
const BASE = `http://127.0.0.1:${PORT}/v1`

// 假服务器:响应任何 chat 请求(用于"测试连接")
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "pong" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]
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
  // 隔离 HOME,避免污染真实配置
  const fakeHome = mkdtempSync(path.join(tmpdir(), "lite-home-"))
  const entry = path.resolve("src/index.js")
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    MINICODE_BASE_URL: BASE,
    MINICODE_MODEL: "test-model",
    MINICODE_SESSION_DIR: path.join(fakeHome, ".minicode", "sessions"),
  }

  const child = spawn(pty.bin, [...pty.args, process.execPath, entry], { env })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  child.stderr.on("data", (d) => (out += d))

  const waitFor = (needle, timeout = 8000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (out.includes(needle)) {
          clearInterval(iv)
          resolve()
        } else if (Date.now() - t0 > timeout) {
          clearInterval(iv)
          reject(new Error(`等不到: ${needle};输出尾部: ${JSON.stringify(out.slice(-200))}`))
        }
      }, 100)
    })

  await waitFor("新会话")
  // 打开配置向导
  child.stdin.write("/config\n")
  await waitFor("配置 API")
  check("表单渲染标题", out.includes("配置 API"))
  check("表单渲染字段", out.includes("API 地址") && out.includes("API Key"))
  check("表单渲染动作", out.includes("测试连接"))

  // 先测连接(当前地址 = 假服务器,应成功):移到"测试连接"动作(字段 3 个 → 下 3 次)
  child.stdin.write("\x1b[B".repeat(3))
  child.stdin.write("\r")
  await new Promise((r) => setTimeout(r, 1500))
  check("测试连接结果(连的是假服务器,应成功)", out.includes("连接成功"))

  // 回字段 0 并编辑:上 3 次(每次间隔,避免 winpty 缓冲转义序列)→ 回车 → 等编辑态
  await waitFor("连接成功")
  for (let i = 0; i < 3; i++) {
    child.stdin.write("\x1b[A")
    await new Promise((r) => setTimeout(r, 120))
  }
  child.stdin.write("\r")
  await waitFor("> http") // 编辑态:输入行显示当前字段值
  const addrLen = BASE.length
  child.stdin.write("\x7f".repeat(addrLen + 2))
  const newAddr = "http://127.0.0.1:9999/v1"
  child.stdin.write(newAddr)
  child.stdin.write("\r")
  await new Promise((r) => setTimeout(r, 300))
  // 移到"保存并应用":actions 第 2 个(测试连接→下1)
  child.stdin.write("\x1b[B".repeat(3))
  child.stdin.write("\x1b[B")
  child.stdin.write("\r")
  await new Promise((r) => setTimeout(r, 800))
  check("保存提示", out.includes("已保存"))

  // 检查配置文件写入
  const cfgPath = path.join(fakeHome, ".config", "minicode", "config.json")
  const saved = JSON.parse(readFileSync(cfgPath, "utf8"))
  check("配置文件写入新地址", saved.baseUrl === "http://127.0.0.1:9999/v1")
  check("配置文件写入模型(未改,保留原值)", saved.model === "test-model")

  child.stdin.write("\u0003")
  await new Promise((r) => setTimeout(r, 400))
  child.kill()
} finally {
  server.close()
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
