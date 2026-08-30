<div align="center">

# minicode

**A terminal AI coding agent in under 1 MB of source code.**

*不到 1 MB 源码的终端 AI 编程 Agent —— 零依赖、纯 Node.js、支持 armv7*

*部分实现参照 [opencode](https://github.com/sst/opencode)。*

[![size](https://img.shields.io/badge/source%20size-%3C%201%20MB-brightgreen)](#体量)
[![deps](https://img.shields.io/badge/dependencies-0-blue)](#设计原则)
[![runtime](https://img.shields.io/badge/runtime-Node.js%20%E2%89%A5%2018.17-339933)](#安装)
[![arch](https://img.shields.io/badge/arch-x64%20%7C%20arm64%20%7C%20armv7-orange)](#安装)
[![tests](https://img.shields.io/badge/tests-148%20%2B%20e2e-success)](#测试)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

</div>

---

minicode 是一个运行在终端里的 AI 编程 Agent：**LLM 驱动的 Agent 循环 + 七个核心工具 + 会话持久化 + TUI**。整个实现压缩在 **9 个文件、2,964 行、约 104 KB 源码**，零 npm 依赖，零构建步骤。

它能在一台 armv7 的电视盒子上、用 Node.js 官方二进制直接跑起来。这就是整个项目存在的理由。

---

## 体量

| 指标 | 数值 |
|---|---|
| 源码 | **9 文件 / 2,964 行 / ≈104 KB** |
| 便携包 | 单 tar.gz ≈ 40 KB |
| 运行时 | Node.js 内置模块，**0 依赖** |
| 构建步骤 | 无（`node src/index.js` 直接跑） |
| 最低硬件 | **armv7 盒子 / 树莓派 / 旧手机刷机** |

省掉的是抽象层：依赖注入框架换成纯 async/await，数据库换成 JSON 文件，搜索二进制换成纯 JS 递归，组件框架换成纯 ANSI 转义码。**Agent 的行为模型——循环、工具调用、上下文回填——保持完整。**

## 核心能力

### 七个核心工具

| 工具 | 说明 |
|---|---|
| `bash` | 执行 shell 命令；超时/截断/退出码语义完整 |
| `read` | 文本/目录分页读取，2,000 行、50 KB、单行 2,000 字符上限，二进制检测 |
| `write` | 写文件，保留已有 BOM |
| `grep` | 正则搜索，输出格式规范，纯 JS 实现（无外部搜索二进制） |
| `glob` | glob 匹配（`**` / `*` / `?` / `{a,b}`），含忽略规则 |
| `apply_patch` | V4A 补丁算法：四层匹配（exact/rstrip/trim/normalized）、`*** Add/Update/Delete File`、上下文锚点 |
| `webfetch` | 抓取 URL 转 Markdown/text；Accept 头、浏览器 UA、5 MB 上限、MIME 过滤、script/style 跳过；HTML→Markdown 零依赖实现 |

内置忽略规则（`node_modules`、`.git`、`dist`、`__pycache__` 等约 30 项），自动跳过无关目录与文件。

### Agent 循环

`输入 → LLM(流式 SSE) → 工具调用 → 结果回填 → 继续`，直到模型停止调用工具。消息结构与事件模型（`step_start` / `message.part.updated` / `session.status` / `usage`）兼容任何 OpenAI 兼容端点（OpenAI / DeepSeek / vLLM / Ollama / one-api）。

### TUI（零依赖）

- 备用屏幕渲染（退出不污染 shell 历史）、每帧清屏重绘
- 滚动输出区 + 状态行 + 输入行，**内建滚动条**（PageUp/PageDown）
- **鼠标滚轮直接滚动输出区**（SGR 鼠标上报，alternate-scroll 已禁用）
- bracketed paste：粘贴多行文本不误发送；宽字符（中文）光标定位按显示宽度计算
- agent 执行中 **Esc / Ctrl+C 中断当前任务**，保留会话、可继续输入
- `/config` 配置向导、`/history` 历史会话选择加载、`/model`、`/new`、`/exit`
- 右下角常驻 token 统计（`xx.xk used`）
- 无 TTY 时自动降级 readline；`--no-tui` 强制降级

### 会话与配置

- 会话持久化为 JSON 文件（`~/.minicode/sessions/`），可列出、可加载续聊
- 配置优先级：环境变量 > `~/.config/minicode/config.json` > 默认值
- 兼容 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`

## 安装

### 便携包（推荐，任何平台含 armv7）

```bash
tar -xzf minicode-portable-<版本>.tar.gz && cd minicode && bash install.sh
```

`install.sh` 自动完成：
- 复制到 `~/.minicode/`，生成 `~/.local/bin/minicode` 启动命令
- **PATH 永久化**：Linux/macOS 写入 `~/.bashrc` / `~/.zshrc` / `~/.profile`；Windows 写入用户环境变量（重复安装自动去重）
- 可选：安装时传入 API 配置即全局生效

```bash
MINICODE_API_KEY=sk-xxx MINICODE_BASE_URL=https://api.deepseek.com/v1 MINICODE_MODEL=deepseek-chat bash install.sh
```

自定义目录：`MINICODE_INSTALL_DIR=/opt/minicode bash install.sh`

### 从源码运行

```bash
node src/index.js
```

要求：Node.js ≥ 18.17（内置 fetch / fs/promises）。无任何 npm 依赖，无需 `npm install`。

## 快速开始

```bash
# 配置（三选一）
export MINICODE_API_KEY=sk-...        # 1) 环境变量
echo '{"apiKey":"sk-..."}' > ~/.config/minicode/config.json   # 2) 配置文件
minicode   → 输入 /config              # 3) TUI 配置向导

# 本地模型（如 Ollama）免 Key
export MINICODE_BASE_URL=http://localhost:11434/v1

# 运行
minicode                          # TTY 下进入 TUI
minicode -y "总结当前目录"         # 非交互，执行完退出
minicode -y --format json "..." | jq   # JSON 事件流
```

## 架构

```
src/                       ≈104 KB 合计
  index.js    (626 行)  CLI 入口：TUI/readline 双路径、-y 非交互、--format json 事件流、/命令
  tui.js      (689 行)  纯 ANSI TUI：滚动区/滚动条/鼠标/粘贴/表单/宽字符/中断
  tools.js    (947 行)  七个核心工具 + ignore 规则 + 补丁算法 + HTML→Markdown
  agent.js    (230 行)  Agent 循环、事件发射、失败重试调度
  llm.js      (183 行)  OpenAI 兼容客户端：流式 SSE、工具调用增量累积、usage 捕获、取消信号
  retry.js    ( 94 行)  失败重试策略：可重试判定 + 指数退避 + retry-after
  config.js   (102 行)  配置解析与保存
  session.js  ( 68 行)  JSON 会话持久化
  prompt.js   ( 25 行)  系统提示词
test/                     148 项单测 + 4 套端到端
  tools.test.mjs (30)   补丁算法、grep/glob、bash、webfetch 转换
  smoke.test.mjs (18)   假 OpenAI 服务器跑通完整 Agent 循环
  cli.test.mjs    (6)   stdout/stderr 分离、JSON 事件流
  tui.test.mjs   (59)   渲染/按键/滚动/粘贴/宽字符/表单/滚轮/中断
  retry.test.mjs (35)   重试判定/退避/429/500/流式中断/取消
  *_e2e.mjs            winpty/pty 真实终端端到端（无 pty 自动 SKIP）
```

## 设计原则

1. **零依赖**：只用 Node.js 内置模块。任何新功能先问"能不能不加包"。
2. **行为可预期**：工具描述、参数、边界语义稳定，便于自动化与对比。
3. **可整包读源码**：约 3,000 行，一个下午能全部读完。
4. **老硬件优先**：armv7 是最低门槛，所有实现选择都以此为约束。

## 失败自动重试

对暂时性故障自动重试，无需人工干预：

- **可重试判定**：5xx 无条件重试；429、OpenAI 的 404 可重试；匹配 7 组错误模式（`rate limit` / `overloaded` / `fetch failed` / 连接重置 / 超时等）可重试；**401/400/403 等认证与参数错误不重试**，直接报错
- **退避策略**：初始 2s、倍率 ×2、抖动 ±25%；有响应头时优先尊重 `retry-after-ms` / `retry-after`（秒或 HTTP 日期）；无头时上限 30s
- **最多 5 次重试**，重试期间状态行显示 `⚠ 重试 (n/5): 原因`；流式中断的半截文本自动回退，重试成功后完整重新输出

```bash
npm test                      # 148 项单测（tools + smoke + cli + tui + retry）
node test/tui-e2e.mjs         # 端到端（需 winpty/script，无 pty 自动 SKIP）
```

## Roadmap

- [ ] 权限确认门（bash/write 执行前交互确认）——优先级最高
- [ ] `websearch` 工具
- [ ] build/plan 双 Agent 角色切换
- [ ] 会话标题自动生成
- [ ] MCP 最小子集

## FAQ

**Q: 为什么不用 npm 分发？**
便携包约 40 KB，拷到任何机器 `bash install.sh` 即可，不需要 Node 生态在线。npm 分发保留为备选（`npm publish` 即可，`package.json` 已就绪）。

**Q: 支持 Claude / Gemini 吗？**
任何暴露 OpenAI 兼容 `/v1/chat/completions` 端点的模型都可以（含 one-api / litellm 代理）。

**Q: 安全吗？**
bash 工具以当前用户权限执行命令。权限确认门在 Roadmap 首位；在此之前请只在可信环境使用。

## License

[MIT](LICENSE)
