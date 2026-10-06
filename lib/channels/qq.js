/**
 * QQ 官方机器人通道（手写，零依赖）。
 *
 * 链路：AppID/AppSecret → access_token → GET /gateway → WebSocket
 *       → op10 hello → op2 identify → op0 事件 → REST 发消息。
 *
 * 关键坑（来自官方文档与官方 SDK 源码核实，见 docs/PROTOCOL.md）：
 *  - 私聊 intent 是 GROUP_AND_C2C_EVENT = 1 << 25，不是 DIRECT_MESSAGE；
 *    且该权限位需要在开放平台单独申请，订阅无权限位会直接被断开。
 *  - 单聊被动回复窗口是 60 分钟 / 最多 4 次；同一个 msg_id 重复用同一个
 *    msg_seq 会被去重失败，必须递增。
 *  - token 接口失败时 HTTP 仍是 200，必须判 body.code。
 *  - 单聊富媒体只支持「URL 直传」和「分片上传合并」，**没有 base64 直传**；
 *    本地文件必须走 upload_prepare → PUT 分片 → upload_part_finish → files 合并。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { imageMediaTypeFor } from '../media.js'

const INTENT_GROUP_AND_C2C = 1 << 25
const TOKEN_HOST = 'https://api.bot.qq.com'
const PROBE_INTERVAL_MS = 45_000
const MAX_PASSIVE_REPLIES = 4
const PASSIVE_WINDOW_MS = 55 * 60_000
/** upload_prepare 的 md5_10m 取文件前 10002432 字节。 */
const MD5_10M_BYTES = 10_002_432
/** 空内容的 MD5 —— ETag 等于它就说明这一片根本没传上去。 */
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'

/** 官方 file_type：1=图片, 2=视频, 3=语音, 4=文件。 */
function guessFileType(fileName) {
  const ext = String(fileName).toLowerCase().split('.').pop()
  if (['png', 'jpg', 'jpeg'].includes(ext)) return 1
  if (ext === 'mp4') return 2
  if (['silk', 'slk'].includes(ext)) return 3
  return 4
}

/**
 * C2C 事件的 `attachments[]` → 通用附件描述。
 * 字段（官方）：{url, filename, size, content_type, width, height}
 */
export function mediaOf(data) {
  const out = []
  for (const item of data?.attachments ?? []) {
    if (!item?.url) continue
    const isImage = imageMediaTypeFor(item.filename, item.content_type) !== null
    out.push({
      kind: isImage ? 'image' : 'file',
      name: item.filename || (isImage ? 'image' : 'file'),
      url: item.url,
      contentType: item.content_type,
      size: item.size,
    })
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createQqChannel({ appId, appSecret, sandbox = false, log = console, onMessage, onStatus }) {
  const apiBase = sandbox ? 'https://sandbox.api.sgroup.qq.com' : TOKEN_HOST

  let token = null
  let tokenExpiresAt = 0
  let ws = null
  let heartbeat = null
  let seq = null
  let sessionId = null
  let stopped = false
  let retry = 0
  let state = 'idle'

  /** Per-chat passive-reply bookkeeping (msg_id + how many times we used it). */
  const replyContext = new Map()

  function setState(next, detail) {
    if (state === next) return
    state = next
    log.info?.(`[im-bridge/qq] 状态: ${next}${detail ? ` (${detail})` : ''}`)
    onStatus?.({ channelId: 'qq', state: next, detail })
  }

  async function call(path, { method = 'GET', body, auth = true, host = apiBase, timeoutMs = 20_000 } = {}) {
    const headers = { 'Content-Type': 'application/json' }
    if (auth) headers.Authorization = `QQBot ${await getToken()}`
    const response = await fetch(`${host}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // 大文件分片 PUT 走的不是这里，所以 20s 对所有 REST 调用都够。
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = { raw: text }
    }
    if (!response.ok) {
      const error = new Error(`QQ API ${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`)
      error.status = response.status
      error.body = json
      throw error
    }
    return json
  }

  async function getToken(force = false) {
    if (!force && token && Date.now() < tokenExpiresAt - 60_000) return token
    // 失败时 HTTP 仍为 200，必须判 code。
    const json = await call('/app/getAppAccessToken', {
      method: 'POST',
      auth: false,
      host: TOKEN_HOST,
      body: { appId, clientSecret: appSecret },
    })
    if (json.code) {
      throw new Error(`QQ 取 token 失败: ${json.code} ${json.message ?? ''}`)
    }
    if (!json.access_token) throw new Error(`QQ 取 token 失败: ${JSON.stringify(json).slice(0, 200)}`)
    token = json.access_token
    tokenExpiresAt = Date.now() + Number(json.expires_in ?? 7200) * 1000
    return token
  }

  function handleDispatch(eventType, data) {
    if (eventType !== 'C2C_MESSAGE_CREATE') return
    const openid = data?.author?.user_openid
    if (!openid) return
    // 机器人自己发的消息不回环（正常不会出现，防御性处理）。
    if (data?.author?.bot) return
    replyContext.set(openid, { msgId: data.id, count: 0, at: Date.now() })
    onMessage?.({
      channelId: 'qq',
      chatId: openid,
      userId: openid,
      text: String(data.content ?? ''),
      messageId: String(data.id ?? ''),
      media: mediaOf(data),
      raw: data,
    })
  }

  function handlePayload(payload) {
    const { op, d, s, t } = payload ?? {}
    if (typeof s === 'number') seq = s
    switch (op) {
      case 10: // Hello
        startHeartbeat(d?.heartbeat_interval ?? PROBE_INTERVAL_MS)
        identify()
        break
      case 0: // Dispatch
        if (t) handleDispatch(t, d)
        break
      case 11: // Heartbeat ACK
        break
      case 7: // Reconnect
        log.info?.('[im-bridge/qq] 收到 RECONNECT，重连中')
        reconnect()
        break
      case 9: // Invalid Session
        log.warn?.('[im-bridge/qq] Invalid Session，重新 identify')
        sessionId = null
        seq = null
        setTimeout(() => connect(), 2000)
        break
      default:
        break
    }
  }

  function startHeartbeat(intervalMs) {
    stopHeartbeat()
    heartbeat = setInterval(() => {
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ op: 1, d: seq }))
      }
    }, Math.max(5000, intervalMs))
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  function identify() {
    if (ws?.readyState !== 1) return
    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: INTENT_GROUP_AND_C2C,
        shard: [0, 1],
        properties: {},
      },
    }))
    setState('online')
    retry = 0
  }

  function reconnect() {
    try {
      ws?.close()
    } catch {
      /* already closed */
    }
    ws = null
    stopHeartbeat()
    setTimeout(() => connect(), 1000)
  }

  async function connect() {
    if (stopped) return
    setState('connecting')
    let url
    try {
      await getToken()
      const gateway = await call('/gateway')
      url = gateway.url
      if (!url) throw new Error(`gateway 未返回 url: ${JSON.stringify(gateway).slice(0, 200)}`)
    } catch (error) {
      log.warn?.(`[im-bridge/qq] 取网关失败: ${error?.message ?? error}`)
      scheduleRetry()
      return
    }

    if (typeof WebSocket !== 'function') {
      setState('error', '当前运行时没有全局 WebSocket')
      return
    }

    ws = new WebSocket(url)

    ws.onopen = () => log.info?.('[im-bridge/qq] WebSocket 已连接，等待 Hello')
    ws.onmessage = (event) => {
      try {
        handlePayload(JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)))
      } catch (error) {
        log.warn?.(`[im-bridge/qq] 解析事件失败: ${error?.message ?? error}`)
      }
    }
    ws.onerror = () => log.warn?.('[im-bridge/qq] WebSocket 错误')
    ws.onclose = (event) => {
      stopHeartbeat()
      ws = null
      const code = event?.code
      // 4914 机器人已下架（只允许沙箱）、4915 机器人已封禁 —— 重连无意义。
      if (code === 4914 || code === 4915) {
        setState('fatal', `close ${code}`)
        stopped = true
        return
      }
      if (code === 4004) {
        token = null
        tokenExpiresAt = 0
      }
      if (!stopped) {
        log.warn?.(`[im-bridge/qq] 连接关闭 (${code})，准备重连`)
        scheduleRetry()
      }
    }
  }

  function scheduleRetry() {
    if (stopped) return
    retry += 1
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(retry, 6))
    setState('reconnecting', `${retry} 次，${Math.round(delay / 1000)}s 后重试`)
    setTimeout(() => connect(), delay)
  }

  /** One outbound text. Uses passive reply while the 60min/4-times budget allows. */
  async function sendText(chatId, text) {
    const context = replyContext.get(chatId)
    const passive = context
      && Date.now() - context.at < PASSIVE_WINDOW_MS
      && context.count < MAX_PASSIVE_REPLIES
    const body = { content: String(text ?? ''), msg_type: 0 }
    if (passive) {
      context.count += 1
      body.msg_id = context.msgId
      body.msg_seq = context.count
    }
    const result = await call(`/v2/users/${encodeURIComponent(chatId)}/messages`, { method: 'POST', body })
    if (result?.code) throw new Error(`QQ 发消息失败: ${result.code} ${result.message ?? ''}`)
    return result
  }

  /** 官方 40093001「分片转存 BDH 通道异常，请重试」明确要求重试。 */
  const RETRYABLE_QQ_CODES = new Set([40093001, 850027, 850026])

  function isRetryable(error) {
    const code = error?.body?.code
    if (code !== undefined && RETRYABLE_QQ_CODES.has(code)) return true
    return (error?.status ?? 0) >= 500
  }

  /** 通知服务端某个分片完成；失败按官方建议重试。 */
  async function finishPart(base, uploadId, index, chunk, diag) {
    const body = {
      upload_id: uploadId,
      part_index: index,
      block_size: String(chunk.length),
      md5: createHash('md5').update(chunk).digest('hex'),
    }
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await call(`${base}/upload_part_finish`, { method: 'POST', body })
        if (attempt > 1) diag.push(`part ${index}: 第 ${attempt} 次 finish 成功`)
        return
      } catch (error) {
        lastError = error
        const code = error?.body?.code ?? error?.status
        diag.push(`part ${index}: finish 第 ${attempt} 次失败 code=${code} ${String(error?.body?.message ?? error?.message ?? '').slice(0, 80)}`)
        if (!isRetryable(error)) break
        await sleep(1200 * attempt)
      }
    }
    throw lastError
  }

  /**
   * 本地文件 → 单聊富媒体：upload_prepare → 逐片 PUT + upload_part_finish
   * → /files 合并拿 file_info。官方明确没有 base64 直传，只能走这条路。
   *
   * 失败时把每一片的 PUT 状态/ETag/字节数都带进错误信息里 —— 否则只剩一个
   * trace_id，完全无法定位是"没传上去"还是"服务端转存失败"。
   */
  async function uploadForC2C(chatId, absPath, fileName) {
    const data = fs.readFileSync(absPath)
    if (!data.length) throw new Error('文件为空')
    const base = `/v2/users/${encodeURIComponent(chatId)}`
    const fileType = guessFileType(fileName)
    const diag = [`file=${fileName} bytes=${data.length} file_type=${fileType}`]

    // 整轮重试：分片通道偶发异常时，从 upload_prepare 重新来一遍往往就好了。
    let lastError
    for (let round = 1; round <= 2; round += 1) {
      try {
        const prepared = await call(`${base}/upload_prepare`, {
          method: 'POST',
          body: {
            file_type: fileType,
            file_size: String(data.length),
            file_name: fileName,
            md5: createHash('md5').update(data).digest('hex'),
            sha1: createHash('sha1').update(data).digest('hex'),
            md5_10m: createHash('md5').update(data.subarray(0, MD5_10M_BYTES)).digest('hex'),
          },
        })
        const uploadId = prepared?.upload_id
        const parts = prepared?.parts ?? []
        if (!uploadId || !parts.length) {
          throw new Error(`预上传未返回分片: ${JSON.stringify(prepared).slice(0, 200)}`)
        }
        const blockSize = Number(prepared.block_size) || data.length
        diag.push(`round ${round}: upload_id=${uploadId} parts=${parts.length} block_size=${blockSize}`)

        // ⚠️ **不要用 part.index 当切片偏移**。官方文档写"从 0 开始"，但实际响应里
        // 见到过 index=1（0 基/1 基混用）。用 index × block_size 会在 1 基时切出
        // 空缓冲区 → PUT 0 字节 → 服务端拿不到数据 → 40093001「分片转存异常」。
        // 正确做法：按 index 排序后，用**累计偏移**依次切片。
        const ordered = [...parts].sort((a, b) => Number(a.index) - Number(b.index))
        let offset = 0
        for (const [position, part] of ordered.entries()) {
          const index = Number(part.index)
          const declared = Number(part.block_size) || blockSize
          const start = offset
          const chunk = data.subarray(start, start + declared)
          offset += chunk.length
          if (!chunk.length) {
            throw new Error(
              `分片 ${index}（第 ${position + 1} 片）切出 0 字节：offset=${start} declared=${declared} 文件=${data.length}B`,
            )
          }
          const put = await fetch(part.presigned_url, { method: 'PUT', body: chunk })
          const etag = String(put.headers.get('etag') ?? '').replace(/"/g, '') || '(无 ETag)'
          const expectedMd5 = createHash('md5').update(chunk).digest('hex')
          diag.push(`  part ${index}(第${position + 1}片): PUT ${put.status} sent=${chunk.length} offset=${start} etag=${etag}`)
          // ETag 应当等于所发内容的 MD5；空内容的 MD5 就是 d41d8cd9…，一眼可辨。
          if (etag !== '(无 ETag)' && etag !== expectedMd5) {
            diag.push(`    ⚠️ ETag 与所发内容 MD5 不一致（期望 ${expectedMd5.slice(0, 8)}…）—— CDN 可能存了空/错的块`)
          } else if (etag === EMPTY_MD5) {
            diag.push('    ⚠️ ETag 是空内容的 MD5 —— 分片没真正传上去')
          }
          if (!put.ok) {
            const text = await put.text().catch(() => '')
            throw new Error(`分片 ${index} PUT 失败 HTTP ${put.status}: ${text.slice(0, 160)}`)
          }
          await finishPart(base, uploadId, index, chunk, diag)
        }
        if (offset !== data.length) {
          throw new Error(`分片未覆盖整个文件：已传 ${offset}B / 共 ${data.length}B`)
        }

        const merged = await call(`${base}/files`, {
          method: 'POST',
          body: { file_type: fileType, srv_send_msg: false, file_name: fileName, upload_id: uploadId },
        })
        if (!merged?.file_info) {
          throw new Error(`合并文件未返回 file_info: ${JSON.stringify(merged).slice(0, 200)}`)
        }
        return merged.file_info
      } catch (error) {
        lastError = error
        diag.push(`round ${round} 失败: ${String(error?.body?.message ?? error?.message ?? error).slice(0, 120)}`)
        if (!isRetryable(error) || round === 2) break
        diag.push('按官方建议整轮重试…')
        await sleep(2000)
      }
    }

    const error = new Error(
      `QQ 富媒体上传失败：${lastError?.body?.message ?? lastError?.message ?? lastError}\n`
      + `诊断（把这段发我可定位）：\n${diag.join('\n')}`,
    )
    error.diagnostics = diag
    throw error
  }

  async function sendFile(chatId, absPath, fileName) {
    const name = fileName || path.basename(absPath)
    const fileInfo = await uploadForC2C(chatId, absPath, name)
    const body = { msg_type: 7, media: { file_info: fileInfo } }
    // 富媒体同样消耗被动回复预算，超了就退化为主动推送。
    const context = replyContext.get(chatId)
    if (context && Date.now() - context.at < PASSIVE_WINDOW_MS && context.count < MAX_PASSIVE_REPLIES) {
      context.count += 1
      body.msg_id = context.msgId
      body.msg_seq = context.count
    }
    const result = await call(`/v2/users/${encodeURIComponent(chatId)}/messages`, { method: 'POST', body })
    if (result?.code) throw new Error(`QQ 发文件失败: ${result.code} ${result.message ?? ''}`)
    return result
  }

  return {
    id: 'qq',
    get state() {
      return state
    },
    async start() {
      stopped = false
      await connect()
    },
    async stop() {
      stopped = true
      stopHeartbeat()
      try {
        ws?.close()
      } catch {
        /* noop */
      }
      ws = null
    },
    async configure() {
      // 幂等：重连以便应用新凭据
      reconnect()
    },
    sendText,
    sendFile,
    status() {
      return { channelId: 'qq', state, sandbox }
    },
  }
}

export { INTENT_GROUP_AND_C2C, sleep }
