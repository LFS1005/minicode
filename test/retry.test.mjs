// 重试机制测试:验证 agent 对 429/5xx/网络层故障自动重试(照搬 opencode retry.ts)
// 运行: node test/retry.test.mjs

import http from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Agent } from "../src/agent.js"
import { buildTools } from "../src/tools.js"
import { delay, retryable, RETRY_MAX_RETRIES } from "../src/retry.js"

const PORT = 18788
const BASE = `http://127.0.0.1:${PORT}/v1`

const results = []
const check = (name, cond) => {
  results.push([name, cond])
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`)
}

// ---------- 纯函数测试:retryable() ----------
{
  check("5xx 可重试", !!retryable({ status: 500, message: "internal error" }))
  check("429 可重试", !!retryable({ status: 429, message: "rate limit" }))
  check("fetch failed 可重试", !!retryable({ message: "请求失败: fetch failed" }))
  check("timeout 可重试", !!retryable({ message: "请求超时(request timeout,超过 120000 ms)" }))
  check("connection refused 可重试", !!retryable({ message: "请求失败: connect ECONNREFUSED" }))
  check("401 不可重试", !retryable({ status: 401, message: "invalid api key" }))
  check("400 不可重试", !retryable({ status: 400, message: "bad request" }))
  check("403 不可重试", !retryable({ status: 403, message: "forbidden" }))
  check("普通错误不可重试", !retryable({ message: "some random error" }))
}

// ---------- 纯函数测试:delay() ----------
{
  const d1 = delay(1, undefined, 0) // 无头:初始 2s + 0 抖动
  check("无头第 1 次 = 2s", d1 === 2000)
  const d2 = delay(2, undefined, 0) // 2 * 2^1 = 4s
  check("无头第 2 次 = 4s", d2 === 4000)
  const d3 = delay(3, undefined, 0) // 2 * 2^2 = 8s
  check("无头第 3 次 = 8s", d3 === 8000)
  const capped = delay(10, undefined, 0) // 超过 30s 上限
  check("无头上限 30s", capped === 30_000)
  const viaHeader = delay(2, { headers: { "retry-after": "3" } }, 0)
  check("retry-after 秒生效", viaHeader === 3000)
  const viaHeaderMs = delay(2, { headers: { "retry-after-ms": "1500" } }, 0)
  check("retry-after-ms 生效", viaHeaderMs === 1500)
  const jitter = delay(1, undefined, 1)
  check("抖动: 2000 + 2000*0.25*1 = 2500", jitter === 2500)
}

// ---------- 集成测试:假服务器 429 两次后成功 ----------
{
  let requestCount = 0
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      requestCount++
      if (requestCount <= 2) {
        // 前两次返回 429(带 retry-after 头)
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" })
        res.end(JSON.stringify({ error: { message: "Rate limit reached. Please retry." } }))
        return
      }
      const payload = JSON.parse(body)
      if (payload.messages?.at(-1)?.role === "user" && requestCount === 3) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "重试成功后回复" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
          "data: [DONE]\n\n",
        ]
        res.end(chunks.join(""))
      } else {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.end("data: [DONE]\n\n")
      }
    })
  })

  const retryEvents = []
  await new Promise((r) => server.listen(PORT, r))
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "lite-retry-"))
    const config = {
      baseUrl: BASE,
      apiKey: "test-key",
      model: "test-model",
      shell: process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh",
      maxTurns: 5,
      timeout: 10_000,
    }
    const tools = buildTools(config)
    const agent = new Agent({ config, tools, cwd: dir })
    const { response, messages } = await agent.run(Agent.newMessages(dir), "重试测试", {
      onText: () => {},
      onToolCall: () => {},
      onEvent: (e) => {
        if (e.type === "session.status" && e.status?.type === "retry") retryEvents.push(e.status)
      },
    })

    check("429 后自动重试成功", response === "重试成功后回复")
    check("共请求 3 次(2 次 429 + 1 次成功)", requestCount === 3)
    check("emit 了 2 个 retry 事件", retryEvents.length === 2)
    check("retry 事件带 attempt 序号", retryEvents[0]?.attempt === 1 && retryEvents[1]?.attempt === 2)
    check("retry 事件带 message", retryEvents[0]?.message.includes("Rate limit"))
    check("retry 事件带 next 时间", typeof retryEvents[0]?.next === "number" && retryEvents[0].next > Date.now() - 1000)
    check("消息不含重复文本", messages.filter((m) => m.role === "assistant").at(-1)?.content === "重试成功后回复")
  } finally {
    server.close()
  }
}

// ---------- 集成测试:500 一次后成功 ----------
{
  let requestCount = 0
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      requestCount++
      if (requestCount === 1) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: "Internal server error" } }))
        return
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "500 重试成功" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]
      res.end(chunks.join(""))
    })
  })

  await new Promise((r) => server.listen(PORT + 1, r))
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "lite-retry-500-"))
    const config = {
      baseUrl: `http://127.0.0.1:${PORT + 1}/v1`,
      apiKey: "test-key",
      model: "test-model",
      shell: process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh",
      maxTurns: 5,
      timeout: 10_000,
    }
    const tools = buildTools(config)
    const agent = new Agent({ config, tools, cwd: dir })
    const { response } = await agent.run(Agent.newMessages(dir), "500 测试", {
      onText: () => {},
      onToolCall: () => {},
    })
    check("500 后自动重试成功", response === "500 重试成功")
    check("500 场景共请求 2 次", requestCount === 2)
  } finally {
    server.close()
  }
}

// ---------- 集成测试:流式中断(连接重置)后重试,文本不重复 ----------
{
  let requestCount = 0
  const server = http.createServer((req, res) => {
    req.on("data", () => {})
    req.on("end", () => {
      requestCount++
      if (requestCount === 1) {
        // 第一次:流式输出一半后连接中断(res 提前销毁)
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "半截" } }] })}\n\n`)
        res.destroy()
        return
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "完整回复" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]
      res.end(chunks.join(""))
    })
  })

  await new Promise((r) => server.listen(PORT + 3, r))
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "lite-retry-stream-"))
    const config = {
      baseUrl: `http://127.0.0.1:${PORT + 3}/v1`,
      apiKey: "test-key",
      model: "test-model",
      shell: process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh",
      maxTurns: 5,
      timeout: 10_000,
    }
    const tools = buildTools(config)
    const agent = new Agent({ config, tools, cwd: dir })
    let streamed = ""
    let resetCount = 0
    const { response, messages } = await agent.run(Agent.newMessages(dir), "流式中断测试", {
      onText: (t) => (streamed += t),
      onToolCall: () => {},
      onRetry: () => resetCount++,
    })
    check("流式中断后重试成功", response === "完整回复")
    check("onRetry 被调用一次", resetCount === 1)
    check("流式文本不重复(无半截残留)", !streamed.includes("半截完整"))
    check("最终消息文本正确", messages.filter((m) => m.role === "assistant").at(-1)?.content === "完整回复")
  } finally {
    server.close()
  }
}

// ---------- 集成测试:不可重试错误(401)直接失败 ----------
{
  let requestCount = 0
  const server = http.createServer((req, res) => {
    req.on("data", () => {})
    req.on("end", () => {
      requestCount++
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Incorrect API key" } }))
    })
  })

  await new Promise((r) => server.listen(PORT + 2, r))
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "lite-retry-401-"))
    const config = {
      baseUrl: `http://127.0.0.1:${PORT + 2}/v1`,
      apiKey: "bad-key",
      model: "test-model",
      shell: process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh",
      maxTurns: 5,
      timeout: 10_000,
    }
    const tools = buildTools(config)
    const agent = new Agent({ config, tools, cwd: dir })
    let threw = false
    try {
      await agent.run(Agent.newMessages(dir), "401 测试", { onText: () => {}, onToolCall: () => {} })
    } catch (err) {
      threw = err.message.includes("401")
    }
    check("401 直接抛错(不重试)", threw)
    check("401 只请求 1 次", requestCount === 1)
  } finally {
    server.close()
  }
}

// ---------- 集成测试:用户按 Esc 中断 agent(signal.abort) ----------
{
  let requestCount = 0
  const server = http.createServer((req, res) => {
    req.on("data", () => {})
    req.on("end", () => {
      requestCount++
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      // 流式输出一部分后挂起,等待客户端取消
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "开头" } }] })}\n\n`)
      // 不结束:模拟长回复,让测试中途 abort
    })
  })

  await new Promise((r) => server.listen(PORT + 4, r))
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "lite-retry-abort-"))
    const config = {
      baseUrl: `http://127.0.0.1:${PORT + 4}/v1`,
      apiKey: "test-key",
      model: "test-model",
      shell: process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh",
      maxTurns: 5,
      timeout: 30_000, // 大于测试取消时间,确保是 signal 触发而非超时
    }
    const tools = buildTools(config)
    const agent = new Agent({ config, tools, cwd: dir })
    const ctrl = new AbortController()
    // 300ms 后模拟用户按 Esc
    const timer = setTimeout(() => ctrl.abort(), 300)
    const { messages, cancelled, response } = await agent.run(
      Agent.newMessages(dir),
      "长任务测试",
      { onText: () => {}, onToolCall: () => {} },
      { signal: ctrl.signal },
    )
    clearTimeout(timer)
    check("Esc 中断后 cancelled 为 true", cancelled === true)
    check("中断后不抛错(正常返回)", response === "" || typeof response === "string")
    check("中断后会话仍保留 user 消息", messages.some((m) => m.role === "user" && m.content === "长任务测试"))
    check("中断不触发重试(请求仅 1 次)", requestCount === 1)
  } finally {
    server.close()
  }
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
