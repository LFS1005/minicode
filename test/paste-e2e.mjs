// 真实 TUI 粘贴/中文输入验证:winpty 伪终端
// 运行: node test/paste-e2e.mjs
import http from "node:http"
import { spawn, execSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PORT = 18333
const BASE = `http://127.0.0.1:${PORT}/v1`

// 假服务器:第一轮直接返回最终文本
let requestCount = 0
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (d) => (body += d))
  req.on("end", () => {
    requestCount++
    const chunks = []
    if (requestCount === 1) {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "收到回复" } }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
    } else {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "再次回复" } }] })}\n\n`)
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

let pty = null
if (process.platform === "win32") {
  try {
    execSync("where winpty", { stdio: "ignore" })
    pty = { bin: "winpty", args: ["-Xallow-non-tty"] }
  } catch {}
} else {
  try {
    execSync("which script", { stdio: "ignore" })
    pty = { bin: "script", args: ["-q", "-c"] }
  } catch {}
}
if (!pty) {
  console.log("SKIP: 无 winpty/script")
  server.close()
  process.exit(0)
}

const dir = mkdtempSync(path.join(tmpdir(), "lite-paste-e2e-"))
const entry = fileURLToPath(new URL("../src/index.js", import.meta.url))
const env = {
  ...process.env,
  MINICODE_BASE_URL: BASE,
  MINICODE_MODEL: "test-model",
  MINICODE_SESSION_DIR: dir,
}

const fullCmd = [process.execPath, entry]
const child = spawn(pty.bin, [...pty.args, ...(pty.bin === "script" ? [fullCmd.join(" ")] : fullCmd)], { env })

let output = ""
const all = (d) => (output += String(d))
child.stdout.on("data", all)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("TUI 启动超时")), 8000)
  child.stdout.on("data", () => {
    if (output.includes(">")) {
      clearTimeout(timer)
      resolve()
    }
  })
  child.on("error", reject)
})

// 1) 输入中文,等渲染
child.stdin.write("你好")
await new Promise((r) => setTimeout(r, 500))
const afterCjk = output
check("中文进入输入行", afterCjk.includes("你好"))

// 2) 模拟 bracketed paste:多行内容包裹在标记内,不应触发提交
child.stdin.write("\u001b[200~echo hi\r\n第二行\u001b[201~")
await new Promise((r) => setTimeout(r, 500))
const afterPaste = output
check("粘贴文本进入输入行(换行转空格)", afterPaste.includes("echo hi 第二行"))
check("粘贴未触发发送", !afterPaste.includes("收到回复"))

// 3) 回车提交,应正常发送
child.stdin.write("\r")
await new Promise((r) => setTimeout(r, 2500))
check("回车后正常发送", output.includes("收到回复"))

// 4) 无标记终端:多行直接粘贴不触发发送
child.stdin.write("a\nb\nc")
await new Promise((r) => setTimeout(r, 500))
const afterMulti = output
check("无标记多行粘贴不发送", !afterMulti.includes("再次回复"))

child.stdin.write("\u0003")
await new Promise((r) => setTimeout(r, 500))
child.kill()
server.close()

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
