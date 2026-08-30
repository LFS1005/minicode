import http from "node:http"

let n = 0
const srv = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    n++
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    if (n === 1) {
      send({ choices: [{ delta: { tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hello-arm-final" }) } }] }, finish_reason: null }] })
      send({ choices: [], usage: { prompt_tokens: 8123, completion_tokens: 911 } })
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
    } else {
      send({ choices: [{ delta: { content: "ALL DONE" }, finish_reason: null }] })
      send({ choices: [], usage: { prompt_tokens: 10000, completion_tokens: 1200 } })
      send({ choices: [{ delta: {}, finish_reason: "stop" }] })
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
})
srv.listen(18999, "127.0.0.1", () => console.log("fake llm on 18999"))
