// 极简 TUI:纯 ANSI 转义码 + raw mode,零依赖
// 参照 opencode TUI 的分屏结构:上方滚动输出区,底部状态行 + 输入行
// 无 TTY 时由调用方降级到 readline(见 index.js)

const ESC = "\x1b"

// ---------- 显示宽度工具(处理中文等宽字符) ----------
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK ... Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

// 可见显示宽度:宽字符计 2,ANSI 转义序列不计
function displayWidth(s) {
  let w = 0
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === ESC) {
      // 跳过 ANSI 转义序列 ESC [ ... 字母
      i++
      if (s[i] === "[") {
        i++
        while (i < s.length && !/[A-Za-z~]/.test(s[i])) i++
        i++
      }
      continue
    }
    w += isWide(s.codePointAt(i)) ? 2 : 1
    i += s.codePointAt(i) > 0xffff ? 2 : 1
  }
  return w
}

// 按显示宽度截断,保留 ANSI 序列完整
function truncateVisible(s, max) {
  if (displayWidth(s) <= max) return s
  let out = ""
  let w = 0
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === ESC) {
      let j = i + 1
      if (s[j] === "[") {
        j++
        while (j < s.length && !/[A-Za-z~]/.test(s[j])) j++
        j++
      } else j = i + 1
      out += s.slice(i, j)
      i = j
      continue
    }
    const cw = isWide(s.codePointAt(i)) ? 2 : 1
    if (w + cw > max) break
    out += ch
    w += cw
    i++
  }
  return out
}

// 按显示宽度折行,不切断宽字符与 ANSI 序列;遇 \n 强制断行
function wrapLine(line, cols) {
  const out = []
  let cur = ""
  let w = 0
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === ESC) {
      let j = i + 1
      if (line[j] === "[") {
        j++
        while (j < line.length && !/[A-Za-z~]/.test(line[j])) j++
        j++
      } else j = i + 1
      cur += line.slice(i, j)
      i = j
      continue
    }
    if (ch === "\n") {
      // 强制断行,避免 \n 混入渲染流破坏坐标
      out.push(cur)
      cur = ""
      w = 0
      i++
      continue
    }
    const cw = isWide(line.codePointAt(i)) ? 2 : 1
    if (w + cw > cols) {
      out.push(cur)
      cur = ""
      w = 0
      continue
    }
    cur += ch
    w += cw
    i++
  }
  out.push(cur)
  return out
}

export class TUI {
  constructor() {
    this.rows = process.stdout.rows || 24
    this.cols = process.stdout.columns || 80
    this.buffer = [] // 输出区逻辑行
    this.status = "" // 底部状态行
    this.input = ""
    this.cursor = 0 // 输入光标位置(字符索引)
    this.history = [] // 输入历史(上/下键)
    this.historyIndex = -1
    this.running = false // agent 执行中,忽略输入
    this.submit = null // 由外部设置:onSubmit(input)
    this.onExit = null
    this.onInterrupt = null // 由外部设置:agent 执行中按 Esc/Ctrl+C 时触发
    this.raw = false
    // 粘贴状态(bracketed paste)
    this.pasting = false
    this.pasteBuf = ""
    // 滚动:scrollOffset = 向上滚动的物理行数(0 = 最新/底部)
    this.scrollOffset = 0
    // 页面下角统计(如 "12.3k used"),渲染在状态行右侧
    this.corner = ""
    // 流式起始位置(重试回退用):null = 不在流式
    this.streamStart = null
    // 转义序列分片缓存(序列被拆在两个 data 事件之间)
    this.seqBuf = ""
    // 表单模式(配置向导等):
    // form = { title, fields: [{label, value, secret?}], actions: [{label}], selected, editing, status }
    this.form = null
    this.onFormKey = null // (key) => void;key: {type:"up"|"down"|"enter"|"esc"|"backspace"|"char", value?}
  }

  // ---------- 表单模式 ----------
  setForm(form) {
    this.form = form
    this.render()
  }

  closeForm() {
    this.form = null
    this.render()
  }

  // ---------- 生命周期 ----------
  start() {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return
    this.raw = true
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    // 切换备用屏幕(不污染 shell 历史与滚动缓冲),启用 bracketed paste + SGR 鼠标上报
    // 1000h: 鼠标事件上报;1006h: SGR 编码;1007h: 关闭 alternate scroll(滚轮不再被翻译成方向键)
    process.stdout.write(`${ESC}[?1049h${ESC}[?2004h${ESC}[?1000h${ESC}[?1006h${ESC}[?1007l`)
    process.stdin.on("data", (chunk) => this.handle(chunk))
    process.stdout.on("resize", () => {
      this.rows = process.stdout.rows || 24
      this.cols = process.stdout.columns || 80
      this.render()
    })
    this.render()
  }

  stop() {
    if (this.raw) {
      try {
        process.stdin.setRawMode(false)
      } catch {}
      this.raw = false
    }
    // 恢复主屏幕 + 关闭鼠标上报/bracketed paste + 显示光标
    process.stdout.write(`${ESC}[?1007l${ESC}[?1006l${ESC}[?1000l${ESC}[?2004l${ESC}[?1049l${ESC}[?25h${ESC}[0m`)
  }

  // ---------- 输出区 ----------
  // 按 \n 拆分后入缓冲,避免多行文本(如工具输出)混入单行破坏渲染
  addLine(text) {
    if (text == null) return
    const parts = String(text).split("\n")
    for (const p of parts) this.buffer.push(p)
    this.render()
  }

  // 流式追加到当前行,处理 \n
  // 记录流式起始位置,供重试时回退(对齐 opencode 重试时重置 currentText)
  appendStream(chunk) {
    if (!chunk) return
    if (this.streamStart === null) {
      this.streamStart = { line: this.buffer.length, col: this.buffer[this.buffer.length - 1]?.length ?? 0 }
    }
    const parts = chunk.split("\n")
    if (this.buffer.length === 0) this.buffer.push("")
    this.buffer[this.buffer.length - 1] += parts[0]
    for (const p of parts.slice(1)) this.buffer.push(p)
    this.render()
  }

  endStream() {
    // 流式文本结束:补一个空行与下一条内容分隔
    this.streamStart = null
    if (this.buffer.length && this.buffer[this.buffer.length - 1] !== "") this.buffer.push("")
    this.render()
  }

  // 回退到本次流式开始前(重试时丢弃已流出的半截文本)
  rollbackStream() {
    if (this.streamStart === null) return
    const { line, col } = this.streamStart
    if (line < this.buffer.length) this.buffer = this.buffer.slice(0, line)
    if (this.buffer.length === line && this.buffer[line - 1] && col < this.buffer[line - 1].length) {
      this.buffer[line - 1] = this.buffer[line - 1].slice(0, col)
    }
    this.streamStart = null
    this.render()
  }

  setStatus(text) {
    this.status = text
    this.render()
  }

  // 页面下角统计(渲染在状态行右侧,如 "12.3k used")
  setCorner(text) {
    this.corner = text
    this.render()
  }

  clear() {
    this.buffer = []
    this.scrollOffset = 0
    this.render()
  }

  // 新内容到达时回到最新位置(除非用户正在向上翻)
  scrollToBottom() {
    this.scrollOffset = 0
  }

  // Home:滚到顶部
  scrollToTop() {
    const h = Math.max(this.rows - 2, 1)
    const total = this.physicalCount()
    this.scrollOffset = Math.max(0, total - h)
    this.render()
  }

  // ---------- 按键处理 ----------
  handle(chunk) {
    // 跨 chunk 的转义序列分片缓存(序列可能被拆在两个 data 事件里)
    if (this.seqBuf) {
      chunk = this.seqBuf + chunk
      this.seqBuf = ""
    }
    if (this.running) {
      // agent 执行中:Esc 或 Ctrl+C 中断当前任务(不退出程序)
      if (chunk.includes("\x03") || chunk === ESC) {
        this.onInterrupt?.()
      }
      return
    }
    // bracketed paste 内容可能分多段到达
    if (this.pasting) {
      const end = chunk.indexOf(`${ESC}[201~`)
      if (end !== -1) {
        this.pasteBuf += chunk.slice(0, end)
        this.pasting = false
        const text = this.pasteBuf
        this.pasteBuf = ""
        this.insertPaste(text)
        const rest = chunk.slice(end + 6)
        if (rest) this.handle(rest)
      } else {
        this.pasteBuf += chunk
      }
      return
    }
    // 粘贴开始标记
    const pstart = chunk.indexOf(`${ESC}[200~`)
    if (pstart !== -1) {
      const before = chunk.slice(0, pstart)
      if (before) this.handle(before)
      const body = chunk.slice(pstart + 6)
      // 开始与结束标记可能在同一段
      const end = body.indexOf(`${ESC}[201~`)
      if (end !== -1) {
        this.insertPaste(body.slice(0, end))
        const rest = body.slice(end + 6)
        if (rest) this.handle(rest)
      } else {
        this.pasting = true
        this.pasteBuf = body
      }
      return
    }
    // 无 bracketed paste 的终端(如部分 SSH/老终端):整段含多个换行且含其他内容
    // 视为粘贴;单个 \r 或 \r\n 是回车提交,不算粘贴
    const stripped = chunk.replace(/\r|\n/g, "")
    if (stripped.length > 1 && (chunk.match(/\r|\n/g) || []).length > 1) {
      this.insertPaste(chunk)
      return
    }
    if (this.form) {
      this.handleFormKey(chunk)
      return
    }
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]
      if (ch === ESC) {
        // 解析完整 ANSI 转义序列:ESC [ 参数 终止字节;序列可能跨 chunk 分片
        if (chunk[i + 1] === "[") {
          let j = i + 2
          // 跳过参数字节(数字/分号/SGR 鼠标的 <),直到终止字节(字母或 ~)
          while (j < chunk.length && /[0-9;<]/.test(chunk[j])) j++
          if (j >= chunk.length) {
            // 序列未完整:缓存等下一个 chunk
            this.seqBuf = chunk.slice(i)
            return
          }
          const params = chunk.slice(i + 2, j)
          const k = chunk[j]
          const seqLen = j - i + 1
          if (k === "M" || k === "m") {
            // SGR 鼠标事件:ESC [ < b ; x ; y M/m;滚轮 64=上 65=下
            this.handleMouse(params)
          } else if (k === "A" || k === "B" || k === "C" || k === "D") {
            this.handleEscape(k)
          } else if (k === "~") {
            // 数字键区 / PageUp(5) / PageDown(6) / Home(1) / End(4)
            if (params === "5") this.handlePage(-1)
            else if (params === "6") this.handlePage(1)
            else if (params === "1") this.scrollToTop()
            else if (params === "4") this.scrollToBottom()
          } else if (k === "H") {
            this.scrollToTop()
          } else if (k === "F") {
            this.scrollToBottom()
          }
          i += seqLen
          continue
        }
        i++
        continue
      }
      this.handleChar(ch)
      i++
    }
  }

  // SGR 鼠标事件:参数形如 "<64;10;5"(M=按下/滚轮) 或 "<64;10;5"(m=释放)
  // 滚轮:64=向上 65=向下;鼠标拖拽/移动(32+)忽略
  handleMouse(params) {
    const parts = params.replace(/^</, "").split(";")
    const b = parseInt(parts[0], 10)
    if (!Number.isFinite(b)) return
    const kind = b & 0x43 // 取低有效位:0-2=按键 32=拖动 64/65=滚轮
    if (kind === 64) {
      this.handlePage(-3) // 滚轮上:滚 3 行
    } else if (kind === 65) {
      this.handlePage(3) // 滚轮下:滚 3 行
    }
    // 点击/拖动/释放:暂不处理
  }

  // PageUp/PageDown:滚动输出区(delta 行数,负数向上)
  handlePage(delta) {
    const h = Math.max(this.rows - 2, 1)
    const total = this.physicalCount()
    const maxOffset = Math.max(0, total - h)
    if (delta < 0) {
      this.scrollOffset = Math.min(this.scrollOffset + h, maxOffset)
    } else {
      this.scrollOffset = Math.max(0, this.scrollOffset - h)
    }
    this.render()
  }

  // 输出区物理行总数(折行后)
  physicalCount() {
    let n = 0
    for (const line of this.buffer) {
      if (line === "") n++
      else n += wrapLine(line, this.cols).length
    }
    return n
  }

  // 粘贴文本:插入到光标处,换行转为空格(不触发提交)
  insertPaste(text) {
    const clean = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ")
    if (this.form) {
      // 表单模式:转发为连续 char 键
      if (this.onFormKey) {
        this.onFormKey({ type: "char", value: clean })
        this.render()
      }
      return
    }
    this.input = this.input.slice(0, this.cursor) + clean + this.input.slice(this.cursor)
    this.cursor += clean.length
    this.render()
  }

  handleFormKey(chunk) {
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]
      if (ch === ESC) {
        const seq = chunk.slice(i, i + 3)
        if (seq[1] === "[") {
          const k = seq[2]
          const type = k === "A" ? "up" : k === "B" ? "down" : k === "C" ? "right" : k === "D" ? "left" : "unknown"
          this.onFormKey?.({ type })
          i += 3
          continue
        }
        // 单独的 ESC 键
        this.onFormKey?.({ type: "esc" })
        i++
        continue
      }
      if (ch === "\r" || ch === "\n") {
        this.onFormKey?.({ type: "enter" })
      } else if (ch === "\x7f" || ch === "\b") {
        this.onFormKey?.({ type: "backspace" })
      } else if (ch === "\x03") {
        this.exit()
      } else if (ch !== "\t" && ch !== "\x0c") {
        this.onFormKey?.({ type: "char", value: ch })
      }
      i++
    }
  }

  handleEscape(c) {
    switch (c) {
      case "A": // 上:历史
        // 仅当不在滚动查看时作为输入历史;查看模式用 PageUp/PageDown 滚动
        if (this.scrollOffset > 0) return
        break
      case "B":
        if (this.scrollOffset > 0) return
        break
    }
    switch (c) {
      case "A": // 上:历史
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++
          this.input = this.history[this.history.length - 1 - this.historyIndex]
          this.cursor = this.input.length
          this.render()
        }
        break
      case "B": // 下
        if (this.historyIndex > 0) {
          this.historyIndex--
          this.input = this.history[this.history.length - 1 - this.historyIndex]
        } else {
          this.historyIndex = -1
          this.input = ""
        }
        this.cursor = this.input.length
        this.render()
        break
      case "C": // 右
        if (this.cursor < this.input.length) {
          this.cursor++
          this.render()
        }
        break
      case "D": // 左
        if (this.cursor > 0) {
          this.cursor--
          this.render()
        }
        break
    }
  }

  handleChar(ch) {
    if (ch === "\r" || ch === "\n") {
      this.submitInput()
      return
    }
    if (ch === "\x03") {
      // Ctrl+C
      this.exit()
      return
    }
    if (ch === "\x0c") {
      // Ctrl+L 清屏
      this.clear()
      return
    }
    if (ch === "\x7f" || ch === "\b") {
      // 退格
      if (this.cursor > 0) {
        this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor)
        this.cursor--
        this.render()
      }
      return
    }
    if (ch === "\t") return // 忽略 Tab
    // 可打印字符(含 UTF-8 多字节,setEncoding utf8 已解码)
    this.input = this.input.slice(0, this.cursor) + ch + this.input.slice(this.cursor)
    this.cursor++
    this.render()
  }

  submitInput() {
    const input = this.input.trim()
    this.input = ""
    this.cursor = 0
    this.render()
    if (!input) return
    this.history.push(input)
    if (this.history.length > 100) this.history.shift()
    this.historyIndex = -1
    if (this.submit) this.submit(input)
  }

  exit() {
    this.stop()
    if (this.onExit) this.onExit()
    else process.exit(0)
  }

  // ---------- 渲染 ----------
  render() {
    const { rows, cols } = this
    // 布局:输出区 = rows - 2(状态行 + 输入行);输出区至少 1 行
    const outputHeight = Math.max(rows - 2, 1)

    // 隐藏光标 → 清屏 → 回顶:保证每帧从干净画面开始,旧帧不残留
    let out = `${ESC}[?25l${ESC}[2J${ESC}[H`
    let cursorRow = rows
    let cursorCol = 1

    if (this.form) {
      // ---------- 表单渲染 ----------
      const { title, fields, actions, selected, editing, status } = this.form
      const lines = []
      lines.push(`${ESC}[1m ${title}${ESC}[0m`)
      lines.push("")
      fields.forEach((f, i) => {
        const sel = selected === i
        const marker = sel ? `${ESC}[96m▶${ESC}[0m ` : "  "
        let value
        if (sel && editing) value = f.value || ""
        else if (f.secret && f.value)
          value = `${ESC}[90m${f.value.slice(0, 3)}***${f.value.slice(-3)}${ESC}[0m`
        else if (f.value) value = f.value
        else value = `${ESC}[90m(空)${ESC}[0m`
        lines.push(`${marker}${f.label}: ${value}`)
      })
      lines.push("")
      actions.forEach((a, i) => {
        const sel = selected === fields.length + i
        const marker = sel ? `${ESC}[96m▶${ESC}[0m ` : "  "
        lines.push(`${marker}[${a.label}]`)
      })

      const visible = lines.slice(-outputHeight)
      for (let i = 0; i < outputHeight; i++) {
        out += visible[i] ?? ""
        if (i < outputHeight - 1) out += `${ESC}[K\n`
        else out += `${ESC}[K`
      }
      // 状态行:form.status 优先,否则提示
      const statusText =
        status ||
        (editing
          ? `${ESC}[90m编辑中:输入内容,回车确认${ESC}[0m`
          : `${ESC}[90m↑↓ 选择 · 回车 编辑/执行 · Esc 退出${ESC}[0m`)
      out += `\n${truncateVisible(statusText, cols)}${ESC}[K`
      // 输入行:编辑时显示当前字段值(先清行再写,避免 EL 清掉提示符后空格)
      if (editing) {
        const active = fields[selected]
        const text = active?.value ?? ""
        const { text: shown, cursorCol: cc } = this.inputWindow(text, text.length, cols - 2)
        out += `\n${ESC}[K> ${shown}`
        cursorRow = rows
        cursorCol = cc
      } else {
        out += `\n${ESC}[K`
        cursorRow = rows
        cursorCol = 1
      }
    } else {
      // ---------- 正常滚动输出(带滚动条) ----------
      const physical = []
      for (const line of this.buffer) {
        if (line === "") {
          physical.push("")
          continue
        }
        physical.push(...wrapLine(line, cols - 1)) // 右侧留 1 列给滚动条
      }
      const total = physical.length
      // 滚动位置:0 = 最新;向上滚时查看更早内容
      let start = total - outputHeight - this.scrollOffset
      if (start < 0) {
        this.scrollOffset = Math.max(0, total - outputHeight)
        start = Math.max(0, total - outputHeight)
      }
      const visible = physical.slice(start, start + outputHeight)
      const scrollbar = this.scrollbar(total, outputHeight, start)
      for (let i = 0; i < outputHeight; i++) {
        const line = visible[i] ?? ""
        const bar = scrollbar[i]
        out += line
        // 滚动条列
        if (bar) {
          out += `${ESC}[${bar.color}${bar.ch}${ESC}[0m`
        } else {
          out += " "
        }
        if (i < outputHeight - 1) out += `${ESC}[K\n`
        else out += `${ESC}[K`
      }
      // 状态行:左侧 status,右侧 corner(token 统计)
      const statusW = cols - (this.corner ? displayWidth(this.corner) + 1 : 0)
      const statusText = truncateVisible(this.status, Math.max(statusW, 0))
      out += `\n${statusText}${ESC}[K`
      if (this.corner) {
        // 光标移到行尾写 corner（不加 EL，避免擦掉末列字符）
        const cornerX = cols - displayWidth(this.corner) + 1
        out += `${ESC}[${rows - 1};${Math.max(cornerX, 1)}H${this.corner}`
      }
      const { text: shown, cursorCol: cc } = this.inputWindow(this.input, this.cursor, cols - 2)
      out += `\n${ESC}[K> ${shown}`
      cursorRow = rows
      cursorCol = cc
    }

    out += `${ESC}[${cursorRow};${cursorCol}H${ESC}[?25h`
    process.stdout.write(out)
  }

  // 输出区右侧滚动条:返回每行 [color, ch],无滚动条时返回 null
  scrollbar(total, height, start) {
    const res = new Array(height).fill(null)
    if (total <= height) return res
    const track = height - 2 // 上下各留 1 个箭头位
    const thumbH = Math.max(2, Math.round((height / total) * track))
    const maxStart = total - height
    const thumbTop = Math.round((start / maxStart) * Math.max(track - thumbH, 0))
    for (let i = 0; i < height; i++) {
      if (i === 0) res[i] = { ch: "▲", color: "\x1b[90m" }
      else if (i === height - 1) res[i] = { ch: "▼", color: "\x1b[90m" }
      else if (i >= thumbTop + 1 && i < thumbTop + 1 + thumbH) res[i] = { ch: "█", color: "\x1b[90m" }
      else res[i] = { ch: "│", color: "\x1b[90m" }
    }
    return res
  }

  // 输入行窗口:以光标为锚,超长时向左滚动,保证光标始终可见
  // 返回 { text, cursorCol }:显示文本(宽度 ≤ max)与光标所在列(相对 > 提示符,第 1 列起)
  inputWindow(text, cursor, max) {
    const cursorWidth = displayWidth(text.slice(0, cursor))
    if (cursorWidth <= max) {
      return { text: truncateVisible(text, max), cursorCol: 3 + cursorWidth }
    }
    // 光标前内容超宽:从光标向左取 max 宽度作为窗口起点
    let w = 0
    let start = cursor
    while (start > 0) {
      const cp = text.codePointAt(start - 1)
      const cw = isWide(cp) ? 2 : 1
      if (w + cw > max) break
      w += cw
      start--
    }
    return { text: truncateVisible(text.slice(start), max), cursorCol: 3 + w }
  }
}
