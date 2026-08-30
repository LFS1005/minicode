// 冒烟测试:本地假 OpenAI 服务器,验证 agent 循环 + 工具调用 + 消息回填
// 运行: node test/smoke.test.mjs

import http from "node:http"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Agent } from "../src/agent.js"
import { buildTools } from "../src/tools.js"

const PORT = 18777
const BASE = `http://127.0.0.1:${PORT}/v1`

let requestCount = 0
const received = [] // 记录每次请求的 messages

// 假服务器:第一次响应工具调用(write),第二次响应最终文本
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    const payload = JSON.parse(body)
    received.push(payload.messages)
    requestCount++
    const chunks = []
    if (requestCount === 1) {
      const toolCall = {
        id: "call_1",
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: "hello.txt", content: "hi from tool\n" }) },
      }
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`)
    } else {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "完成,已写入 hello.txt" } }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 130, completion_tokens: 30 } })}\n\n`)
    }
    chunks.push("data: [DONE]\n\n")
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
  // 用临时目录模拟项目
  const dir = mkdtempSync(path.join(tmpdir(), "lite-smoke-"))

  const config = {
    baseUrl: BASE,
    apiKey: "test-key",
    model: "test-model",
    shell: process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh",
    maxTurns: 10,
    timeout: 10_000,
  }
  const tools = buildTools(config)
  const agent = new Agent({ config, tools, cwd: dir })

  const events = []
  const { messages, response } = await agent.run(Agent.newMessages(dir), "创建 hello.txt", {
    onText: () => {},
    onToolCall: () => {},
    onEvent: (e) => events.push(e),
  })

  // 事件流(参照 opencode run.ts 的事件模型)
  const eventTypes = events.map((e) => e.type)
  check("事件含 step_start", eventTypes.includes("step_start"))
  check("事件含 message.updated", eventTypes.includes("message.updated"))
  const toolEvents = events.filter((e) => e.type === "message.part.updated" && e.part?.type === "tool")
  check("工具 running 事件", toolEvents.some((e) => e.part.status === "running" && e.part.tool === "write"))
  check("工具 completed 事件", toolEvents.some((e) => e.part.status === "completed" && e.part.tool === "write"))
  check("工具事件携带输入参数", toolEvents.some((e) => e.part.input?.path === "hello.txt"))
  const usageEvents = events.filter((e) => e.type === "usage")
  check("usage 事件上报 token 统计", usageEvents.length === 2)
  check("usage 累计输入 230", usageEvents.at(-1)?.input === 230)
  check("usage 累计输出 50", usageEvents.at(-1)?.output === 50)
  check("idle 事件携带 usage", events.find((e) => e.type === "session.status")?.usage?.input === 230)
  check("text part 事件", events.some((e) => e.type === "message.part.updated" && e.part?.type === "text"))
  check("idle 状态事件", eventTypes.includes("session.status") && events.find((e) => e.type === "session.status")?.status?.type === "idle")

  // 1. 服务器被调用两次(工具轮 + 最终轮)
  check("服务器调用两次", requestCount === 2)

  // 2. 工具调用被正确回填:第二轮的 messages 里应含 assistant tool_calls + tool 消息
  const second = received[1]
  const hasToolCall = second.some((m) => m.role === "assistant" && m.tool_calls?.length === 1)
  const hasToolResult = second.some((m) => m.role === "tool" && m.content.includes("hello.txt"))
  check("assistant 消息含 tool_calls", hasToolCall)
  check("tool 结果已回填", hasToolResult)

  // 3. 工具真正执行:文件已创建
  check("write 工具创建了文件", existsSync(path.join(dir, "hello.txt")))
  check("文件内容正确", readFileSync(path.join(dir, "hello.txt"), "utf8") === "hi from tool\n")

  // 4. 最终回复
  check("最终回复正确", response === "完成,已写入 hello.txt")

  // 5. 消息结构:system 开头,user/assistant/tool 顺序正确
  const roles = messages.map((m) => m.role)
  check("消息顺序 system→user→assistant→tool→assistant", JSON.stringify(roles) === JSON.stringify(["system", "user", "assistant", "tool", "assistant"]))
} finally {
  server.close()
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
