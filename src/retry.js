// 失败重试策略 —— 照搬 opencode packages/opencode/src/session/retry.ts
// 去掉 effect 依赖,用纯 JS 实现 retryable() 判定与 delay() 退避
// 接入点见 agent.js:整个 chat 流调用包在重试循环里(对齐 processor.ts 的 Effect.retry)

export const RETRY_INITIAL_DELAY = 2000 // 初始退避 2 秒
export const RETRY_BACKOFF_FACTOR = 2 // 退避倍率
export const RETRY_JITTER_FACTOR = 0.25 // 抖动 ±25%,避免惊群
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 无响应头时退避上限 30 秒
export const RETRY_MAX_DELAY = 2_147_483_647 // setTimeout 最大安全值
export const RETRY_MAX_RETRIES = 5 // 最大重试次数(首次请求之外)

// 照搬 retry.ts RETRYABLE_MESSAGE_PATTERNS:7 组正则,匹配错误消息/响应体
const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function matchesRetryableMessage(value) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

// 照搬 exponential:base = 2000 * 2^(attempt-1),加抖动
function exponential(attempt, random) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

/**
 * 计算本次重试等待毫秒 —— 照搬 retry.ts delay()
 * 优先级:响应头 retry-after-ms > retry-after(秒/HTTP 日期) > 指数退避
 * 有响应头时尊重服务端上限(32 位 int);无响应头时上限 30 秒
 * @param {number} attempt 当前失败次数(从 1 开始)
 * @param {{headers?: Record<string,string|number>, status?: number}} [error]
 * @param {number} [random]
 */
export function delay(attempt, error, random = Math.random()) {
  const headers = error?.headers
  if (headers) {
    const retryAfterMs = headers["retry-after-ms"] ?? headers["x-ratelimit-reset-ms"]
    if (retryAfterMs !== undefined) {
      const parsedMs = Number.parseFloat(String(retryAfterMs))
      if (!Number.isNaN(parsedMs)) return Math.min(parsedMs, RETRY_MAX_DELAY)
    }
    const retryAfter = headers["retry-after"]
    if (retryAfter !== undefined) {
      const parsedSeconds = Number.parseFloat(String(retryAfter))
      if (!Number.isNaN(parsedSeconds)) {
        // 秒 → 毫秒
        return Math.min(Math.ceil(parsedSeconds * 1000), RETRY_MAX_DELAY)
      }
      // 尝试解析为 HTTP 日期格式
      const parsed = Date.parse(String(retryAfter)) - Date.now()
      if (!Number.isNaN(parsed) && parsed > 0) return Math.min(Math.ceil(parsed), RETRY_MAX_DELAY)
    }
    return Math.min(exponential(attempt, random), RETRY_MAX_DELAY)
  }
  return Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS)
}

/**
 * 判断错误是否可重试 —— 照搬 retry.ts retryable()
 * 规则:
 * - context overflow / 非 429 的 4xx 不可重试
 * - 5xx 无条件可重试(即使 SDK 未标记)
 * - 429 / 404(openai)可重试
 * - 无状态码(网络层):匹配 RETRYABLE_MESSAGE_PATTERNS 才可重试
 * @param {{status?: number, message?: string, body?: string}} [error]
 * @param {{provider?: string}} [opts]
 * @returns {{message: string}|undefined} 可重试返回提示信息,否则 undefined
 */
export function retryable(error, { provider = "" } = {}) {
  if (!error) return undefined
  const status = error.status
  const message = error.message ?? ""
  const body = error.body ?? ""

  // 5xx 是服务端瞬时故障,无条件重试(对齐 processor.ts 注释)
  if (status !== undefined && status >= 500) return { message: message || `Server error ${status}` }
  if (status === 429) return { message: message || "Too Many Requests" }
  // openai 有时对实际上可用的模型返回 404,照搬 isOpenAiErrorRetryable
  if (status === 404 && provider.startsWith("openai")) return { message: message || "Not Found" }
  // 其余 4xx(认证/配额/参数错误)不重试
  if (status !== undefined && status >= 400 && status < 500) return undefined

  // 无状态码:网络层/超时错误,按消息模式匹配
  if (matchesRetryableMessage(message)) return { message }
  if (matchesRetryableMessage(body)) return { message: body.slice(0, 200) }
  return undefined
}
