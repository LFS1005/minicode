#!/usr/bin/env node
// minicode CLI 入口
// 零依赖:仅用 Node 内置 readline / fs
// 输出约定(参照 opencode):UI 状态/提示/错误走 stderr,stdout 只留给最终文本或 --format json 的事件流
// 交互:TTY 下用纯 ANSI TUI,无 TTY 或 --no-tui 时降级 readline

import path from "node:path"
import readline from "node:readline"
import { createRequire } from "node:module"
import { loadConfig, checkConfig, saveConfig, userConfigPath } from "./config.js"
import { chat } from "./llm.js"
import { buildTools } from "./tools.js"
import { Agent } from "./agent.js"
import { Session } from "./session.js"

const require = createRequire(import.meta.url)
const { version } = require("../package.json")

const args = process.argv.slice(2)
const flag = (name, short) => {
  const i = args.findIndex((a) => a === `--${name}` || (short && a === `-${short}`))
  return i === -1 ? undefined : args[i + 1]
}
const has = (name, short) => args.some((a) => a === `--${name}` || (short && a === `-${short}`))

// ---------- UI 层(参照 opencode cli/ui.ts:全走 stderr) ----------
const Style = {
  DIM: "\x1b[90m",
  NORMAL: "\x1b[0m",
  BOLD: "\x1b[1m",
  WARNING: "\x1b[93m",
  DANGER: "\x1b[91m",
  SUCCESS: "\x1b[92m",
  INFO: "\x1b[94m",
}
const ui = {
  log: (...msg) => process.stderr.write(msg.join(" ") + "\n"),
  error: (msg) => process.stderr.write(`${Style.DANGER}${Style.BOLD}Error: ${Style.NORMAL}${msg}\n`),
  tool: (name, status) => {
    const icon = status === "completed" ? "✓" : status === "error" ? "✗" : "↳"
    const color = status === "error" ? Style.DANGER : status === "completed" ? Style.SUCCESS : Style.INFO
    process.stderr.write(`  ${color}${icon}${Style.NORMAL} ${name}\n`)
  },
  text: (t) => process.stdout.write(t),
}

function printHelp() {
  ui.log(`minicode v${version} — 超轻量 AI coding agent(零依赖,OpenAI 兼容)

用法:
  minicode [选项]

选项:
  --model <name>        模型名(默认读 MINICODE_MODEL / OPENAI_MODEL,否则 gpt-4o-mini)
  --base-url <url>      API 地址(默认读 MINICODE_BASE_URL / OPENAI_BASE_URL)
  --api-key <key>       API Key(默认读 MINICODE_API_KEY / OPENAI_API_KEY)
  --format <fmt>        输出格式: default(默认)或 json(原始事件流,写 stdout)
  --no-tui              禁用 TUI,强制 readline 交互
  -r, --resume <id>     继续之前的会话
  -l, --list            列出所有会话
  -y, --yes             非交互模式:直接执行传入的参数并退出
  -h, --help            显示帮助

环境变量:MINICODE_MODEL / MINICODE_API_KEY / MINICODE_BASE_URL / MINICODE_SHELL
配置文件: ~/.config/minicode/config.json 或 ./minicode.json

内置命令(交互模式):
  /exit 退出   /new 新会话   /model 查看模型   /config 配置 API
  /history 历史会话(选择加载)   /help 帮助`)
}

async function main() {
  const cwd = process.cwd()
  const format = flag("format") ?? "default"

  if (has("help", "h")) {
    printHelp()
    return
  }
  if (has("list", "l")) {
    const cfg = loadConfig()
    const sessions = Session.list(cfg.sessionDir)
    if (!sessions.length) {
      ui.log("(无会话)")
      return
    }
    for (const s of sessions) {
      const time = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "?"
      console.log(`${s.id}  ${time}  ${s.title ?? ""}`)
    }
    return
  }

  const resume = flag("resume", "r")
  let config = loadConfig({
    model: flag("model"),
    baseUrl: flag("base-url"),
    apiKey: flag("api-key"),
  })
  const isTTY = process.stdin.isTTY && process.stdout.isTTY
  const nonInteractive = has("yes", "y")
  if (nonInteractive && !checkConfig(config)) process.exit(1)
  // 交互模式允许无 Key 进入:进 TUI 后用 /config 向导配置
  let configHint = null
  if (!nonInteractive && !checkConfig(config)) {
    configHint = `${Style.WARNING}! 未配置 API Key。${Style.NORMAL}输入 ${Style.BOLD}/config${Style.NORMAL} 打开配置向导,或设置环境变量 MINICODE_API_KEY。`
    ui.log(configHint)
  }

  const tools = buildTools(config)
  const agent = new Agent({ config, tools, cwd })

  let session
  if (resume) {
    session = await Session.load(config.sessionDir, resume)
    if (!session) {
      ui.error(`会话不存在: ${resume}(用 --list 查看)`)
      process.exit(1)
    }
  } else {
    session = new Session(config.sessionDir)
    session.messages = Agent.newMessages(cwd)
    await session.save()
  }

  // ---------- 工具详情格式化(参照 opencode cli/cmd/run/tool.ts 的展示规则) ----------
  // bash → $ 命令;read → → 文件;write → ← 文件;patch → 文件列表;grep/glob → 模式
  const fmtTokens = (n) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
  }
  const toolSummary = (name, input, output) => {
    const short = (s, max) => (s.length > max ? s.slice(0, max) + "…" : s)
    switch (name) {
      case "bash": {
        const cmd = short(String(input?.command ?? ""), 120)
        const cwd = input?.workdir ? ` (in ${input.workdir})` : ""
        return `$ ${cmd}${cwd}`
      }
      case "read": {
        const file = input?.path ?? input?.file ?? ""
        const page = input?.offset ? ` [${input.offset}-${(input.offset ?? 1) + (input.limit ?? 2000) - 1}]` : ""
        return `→ Read ${file}${page}`
      }
      case "write": {
        const file = input?.path ?? input?.file ?? ""
        const len = String(input?.content ?? "").length
        return `← Write ${file} (${len} 字符)`
      }
      case "apply_patch": {
        // 从输出提取文件列表(照搬 toModelOutput 的 A/M/D 行)
        const files = String(output ?? "")
          .split("\n")
          .slice(1)
          .filter((l) => /^[AMD] /.test(l))
        const n = files.length
        return n > 0 ? `~ Patch ${n} 个文件: ${files.slice(0, 3).join(", ")}${n > 3 ? ` 等 ${n} 个` : ""}` : "~ Patch"
      }
      case "grep":
        return `✱ Grep "${input?.pattern ?? ""}"`
      case "glob":
        return `✱ Glob "${input?.pattern ?? ""}"`
      case "webfetch":
        return `% WebFetch ${short(String(input?.url ?? ""), 80)}`
      default:
        return `⚙ ${name}`
    }
  }
  const toolOutput = (name, input, output) => {
    if (!output) return ""
    const short = (s, max) => (s.length > max ? s.slice(0, max) + `… (共 ${s.length} 字符)` : s)
    if (name === "bash") {
      // 去掉输出里我们自己拼的退出码行,只留实际 stdout/stderr
      const clean = String(output)
        .split("\n")
        .filter((l) => !l.startsWith("Command exited with code"))
        .join("\n")
        .trim()
      return short(clean, 500)
    }
    if (name === "write") return "" // 内容已在摘要显示长度,不重复展示全文
    if (name === "apply_patch") return "" // 文件列表已在摘要
    if (name === "read" || name === "grep" || name === "glob" || name === "webfetch") {
      return short(String(output), 300)
    }
    return short(String(output), 200)
  }

  // ---------- 事件发射与渲染 ----------
  // tui:undefined → 非 TUI 路径(状态走 stderr)
  const makeCallbacks = (tui) => ({
    // json 模式下文本不直接输出,以免污染事件流(文本会以 text part 事件上报)
    onText: (t) => {
      if (format === "json") return
      if (tui) tui.appendStream(t)
      else ui.text(t)
    },
    onToolCall: () => {},
    // 重试开始前:回退已流出的半截文本(对齐 opencode 重试时重置 currentText),
    // 并显示重试状态;重试成功后文本重新完整流出
    onRetry: (info) => {
      if (format === "json") return
      const line = `${Style.WARNING}⚠ 重试 (${info.attempt}/5): ${info.message} · ${Math.max(0, Math.round((info.next - Date.now()) / 1000))}s 后重试${Style.NORMAL}`
      if (tui) {
        tui.rollbackStream()
        tui.setStatus(line)
      } else {
        ui.log(line)
      }
    },
    onEvent: (event) => {
      // json:事件序列化到 stdout
      if (format === "json") {
        process.stdout.write(JSON.stringify({ ...event, timestamp: Date.now(), sessionID: session.id }) + "\n")
        return
      }
      // 非 json:UI 渲染
      if (event.type === "message.updated") {
        const line = `${Style.DIM}> ${event.agent} · ${event.modelID}${Style.NORMAL}`
        if (tui) tui.addLine(line)
        else ui.log(line)
      }
      if (event.type === "message.part.updated") {
        const part = event.part
        if (part.type === "tool" && part.status === "running") {
          const summary = toolSummary(part.tool, part.input, undefined)
          if (tui) tui.setStatus(`${Style.INFO}↳ ${summary}${Style.NORMAL}`)
          else ui.log(`${Style.INFO}↳ ${summary}${Style.NORMAL}`)
        } else if (part.type === "tool" && part.status === "error") {
          const summary = toolSummary(part.tool, part.input, undefined)
          const line = `  ${Style.DANGER}✗ ${summary}${Style.NORMAL}`
          if (tui) {
            tui.addLine(line)
            tui.addLine(`  ${Style.DANGER}${part.error}${Style.NORMAL}`)
          } else {
            ui.log(line)
            ui.error(part.error)
          }
        } else if (part.type === "tool" && part.status === "completed") {
          const summary = toolSummary(part.tool, part.input, part.output)
          const line = `  ${Style.SUCCESS}✓ ${summary}${Style.NORMAL}`
          const body = toolOutput(part.tool, part.input, part.output)
          if (tui) {
            tui.addLine(line)
            if (body) tui.addLine(`  ${Style.DIM}${body}${Style.NORMAL}`)
          } else {
            ui.log(line)
            if (body) ui.log(`  ${Style.DIM}${body}${Style.NORMAL}`)
          }
        } else if (part.type === "text" && tui) {
          tui.endStream()
        }
      }
      if (event.type === "session.status" && event.status?.type === "retry" && tui) {
        // 状态行展示重试进度(opencode 用 session.status {type:"retry"} 通知 UI)
        const s = event.status
        tui.setStatus(`${Style.WARNING}⚠ 重试 (${s.attempt}/5): ${s.message}${Style.NORMAL}`)
      }
      if (event.type === "usage") {
        // 页面下角累计显示:总计 token 数(含输入+输出)
        const total = (event.input ?? 0) + (event.output ?? 0)
        const label = `${fmtTokens(total)} used`
        if (tui) tui.setCorner(label)
        else ui.log(`${Style.DIM}${label}${Style.NORMAL}`)
      }
      if (event.type === "error" && tui) {
        tui.addLine(`${Style.DANGER}${event.error}${Style.NORMAL}`)
      }
    },
  })

  // ---------- 非交互模式 ----------
  if (has("yes", "y")) {
    const prompt = args.filter((a) => !a.startsWith("-")).join(" ") || "总结当前目录的内容"
    // UI 状态走 stderr(json 模式下也不污染 stdout 事件流,参照 opencode)
    ui.log(`minicode v${version} | 模型: ${config.model} | 工作目录: ${cwd}`)
    if (format !== "json") ui.log("思考中...")
    const callbacks = makeCallbacks(undefined)
    try {
      const { messages } = await agent.run(session.messages, prompt, callbacks)
      await session.append(messages)
      if (format !== "json") ui.log("")
    } catch (err) {
      ui.error(err.message)
      if (format === "json") {
        process.stdout.write(JSON.stringify({ type: "error", timestamp: Date.now(), sessionID: session.id, error: err.message }) + "\n")
      }
      process.exit(1)
    }
    return
  }

  // ---------- 配置向导(TUI 表单) ----------
  let configForm = null

  const openConfigForm = () => {
    configForm = {
      title: "配置 API",
      fields: [
        { label: "API 地址", value: config.baseUrl, secret: false },
        { label: "API Key", value: config.apiKey, secret: true },
        { label: "模型", value: config.model, secret: false },
      ],
      actions: [
        { label: "测试连接", id: "test" },
        { label: "保存并应用", id: "save" },
        { label: "取消", id: "cancel" },
      ],
      selected: 0,
      editing: false,
      status: "",
    }
    tui.setForm(configForm)
  }

  const closeConfigForm = () => {
    configForm = null
    tui.closeForm()
  }

  const testConnection = async () => {
    const [baseUrl, apiKey, model] = configForm.fields.map((f) => f.value.trim())
    configForm.status = `${Style.DIM}正在连接 ${baseUrl} ...${Style.NORMAL}`
    tui.setForm(configForm)
    try {
      await chat({
        baseUrl: baseUrl.replace(/\/+$/, ""),
        apiKey,
        model,
        messages: [{ role: "user", content: "ping" }],
        timeout: 15_000,
      })
      configForm.status = `${Style.SUCCESS}✓ 连接成功: ${model} 可用${Style.NORMAL}`
    } catch (err) {
      configForm.status = `${Style.DANGER}✗ 连接失败: ${err.message}${Style.NORMAL}`
    }
    tui.setForm(configForm)
  }

  const applyConfigForm = () => {
    const [baseUrl, apiKey, model] = configForm.fields.map((f) => f.value.trim())
    // 就地修改 config,agent 持有同一引用,当前会话立即生效
    config.baseUrl = baseUrl.replace(/\/+$/, "")
    config.apiKey = apiKey
    config.model = model
    const file = saveConfig({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model })
    configForm.status = `${Style.SUCCESS}✓ 已保存到 ${file}${Style.NORMAL}`
    tui.setForm(configForm)
  }

  const handleFormKey = (key) => {
    if (historyForm) {
      handleHistoryKey(key)
      return
    }
    if (!configForm) return
    const total = configForm.fields.length + configForm.actions.length
    if (key.type === "up") {
      configForm.selected = (configForm.selected - 1 + total) % total
      configForm.editing = false
    } else if (key.type === "down") {
      configForm.selected = (configForm.selected + 1) % total
      configForm.editing = false
    } else if (key.type === "enter") {
      if (configForm.editing) {
        configForm.editing = false
      } else if (configForm.selected < configForm.fields.length) {
        configForm.editing = true
      } else {
        const action = configForm.actions[configForm.selected - configForm.fields.length]
        if (action.id === "test") void testConnection()
        else if (action.id === "save") {
          applyConfigForm()
        } else if (action.id === "cancel") {
          closeConfigForm()
          return
        }
      }
    } else if (key.type === "esc") {
      if (configForm.editing) configForm.editing = false
      else {
        closeConfigForm()
        return
      }
    } else if (key.type === "backspace" && configForm.editing) {
      const f = configForm.fields[configForm.selected]
      f.value = f.value.slice(0, -1)
    } else if (key.type === "char" && configForm.editing) {
      const f = configForm.fields[configForm.selected]
      f.value += key.value
    }
    tui.setForm(configForm)
  }

  // 历史会话选择:↑↓ 移动,回车加载选中项,Esc 取消
  const handleHistoryKey = (key) => {
    if (!historyForm) return
    const total = historyForm.fields.length + historyForm.actions.length
    if (key.type === "up") {
      historyForm.selected = (historyForm.selected - 1 + total) % total
    } else if (key.type === "down") {
      historyForm.selected = (historyForm.selected + 1) % total
    } else if (key.type === "enter") {
      if (historyForm.selected < historyForm.fields.length) {
        const id = historyList[historyForm.selected].id
        void loadHistorySession(id)
        return
      }
      // 取消
      historyForm = null
      tui.closeForm()
      return
    } else if (key.type === "esc") {
      historyForm = null
      tui.closeForm()
      return
    } else if (key.type === "char" && /^\d$/.test(key.value ?? "")) {
      // 数字直接跳转
      const n = parseInt(key.value, 10)
      if (n >= 1 && n <= historyList.length) historyForm.selected = n - 1
    }
    tui.setForm(historyForm)
  }

  // ---------- 历史会话选择(/history) ----------
  let historyForm = null
  let historyList = []

  const openHistory = () => {
    historyList = Session.list(config.sessionDir).filter((s) => s.id !== session.id)
    if (!historyList.length) {
      if (useTUI) tui.addLine(`${Style.DIM}(没有其他会话)${Style.NORMAL}`)
      else ui.log("(没有其他会话)")
      return
    }
    if (useTUI) {
      const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : "?")
      historyForm = {
        title: `历史会话 (${historyList.length} 个) · ↑↓选择 回车加载`,
        fields: historyList.map((s) => ({
          label: `${s.id}  ${fmtTime(s.updatedAt)}`,
          value: s.title ?? "(无标题)",
          secret: false,
        })),
        actions: [{ label: "取消", id: "cancel" }],
        selected: 0,
        editing: false,
        status: "",
      }
      tui.setForm(historyForm)
    } else {
      ui.log(`历史会话(${historyList.length} 个,输入序号加载,回车取消):`)
      historyList.forEach((s, i) => {
        const time = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "?"
        ui.log(`  ${i + 1}. ${s.id}  ${time}  ${s.title ?? ""}`)
      })
      ui.log("输入数字选择会话:")
      pendingHistorySelect = true
      rl.prompt()
    }
  }

  const loadHistorySession = async (id) => {
    const s = await Session.load(config.sessionDir, id)
    if (!s) {
      ui.error(`会话不存在: ${id}`)
      return
    }
    session = s
    if (useTUI) {
      tui.closeForm()
      historyForm = null
      tui.clear()
      tui.addLine(`${Style.DIM}已加载会话 ${id} · 继续对话 · 可用 PageUp/PageDown 滚动查看${Style.NORMAL}`)
      // 回放完整对话:跳过 system / tool / tool_calls,只显示 user 与 assistant 文本
      // 用户消息加粗,模型回复正常色;全部入缓冲,配合滚动条查看完整历史
      for (const m of s.messages) {
        if (m.role === "system" || m.role === "tool" || (m.tool_calls && m.tool_calls.length)) continue
        const content = typeof m.content === "string" ? m.content : ""
        if (!content.trim()) continue
        if (m.role === "user") {
          tui.addLine(`${Style.BOLD}> ${content.trim()}${Style.NORMAL}`)
        } else {
          tui.addLine(content.trim())
        }
        tui.buffer.push("")
      }
      tui.scrollToBottom()
      tui.render()
    } else {
      ui.log(`已加载会话 ${id}`)
      pendingHistorySelect = false
    }
  }

  // ---------- 交互模式 ----------
  const useTUI = isTTY && !has("no-tui") && format !== "json"
  let tui = null // TUI 实例(useTUI 时由下方创建,handleInput 闭包引用)
  let rl = null // readline 实例(history 数字选择用)
  let pendingHistorySelect = false
  let abortCtrl = null // 当前 agent 运行的取消控制器(Esc 中断用)

  const handleInput = async (raw) => {
    const input = raw.trim()
    if (!input) return
    if (input === "/exit" || input === "/quit") {
      if (useTUI) tui.stop()
      process.exit(0)
      return
    }
    if (input === "/help") {
      ui.log("/exit 退出  /new 新会话  /model 查看模型  /config 配置 API  /history 历史会话  /help 帮助")
      return
    }
    if (input === "/new") {
      session = new Session(config.sessionDir)
      session.messages = Agent.newMessages(cwd)
      await session.save()
      ui.log(`新会话 ${session.id}`)
      return
    }
    if (input === "/model") {
      ui.log(`模型: ${config.model}\nAPI: ${config.baseUrl}`)
      return
    }
    if (input === "/config") {
      if (useTUI) openConfigForm()
      else {
        ui.log("配置向导需要 TUI(在真实终端运行,或加 --no-tui 时直接编辑配置文件):")
        ui.log(`  ${Style.DIM}${userConfigPath()}${Style.NORMAL}`)
      }
      return
    }
    if (input === "/history" || input === "/h") {
      openHistory()
      return
    }

    if (useTUI) {
      tui.addLine(`> ${input}`)
      tui.setStatus(`${Style.DIM}运行中...${Style.NORMAL}`)
      tui.running = true
      tui.render()
    }
    let sessionUsage = null
    abortCtrl = new AbortController()
    try {
      const { messages, usage, cancelled } = await agent.run(session.messages, input, makeCallbacks(useTUI ? tui : undefined), {
        signal: abortCtrl.signal,
      })
      sessionUsage = usage
      // 中断也保存已发生的消息(用户输入 + 已完成的部分回复),避免会话丢失
      await session.append(messages)
      if (cancelled) {
        const line = `${Style.WARNING}⏹ 已中断(按 Esc/Ctrl+C 结束当前任务,可继续输入)${Style.NORMAL}`
        if (useTUI) tui.addLine(line)
        else ui.log(line)
      }
      if (!useTUI) {
        ui.log("")
        ui.log(`${Style.DIM}会话用量: ↑${fmtTokens(usage?.input ?? 0)} ↓${fmtTokens(usage?.output ?? 0)}${usage?.cacheRead ? ` · 缓存 ${fmtTokens(usage.cacheRead)}` : ""}${Style.NORMAL}`)
      }
    } catch (err) {
      ui.error(err.message)
    } finally {
      abortCtrl = null
      if (useTUI) {
        tui.running = false
        // 页面下角保留最终用量
        if (sessionUsage) {
          const total = (sessionUsage.input ?? 0) + (sessionUsage.output ?? 0)
          tui.setCorner(`${fmtTokens(total)} used`)
        }
        tui.setStatus("")
      }
    }
  }

  if (useTUI) {
    // ---------- TUI 路径(纯 ANSI,零依赖) ----------
    const { TUI } = await import("./tui.js")
    tui = new TUI()
    tui.submit = (input) => void handleInput(input)
    tui.onExit = () => process.exit(0)
    tui.onFormKey = (key) => handleFormKey(key)
    // agent 执行中按 Esc / Ctrl+C:中断当前任务,保留会话并可继续输入
    tui.onInterrupt = () => {
      if (abortCtrl) abortCtrl.abort()
    }
    tui.start()
    tui.addLine(`${Style.DIM}minicode v${version} | ${config.model} | ${cwd}${Style.NORMAL}`)
    if (!resume) tui.addLine(`${Style.DIM}新会话 ${session.id} · /help 帮助 · Esc 中断 · Ctrl+C 退出${Style.NORMAL}`)
    if (configHint) tui.addLine(configHint)
    tui.addLine("")
  } else {
    // ---------- readline 降级路径 ----------
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const prompt = () => {
      rl.setPrompt("> ")
      rl.prompt()
    }
    prompt()
    rl.on("line", async (line) => {
      if (pendingHistorySelect) {
        const n = parseInt(line.trim(), 10)
        if (Number.isInteger(n) && n >= 1 && n <= historyList.length) {
          await loadHistorySession(historyList[n - 1].id)
        } else {
          ui.log("(已取消)")
          pendingHistorySelect = false
        }
        prompt()
        return
      }
      await handleInput(line)
      prompt()
    })
    rl.on("close", () => process.exit(0))
  }
}

main().catch((err) => {
  ui.error(err)
  process.exit(1)
})
