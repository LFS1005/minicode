// Agent 主循环:输入 → LLM → 工具调用 → 回填 → 继续,直到模型停止调用工具
// 消息结构遵循 OpenAI 格式,与 opencode 的 session 消息模型对应
// 事件模型参照 opencode cli/cmd/run.ts 的订阅事件:step_start / message.updated /
// message.part.updated(tool|text) / session.status idle / error

import { chat } from "./llm.js"
import { buildSystemPrompt } from "./prompt.js"

export class Agent {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {ReturnType<import("./tools.js").buildTools>} opts.tools 工具注册表
   * @param {string} opts.cwd 项目根目录
   */
  constructor({ config, tools, cwd }) {
    this.config = config
    this.tools = tools
    this.cwd = cwd
  }

  /**
   * 执行一轮完整对话(可包含多次工具调用)。
   * @param {Array} history 之前的 OpenAI messages(不含本轮 user 消息)
   * @param {string} userInput 用户输入
   * @param {object} [callbacks] { onText, onToolCall, onEvent }
   *   onEvent: (event) => void,事件与 opencode run.ts 对齐:
   *     { type: "step_start", turn }
   *     { type: "message.updated", agent, modelID }
   *     { type: "message.part.updated", part: { type:"tool", tool, status:"running"|"completed"|"error", output?, error? } }
   *     { type: "message.part.updated", part: { type:"text", text } }
   *     { type: "session.status", status: { type: "idle" } }
   *     { type: "error", error: string }
   * @returns {Promise<{messages: Array, response: string}>} 更新后的完整消息列表与最终回复
   */
  async run(history, userInput, callbacks = {}) {
    const { onEvent } = callbacks
    const emit = (event) => onEvent?.(event)

    const messages = [...history]
    messages.push({ role: "user", content: userInput })

    let finalText = ""
    let turns = 0
    let error
    // token 用量统计(参照 opencode projector.ts 的 usage 统计)
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheRead = 0

    for (;;) {
      if (++turns > this.config.maxTurns) {
        error = `已达最大工具调用轮数(${this.config.maxTurns}),已停止。`
        emit({ type: "error", error })
        break
      }

      emit({ type: "step_start", turn: turns })
      emit({ type: "message.updated", agent: "build", modelID: this.config.model })

      const result = await chat({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages,
        tools: this.tools.definitions(),
        timeout: this.config.timeout,
        onDelta: {
          onText: (t) => {
            callbacks.onText?.(t)
            finalText += t
          },
          onToolCall: (c) => callbacks.onToolCall?.(c),
        },
      })

      messages.push({
        role: "assistant",
        content: result.content || null,
        ...(result.toolCalls
          ? {
              tool_calls: result.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) },
              })),
            }
          : {}),
      })

      // 统计本轮 token 用量(兼容 OpenAI 新旧两种 usage 字段)
      const u = result.usage ?? {}
      const deltaIn = u.input_tokens ?? u.prompt_tokens ?? 0
      const deltaOut = u.output_tokens ?? u.completion_tokens ?? 0
      const deltaCache = u.prompt_tokens_details?.cached_tokens ?? 0
      totalInputTokens += deltaIn
      totalOutputTokens += deltaOut
      totalCacheRead += deltaCache
      emit({
        type: "usage",
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheRead: totalCacheRead,
        deltaInput: deltaIn,
        deltaOutput: deltaOut,
      })

      if (!result.toolCalls || result.toolCalls.length === 0) {
        // 模型不再调用工具,本轮结束;已流式输出的文本作为最终 text part 上报
        emit({ type: "message.part.updated", part: { type: "text", text: finalText.trim() } })
        break
      }

      // 依次执行工具并回填结果
      for (const call of result.toolCalls) {
        const { name, arguments: args } = call.function
        const tool = this.tools.get(name)
        emit({
          type: "message.part.updated",
          part: { type: "tool", tool: name, status: "running", input: args },
        })
        let output
        let toolError
        if (!tool) {
          toolError = `工具不存在: ${name}`
          output = toolError
        } else {
          try {
            output = await tool.execute(args, { cwd: this.cwd, shell: this.config.shell })
          } catch (err) {
            toolError = `工具执行出错: ${err.message}`
            output = toolError
          }
        }
        emit({
          type: "message.part.updated",
          part: {
            type: "tool",
            tool: name,
            status: toolError ? "error" : "completed",
            input: args,
            ...(toolError ? { error: toolError } : { output }),
          },
        })
        messages.push({ role: "tool", tool_call_id: call.id, content: output })
      }
    }

    emit({
      type: "session.status",
      status: { type: "idle" },
      usage: { input: totalInputTokens, output: totalOutputTokens, cacheRead: totalCacheRead },
    })
    return {
      messages,
      response: finalText.trim(),
      usage: { input: totalInputTokens, output: totalOutputTokens, cacheRead: totalCacheRead },
    }
  }

  /**
   * 构造一个新的会话消息列表(含系统提示词)。
   */
  static newMessages(cwd) {
    return [{ role: "system", content: buildSystemPrompt({ cwd }) }]
  }
}
