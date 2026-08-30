// 会话持久化:每个会话一个 JSON 文件,存 OpenAI messages
// opencode 用 SQLite,这里为了零依赖和 armv7 兼容改用纯 JSON(功能等价:可续聊、可回放)

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

function safeId() {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${t}-${r}`
}

export class Session {
  /**
   * @param {string} dir 会话存储目录
   * @param {string} [id] 会话 ID,缺省创建新会话
   */
  constructor(dir, id) {
    this.dir = dir
    this.id = id ?? safeId()
    this.file = path.join(dir, `${this.id}.json`)
    this.messages = []
    this.meta = { id: this.id, createdAt: Date.now(), updatedAt: Date.now() }
  }

  static async load(dir, id) {
    const s = new Session(dir, id)
    try {
      const data = JSON.parse(await fsp.readFile(s.file, "utf8"))
      s.messages = data.messages ?? []
      s.meta = { ...s.meta, ...(data.meta ?? {}) }
      return s
    } catch {
      return null
    }
  }

  async save() {
    await fsp.mkdir(this.dir, { recursive: true })
    this.meta.updatedAt = Date.now()
    await fsp.writeFile(this.file, JSON.stringify({ meta: this.meta, messages: this.messages }, null, 2), "utf8")
  }

  async append(messages) {
    this.messages = messages
    await this.save()
  }

  static list(dir) {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
            return { id: data.meta?.id ?? f.slice(0, -5), updatedAt: data.meta?.updatedAt, title: data.meta?.title }
          } catch {
            return { id: f.slice(0, -5), updatedAt: 0 }
          }
        })
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    } catch {
      return []
    }
  }
}
