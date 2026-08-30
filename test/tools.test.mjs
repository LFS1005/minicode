// 工具层单测:验证照搬 opencode 的 patch 算法与输出格式
// 运行: node test/tools.test.mjs

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildTools, applyPatchTool, grepTool, globTool, bashTool, writeTool, readTool } from "../src/tools.js"

const results = []
const check = (name, cond) => {
  results.push([name, cond])
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`)
}

const shell = process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh"
const reg = buildTools({ shell })
const ctx = (dir) => ({ cwd: dir, shell, maxTimeout: 300_000 })

const dir = mkdtempSync(path.join(tmpdir(), "lite-tools-"))

// ---------- write + read ----------
await writeTool.execute({ path: "a.txt", content: "line1\nline2\nline3\n" }, ctx(dir))
const readOut = await readTool.execute({ path: "a.txt" }, ctx(dir))
check("read 返回完整内容", readOut.includes("line1") && readOut.includes("line3"))

const readPage = await readTool.execute({ path: "a.txt", offset: 2, limit: 1 }, ctx(dir))
check("read 分页含 meta", readPage.includes("showing 2-2"))

// ---------- bash ----------
const bashOut = await bashTool.execute({ command: "echo hello" }, ctx(dir))
check("bash 输出含退出码行", bashOut.includes("Command exited with code 0."))
check("bash 输出含 stdout", bashOut.includes("hello"))

const bashFail = await bashTool.execute({ command: "exit 3" }, ctx(dir))
check("bash 失败含退出码 3", bashFail.includes("Command exited with code 3."))

// ---------- apply_patch:新增文件 ----------
const addPatch = `*** Begin Patch
*** Add File: new.txt
+hello world
+second line
*** End Patch
`
const addOut = await applyPatchTool.execute({ patchText: addPatch }, ctx(dir))
check("apply_patch 新增文件标记 A", addOut.includes("A ") && addOut.includes("new.txt"))
check("apply_patch 实际创建", readFileSync(path.join(dir, "new.txt"), "utf8") === "hello world\nsecond line\n")

// ---------- apply_patch:更新文件(带模糊匹配:末尾空格/引号变体) ----------
writeFileSync(path.join(dir, "b.txt"), "const x = 'hi'\nconst y = 2\n")
const updatePatch = `*** Begin Patch
*** Update File: b.txt
@@
-const x = 'hi'
+const x = 'hello'
*** End Patch
`
const updOut = await applyPatchTool.execute({ patchText: updatePatch }, ctx(dir))
check("apply_patch 更新文件标记 M", updOut.includes("M ") && updOut.includes("b.txt"))
check("apply_patch 更新生效", readFileSync(path.join(dir, "b.txt"), "utf8") === "const x = 'hello'\nconst y = 2\n")

// ---------- apply_patch:heredoc 包装(照搬 stripHeredoc) ----------
const heredocPatch = `cat <<'EOF'
*** Begin Patch
*** Add File: h.txt
+heredoc content
*** End Patch
EOF
`
const hOut = await applyPatchTool.execute({ patchText: heredocPatch }, ctx(dir))
check("apply_patch heredoc 解析", hOut.includes("h.txt"))
check("heredoc 文件创建", readFileSync(path.join(dir, "h.txt"), "utf8") === "heredoc content\n")

// ---------- apply_patch:查找失败报错 ----------
const badPatch = `*** Begin Patch
*** Update File: b.txt
@@
-no such line at all
+replacement
*** End Patch
`
const badOut = await applyPatchTool.execute({ patchText: badPatch }, ctx(dir))
check("apply_patch 未找到时报错", badOut.includes("Failed to find expected lines"))

// ---------- apply_patch:删除文件 ----------
writeFileSync(path.join(dir, "del.txt"), "to be deleted\n")
const delPatch = `*** Begin Patch
*** Delete File: del.txt
*** End Patch
`
const delOut = await applyPatchTool.execute({ patchText: delPatch }, ctx(dir))
check("apply_patch 删除标记 D", delOut.includes("D ") && delOut.includes("del.txt"))
const { existsSync } = await import("node:fs")
check("删除生效", !existsSync(path.join(dir, "del.txt")))

// ---------- grep 输出格式(照搬 toModelOutput) ----------
writeFileSync(path.join(dir, "g.txt"), "foo bar\nnothing here\nfoo baz\n")
const grepOut = await grepTool.execute({ pattern: "foo" }, ctx(dir))
check("grep Found N matches", grepOut.includes("Found 2 matches"))
check("grep 文件路径行", grepOut.includes("g.txt:"))
check("grep 行号格式", grepOut.includes("  Line 1: foo bar"))
check("grep 无匹配 No files found", (await grepTool.execute({ pattern: "zzzznope" }, ctx(dir))) === "No files found")

// ---------- glob ----------
writeFileSync(path.join(dir, "x.ts"), "")
writeFileSync(path.join(dir, "y.js"), "")
const globOut = await globTool.execute({ pattern: "*.ts" }, ctx(dir))
check("glob 匹配 *.ts", globOut === "x.ts")
const globAll = await globTool.execute({ pattern: "**/*.js" }, ctx(dir))
check("glob 匹配 **/*.js", globAll === "y.js")
check("glob 无匹配 No files found", (await globTool.execute({ pattern: "*.rs" }, ctx(dir))) === "No files found")

// ---------- webfetch(照搬 webfetch.ts 语义) ----------
const { extractTextFromHTML, convertHTMLToMarkdown } = await import("../src/tools.js")
const html = `<!doctype html><html><head><style>.x{}</style><script>alert(1)</script></head><body>
<h1>标题</h1><p>Hello <b>world</b> <a href="https://a.b">link</a></p>
<ul><li>item1</li><li>item2</li></ul>
<pre><code>code here</code></pre>
</body></html>`
const md = convertHTMLToMarkdown(html)
check("webfetch markdown 标题", md.includes("# 标题"))
check("webfetch markdown 粗体", md.includes("**world**"))
check("webfetch markdown 链接", md.includes("[link](https://a.b)"))
check("webfetch markdown 列表", md.includes("- item1"))
check("webfetch markdown 代码块", md.includes("```"))
check("webfetch markdown 剔除 script/style", !md.includes("alert") && !md.includes(".x"))
const text = extractTextFromHTML(html)
check("webfetch text 提取纯文本", text.includes("Hello world link") && !text.includes("alert"))

// ---------- 注册表 ----------
const defs = reg.definitions()
check("注册表含 7 个工具", defs.length === 7)
check("工具名集合", ["bash", "read", "write", "grep", "glob", "apply_patch", "webfetch"].every((n) => reg.get(n)))

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
