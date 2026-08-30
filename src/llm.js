// 极简 OpenAI 兼容客户端:裸 fetch,支持流式 SSE 与工具调用
// 兼容 OpenAI / DeepSeek / 本地 Ollama / vLLM 等任何 /v1/chat/completions 服务

// 与 opencode session/message-v2.ts 的 APIError 对应:携带 status / headers / body
// 供 agent.js 的重试策略(retry.js)判定
// - 网络层错误:status = undefined,message 含 "fetch failed" 等可匹配模式
// - HTTP 错误:status = 状态码,headers / body 供 retry-after 退避
// - 超时:status = undefined,message 含 "timeout",可重试
export class LLMError extends Error {
  constructor(message, status, { headers, body } = {}) {
    super(message)
    this.name = "LLMError"
    this.status = status
    this.headers = headers
    this.body = body
  }
}

/**
 * 发起一次对话补全。
 * @param {object} opts
 * @param {string} opts.baseUrl  API 根地址,如 https://api.openai.com/v1
 * @param {string} opts.apiKey   Bearer token,可空(如本地 Ollama)
 * @param {string} opts.model    模型名
 * @param {Array}  opts.messages OpenAI messages 数组
 * @param {Array}  opts.tools    OpenAI tools 定义(可空)
 * @param {object} [opts.onDelta] 流式回调 { onText, onToolCall }
 * @param {number} [opts.timeout] 超时毫秒
 * @returns {Promise<{content: string, toolCalls: Array|null, usage: object|null}>} 最终 assistant 消息
 */
export async function chat({ baseUrl, apiKey, model, messages, tools, onDelta, timeout = 120_000 }) {
  const body = {
    model,
    messages,
    stream: true,
  }
  if (tools?.length) body.tools = tools

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  let res
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (err) {
    // 网络层错误:对齐 opencode 的 ECONNRESET/fetch failed 处理,可重试
    const aborted = err?.name === "AbortError" || err?.code === "ABORT_ERR"
    // 超时消息含英文 "request timeout",匹配 opencode retry.ts 的可重试模式
    const message = aborted
      ? `请求超时(request timeout,超过 ${timeout} ms)`
      : `请求失败: ${err?.message ?? err}`
    throw new LLMError(message, undefined, { headers: {} })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // 照搬 error.ts message():保留状态码、响应头(retry-after)与响应体(错误详情)
    let detail = ""
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {}
    const headers = {}
    for (const [k, v] of res.headers.entries()) headers[k] = v
    throw new LLMError(`API 返回 ${res.status}: ${detail}`, res.status, { headers, body: detail })
  }

  return await consumeStream(res.body, onDelta)
}

async function consumeStream(body, onDelta) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  const toolCalls = []
  let usage = null
  let finishReason = null

  const flushLine = (line) => {
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    let json
    try {
      json = JSON.parse(payload)
    } catch {
      return
    }
    // usage 可能在独立 chunk 中返回(choices 为空数组),必须先于 choice 处理捕获
    if (json.usage) usage = json.usage
    const choice = json.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    if (delta.content) {
      content += delta.content
      onDelta?.onText?.(delta.content)
    }
    // OpenAI 工具调用:流式时是带 index 的增量 fragment(按 index 累加);
    // 某些兼容端点可能不带 index 且一次给全量(完整对象),此时按顺序放入空槽位
    if (delta.tool_calls) {
      const hasIndex = delta.tool_calls.some((f) => f.index !== undefined)
      for (const frag of delta.tool_calls) {
        const i = frag.index ?? nextFreeSlot(toolCalls)
        if (!hasIndex && frag.function?.name && frag.function?.arguments) {
          // 完整对象:整块写入,避免累加
          toolCalls[i] = {
            id: frag.id ?? "",
            type: "function",
            function: { name: frag.function.name, arguments: frag.function.arguments },
          }
          continue
        }
        toolCalls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } }
        if (frag.id) toolCalls[i].id += frag.id
        if (frag.function?.name) toolCalls[i].function.name += frag.function.name
        if (frag.function?.arguments) toolCalls[i].function.arguments += frag.function.arguments
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) flushLine(line)
  }
  if (buffer.trim()) flushLine(buffer)

  const validCalls = toolCalls
    .map((t) => {
      try {
        return { ...t, function: { ...t.function, arguments: JSON.parse(t.function.arguments || "{}") } }
      } catch {
        return null
      }
    })
    .filter(Boolean)

  // 非流式服务(某些兼容端点)可能整体返回;这里已按流式处理
  return {
    content,
    toolCalls: validCalls.length ? validCalls : null,
    finishReason,
    usage,
  }
}

// 找到第一个空槽位(无 index 的完整对象按顺序放置)
function nextFreeSlot(toolCalls) {
  for (let i = 0; ; i++) {
    if (toolCalls[i] === undefined) return i
  }
}
