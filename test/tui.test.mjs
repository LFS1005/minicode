// TUI 单元测试:验证纯 ANSI 渲染与按键处理逻辑
// 运行: node test/tui.test.mjs
// 注意:不依赖真实 TTY,直接实例化并调用渲染/按键方法

import { TUI } from "../src/tui.js"

const results = []
const check = (name, cond) => {
  results.push([name, cond])
  process.stderr.write(`${cond ? "PASS" : "FAIL"}  ${name}\n`)
}

// 拦截 process.stdout.write 捕获渲染输出
const writes = []
const origWrite = process.stdout.write
process.stdout.write = (chunk) => {
  writes.push(String(chunk))
  return true
}
process.stdout.rows = 10
process.stdout.columns = 40

const tui = new TUI()
tui.start() // 会调 setRawMode,无 TTY 时可能抛错,捕获

const renderOutput = () => writes.join("")
const reset = () => {
  writes.length = 0
}

try {
  // ---------- 渲染:状态行与输入行布局 ----------
  reset()
  tui.buffer = ["hello", "world"]
  tui.status = "running"
  tui.input = "test"
  tui.cursor = 2
  tui.render()
  const out = renderOutput()
  check("隐藏光标", out.includes("\x1b[?25l"))
  check("显示光标", out.includes("\x1b[?25h"))
  check("渲染 buffer 行", out.includes("hello") && out.includes("world"))
  check("渲染状态行", out.includes("running"))
  check("渲染输入行", out.includes("> test"))
  check("光标定位含行号", out.includes(`\x1b[10;`))

  // ---------- 输出区行数 = rows - 2,超长滚动 ----------
  reset()
  tui.buffer = Array.from({ length: 20 }, (_, i) => `line${i}`)
  tui.status = ""
  tui.input = ""
  tui.render()
  const out2 = renderOutput()
  check("输出区只显示最近 8 行(rows-2)", out2.includes("line19") && out2.includes("line12") && !out2.includes("line0"))

  // ---------- 折行:长行按 cols 截断 ----------
  reset()
  tui.buffer = ["x".repeat(100)]
  tui.render()
  const out3 = renderOutput()
  check("长行被折成多物理行", out3.match(/xxx/g).length >= 2)

  // ---------- 按键:输入/退格/提交 ----------
  reset()
  let submitted = null
  tui.submit = (input) => (submitted = input)
  tui.input = ""
  tui.cursor = 0
  tui.handle("a")
  tui.handle("b")
  check("按键插入输入", tui.input === "ab")
  tui.handle("\x7f")
  check("退格删除", tui.input === "a")
  tui.handle("c")
  tui.handle("\r")
  check("回车提交", submitted === "ac")
  check("提交后清空输入", tui.input === "")

  // ---------- 历史:上/下键 ----------
  tui.handle("h1")
  tui.handle("\r")
  tui.handle("h2")
  tui.handle("\r")
  tui.handle("\x1b[A") // 上
  check("上箭头取历史", tui.input === "h2")
  tui.handle("\x1b[A")
  check("再上箭头取更早历史", tui.input === "h1")
  tui.handle("\x1b[B") // 下
  check("下箭头回到新输入", tui.input === "h2")

  // ---------- 流式追加 ----------
  reset()
  tui.buffer = []
  tui.appendStream("你好")
  tui.appendStream("世界")
  check("流式追加文本", tui.buffer.join("") === "你好世界")
  tui.appendStream("\n第二行")
  check("流式换行", tui.buffer.length === 2 && tui.buffer[1] === "第二行")

  // ---------- 多字节 UTF-8(中文在 raw mode 下解码) ----------
  reset()
  tui.input = ""
  tui.cursor = 0
  tui.handle("中文")
  check("UTF-8 多字节输入", tui.input === "中文" && tui.cursor === 2)
  tui.handle("\x7f")
  check("退格删除多字节字符", tui.input === "中")

  // ---------- 表单模式 ----------
  reset()
  const formKeys = []
  tui.onFormKey = (k) => formKeys.push(k)
  const form = {
    title: "配置 API",
    fields: [
      { label: "API 地址", value: "https://api.openai.com/v1", secret: false },
      { label: "API Key", value: "sk-test123456", secret: true },
      { label: "模型", value: "gpt-4o-mini", secret: false },
    ],
    actions: [{ label: "测试连接", id: "test" }],
    selected: 0,
    editing: false,
    status: "",
  }
  tui.setForm(form)
  const formOut = renderOutput()
  check("表单渲染标题", formOut.includes("配置 API"))
  check("表单渲染字段", formOut.includes("API 地址") && formOut.includes("模型"))
  check("表单渲染动作", formOut.includes("测试连接"))
  check("secret 字段打码", formOut.includes("sk-***456") && !formOut.includes("sk-test123456"))
  check("表单隐藏输入行内容", !renderOutput().includes("\n> "))

  // 按键转发
  reset()
  formKeys.length = 0
  tui.handle("\x1b[B") // 下
  check("表单转发 down", formKeys.at(-1)?.type === "down")
  tui.handle("\r")
  check("表单转发 enter", formKeys.at(-1)?.type === "enter")
  tui.handle("\x7f")
  check("表单转发 backspace", formKeys.at(-1)?.type === "backspace")
  tui.handle("abc")
  check("表单转发 char", formKeys.at(-1)?.type === "char" && formKeys.at(-1)?.value === "c")
  tui.handle("\x1b")
  check("表单转发 esc", formKeys.at(-1)?.type === "esc")

  // 编辑态:输入行显示字段值
  reset()
  form.editing = true
  form.selected = 2
  form.fields[2].value = "deepseek-chat"
  tui.setForm(form)
  const editOut = renderOutput()
  // 渲染改为先清行再写内容(修复 EL 清掉提示符空格),故 > 前有 \x1b[K
  check("编辑态输入行显示字段值", editOut.includes("> deepseek-chat") && editOut.includes("\x1b[K>"))

  // 关闭表单回到滚动模式
  reset()
  tui.closeForm()
  tui.buffer = ["normal line"]
  tui.render()
  check("关闭表单恢复滚动输出", renderOutput().includes("normal line"))

  // ---------- 宽字符(中文)光标位置 ----------
  reset()
  tui.buffer = []
  tui.status = ""
  tui.input = "你好"
  tui.cursor = 2
  tui.render()
  // 光标列 = 3(提示符 "> ") + 显示宽度(2 个中文 = 4 列) = 7
  check("中文输入光标列按显示宽度(3+4=7)", renderOutput().includes(`\x1b[10;7H`))

  reset()
  tui.input = "a你好"
  tui.cursor = 3
  tui.render()
  // 显示宽度 = 1(a) + 4(你好) = 5,光标列 = 3 + 5 = 8
  check("混合输入光标列按显示宽度(3+5=8)", renderOutput().includes(`\x1b[10;8H`))

  reset()
  tui.input = "你"
  tui.cursor = 1
  tui.render()
  check("中文光标在文本前(3+2=5)", renderOutput().includes(`\x1b[10;5H`))

  // 中文退格:光标回退一位,位置正确
  reset()
  tui.input = "你好"
  tui.cursor = 2
  tui.handle("\x7f")
  check("中文退格删除一个字符", tui.input === "你" && tui.cursor === 1)
  tui.render()
  check("中文退格后光标列正确(3+2=5)", renderOutput().includes(`\x1b[10;5H`))

  // ---------- 粘贴(bracketed paste) ----------
  reset()
  let submitted2 = null
  tui.submit = (input) => (submitted2 = input)
  tui.input = ""
  tui.cursor = 0
  // 终端粘贴内容被 \x1b[200~ ... \x1b[201~ 包裹,其中的换行不触发提交
  tui.handle("\x1b[200~echo hi\r\n第二行\x1b[201~")
  check("粘贴内容插入且换行转空格", tui.input === "echo hi 第二行")
  check("粘贴不触发提交", submitted2 === null)

  // 粘贴内容分多段到达
  reset()
  tui.input = ""
  tui.cursor = 0
  tui.handle("\x1b[200~line1\n")
  tui.handle("line2\nline3")
  tui.handle("\x1b[201~")
  check("分段粘贴拼接正确", tui.input === "line1 line2 line3")
  check("分段粘贴不触发提交", submitted2 === null)

  // 无 bracketed paste 的终端:整段多换行视为粘贴
  reset()
  tui.input = ""
  tui.cursor = 0
  tui.handle("a\nb\nc")
  check("无标记多行粘贴转空格", tui.input === "a b c")
  check("无标记多行粘贴不提交", submitted2 === null)

  // 单个回车仍提交(\r 与 \r\n 都算回车)
  reset()
  tui.input = "ok"
  tui.cursor = 2
  tui.handle("\r\n")
  check("单个 \\r\\n 是回车提交", submitted2 === "ok")

  // 粘贴到光标中间位置
  reset()
  tui.input = "ab"
  tui.cursor = 1
  tui.handle("\x1b[200~XY\x1b[201~")
  check("粘贴插入光标位置", tui.input === "aXYb" && tui.cursor === 3)

  // ---------- 滚动条与滚动 ----------
  // 输出超过屏幕时,右侧出现滚动条(▲/▼/█/│)
  reset()
  tui.buffer = []
  tui.status = ""
  tui.input = ""
  tui.corner = ""
  tui.scrollOffset = 0
  tui.buffer = Array.from({ length: 30 }, (_, i) => `row${i}`)
  tui.render()
  const scrollOut = renderOutput()
  check("内容超出时渲染滚动条", scrollOut.includes("█") || scrollOut.includes("▲"))
  check("滚动条显示最新内容(row29)", scrollOut.includes("row29"))

  // PageUp 向上滚动,显示更早内容
  reset()
  tui.scrollOffset = 0
  tui.handle("\x1b[5~") // PageUp
  check("PageUp 设置滚动偏移", tui.scrollOffset > 0)
  reset()
  tui.render()
  const upOut = renderOutput()
  // 窗口从 row14 开始(30 行,屏幕 8 行,上翻 8 行 → 14-21)
  check("向上滚动后显示更早内容", upOut.includes("row14") && upOut.includes("row21"))
  check("向上滚动后不显示最新行", !upOut.includes("row29"))

  // PageDown 回到最新
  reset()
  tui.handle("\x1b[6~") // PageDown
  check("PageDown 后滚动偏移归零", tui.scrollOffset === 0)
  reset()
  tui.render()
  const downOut = renderOutput()
  check("PageDown 回到最新内容", downOut.includes("row29"))

  // 内容不多时不渲染滚动条
  reset()
  tui.buffer = ["only one line"]
  tui.scrollOffset = 0
  tui.render()
  check("内容少时不渲染滚动条", !renderOutput().includes("█"))

  // ---------- 页面下角统计(corner) ----------
  reset()
  tui.buffer = ["line"]
  tui.setCorner("12.3k used")
  const cornerOut = renderOutput()
  check("corner 显示在状态行右侧", cornerOut.includes("12.3k used"))
  reset()
  tui.setCorner("")
  check("清空 corner 后不再显示", !renderOutput().includes("used"))
} catch (err) {
  check(`TUI 测试无异常: ${err.message}`, false)
} finally {
  process.stdout.write = origWrite
  try {
    tui.stop()
  } catch {}
}

// ---------- Esc 中断 agent ----------
{
  const t2 = new TUI()
  let interrupted = 0
  t2.onInterrupt = () => interrupted++

  // 空闲时按 Esc:不触发中断(正常行编辑/Esc 忽略)
  t2.running = false
  t2.handle("\x1b")
  check("空闲时 Esc 不触发中断", interrupted === 0)

  // agent 执行中按 Esc:触发 onInterrupt
  t2.running = true
  t2.handle("\x1b")
  check("运行中 Esc 触发中断", interrupted === 1)

  // 运行中 Ctrl+C:触发中断而不是退出
  t2.handle("\x03")
  check("运行中 Ctrl+C 触发中断", interrupted === 2)

  // 运行中普通字符:忽略,不触发
  t2.handle("abc")
  check("运行中普通字符不触发中断", interrupted === 2)

  // 运行中箭头键序列:忽略,不触发中断
  t2.handle("\x1b[A")
  check("运行中箭头键不触发中断", interrupted === 2)
}

// ---------- DECRQM 模式查询响应序列(终端上报,不应进输入框) ----------
{
  const t3 = new TUI()
  t3.input = ""
  t3.cursor = 0
  // 完整的 DECRQM 响应串:ESC [ ? 2004 ; 2 $ y(2004=bracketed paste 模式号)
  const dqm = "\x1b[?2004;2$y\x1b[?2026;2$y\x1b[?1016;0$y\x1b[?1004;1$y"
  t3.handle(dqm)
  check("DECRQM 响应不进输入框", t3.input === "")

  // 序列跨 chunk 分片(ESC [ ? 20 | 04;2$y):重组后同样静默
  const t4 = new TUI()
  t4.handle("\x1b[?20")
  t4.handle("04;2$y")
  check("跨 chunk 分片的 DECRQM 不进输入框", t4.input === "")

  // 分片序列不能误触发多行粘贴判定(含分号但无换行)
  check("分片不误触粘贴", t4.pasting === false && t4.pasteBuf === "")

  // 正常字符在 DECRQM 之外仍能输入
  t3.handle("ok")
  check("普通字符仍正常输入", t3.input === "ok")
}

const failed = results.filter(([, ok]) => !ok)
process.stderr.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
process.exit(failed.length ? 1 : 0)
