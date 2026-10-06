/**
 * 微信 ClawBot / iLink 通道（官方协议，手写 HTTP 长轮询，零依赖）。
 *
 * 协议来源：Tencent/openclaw-weixin 的 docs/protocol_zh_CN.md
 * 端点与字段细节见本仓库 docs/PROTOCOL.md。
 *
 * 与 QQ 通道最大的不同：
 *  - 收消息是 **长轮询** getupdates（不是 WebSocket），用不透明游标
 *    get_updates_buf 续传，必须持久化。
 *  - 回复必须回传入站消息的 context_token，它不是 message_id。
 *  - token 没有刷新接口，ret = -14 只能重新扫码（官方还会暂停该账号 1 小时）。
 *  - 同一个 token 只能单实例运行。
 *  - 附件：getuploadurl 拿预签名地址 → AES-128-ECB/PKCS#7 本地加密 →
 *    传到 CDN → 用响应头 `x-encrypted-param` 作为 encrypt_query_param 发消息。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

import { appendMediaLog, tryDecryptMedia } from '../media.js'

const ILINK_HOST = 'https://ilinkai.weixin.qq.com'
const CDN_UPLOAD = 'https://novac2c.cdn.weixin.qq.com/c2c/upload'
const APP_ID = 'bot'
/** 0x00MMNNPP —— 与我们要使用的协议版本一致（2.4.9）。 */
const APP_CLIENT_VERSION = String(0x00020409)
const DEFAULT_CHANNEL_VERSION = '2.4.9'

/** 官方 media_type：1=图片, 2=视频, 3=文件, 4=语音。 */
function guessMediaType(fileName) {
  const ext = String(fileName).toLowerCase().split('.').pop()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 1
  if (['mp4', 'mov', 'm4v', 'avi'].includes(ext)) return 2
  if (['silk', 'slk', 'mp3', 'wav', 'amr', 'm4a'].includes(ext)) return 4
  return 3
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * message_id 是 uint64，JSON.parse 会丢精度；先把长整数改成字符串再解析。
 */
function parseLossless(text) {
  const patched = String(text).replace(/"message_id"\s*:\s*(\d{15,})/g, '"message_id":"$1"')
  try {
    return JSON.parse(patched)
  } catch {
    return {}
  }
}

/** 每请求重新生成的随机 uint32（十进制字符串再 base64）。 */
function randomUin() {
  const n = Math.floor(Math.random() * 0xffff_ffff)
  return Buffer.from(String(n), 'utf8').toString('base64')
}

/** 从 item_list 里取出可读文本（含语音转写）。 */
function textOf(message) {
  const parts = []
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && item.text_item?.text) parts.push(String(item.text_item.text))
    else if (item?.type === 3 && item.voice_item?.text) parts.push(`[语音] ${item.voice_item.text}`)
    else if (item?.type === 2) parts.push('[图片]')
    else if (item?.type === 4) parts.push(`[文件] ${item.file_item?.file_name ?? ''}`.trim())
    else if (item?.type === 5) parts.push('[视频]')
  }
  return parts.join('\n').trim()
}

/**
 * item_list 里的图片/文件 → 通用附件描述。
 *
 * CDNMedia = {encrypt_query_param, aes_key, encrypt_type, full_url}；
 * 优先用 full_url（若服务端给了完整地址），否则拼 /c2c/download。
 * 内容大概率是 AES-128-ECB 加密的，aes_key 一起带下去解密。
 */
export function mediaOf(message, baseUrl) {
  const out = []
  const fallbackName = (ext) => `media-${message?.message_id ?? Date.now()}.${ext}`
  const push = (kind, item, name) => {
    const url = item?.full_url
      || `${baseUrl}/c2c/download?encrypted_query_param=${encodeURIComponent(item?.encrypt_query_param ?? '')}`
    if (!url.startsWith('http')) return
    out.push({ kind, name, url, aesKey: item?.aes_key, encryptType: item?.encrypt_type })
  }
  for (const item of message?.item_list ?? []) {
    if (item?.type === 2 && item.image_item?.media) push('image', item.image_item.media, fallbackName('jpg'))
    else if (item?.type === 4 && item.file_item?.media) push('file', item.file_item.media, item.file_item.file_name || fallbackName('bin'))
  }
  return out
}

export function createWechatChannel({
  log = console,
  onMessage,
  onStatus,
  onSession,
  onLoginStatus,
  onQr,
  autoRenew = true,
  maxRenewals = 20,
  verifyUploadMaxBytes = 4 * 1024 * 1024,
  credentials = {},
  channelVersion = DEFAULT_CHANNEL_VERSION,
}) {
  let botToken = credentials.botToken ?? null
  let baseUrl = credentials.baseUrl ?? ILINK_HOST
  let cursor = credentials.getUpdatesBuf ?? ''
  let stopped = false
  let state = botToken ? 'idle' : 'need-login'
  let polling = null
  let login = null
  let lastLoginStatus = null
  let stateReported = false
  let renewals = 0

  /** chatId -> 最近一条入站消息的 context_token（回复锚点）。 */
  const contextTokens = new Map()

  const baseInfo = () => ({ channel_version: channelVersion, bot_agent: 'dsh-im-bridge' })

  function setState(next, detail) {
    // 首次也必须上报，否则"初始状态恰好是 need-login"时状态文件里会完全没有微信通道。
    if (state === next && stateReported) return
    state = next
    stateReported = true
    log.info?.(`[im-bridge/wechat] 状态: ${next}${detail ? ` (${detail})` : ''}`)
    onStatus?.({ channelId: 'wechat', state: next, detail })
  }

  function headers(auth = true) {
    const h = {
      'Content-Type': 'application/json',
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': APP_CLIENT_VERSION,
      'X-WECHAT-UIN': randomUin(),
    }
    if (auth && botToken) {
      h.Authorization = `Bearer ${botToken}`
      h.AuthorizationType = 'ilink_bot_token'
    }
    return h
  }

  async function request(url, { method = 'POST', body, auth = true, timeoutMs = 20_000 } = {}) {
    const response = await fetch(url, {
      method,
      headers: headers(auth),
      body: body === undefined ? undefined : JSON.stringify(body),
      // 没有超时的话，网络卡住会让命令永远不出结果（客户端看起来就是"什么都没有"）。
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    const json = parseLossless(text)
    if (!response.ok) {
      const error = new Error(`iLink ${method} ${url} -> HTTP ${response.status}: ${text.slice(0, 200)}`)
      error.status = response.status
      throw error
    }
    return json
  }

  // ---------------------------------------------------------------- 扫码绑定

  async function beginLogin() {
    if (login) return login.qrcodeImgContent
    const started = await request(`${ILINK_HOST}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: 'POST',
      auth: false,
      body: { local_token_list: [] },
    })
    if (!started?.qrcode) throw new Error(`取二维码失败: ${JSON.stringify(started).slice(0, 200)}`)
    login = { qrcode: started.qrcode, qrcodeImgContent: started.qrcode_img_content, host: ILINK_HOST }
    setState('waiting-scan')
    // 注意：qrcode_img_content 不是图片地址，而是**要被编码进二维码**的链接，
    // 交给调用方去渲染成本地二维码。
    onQr?.(started.qrcode_img_content, { qrcode: started.qrcode })
    void pollLoginStatus()
    return started.qrcode_img_content
  }

  async function pollLoginStatus() {
    const current = login
    if (!current) return
    const deadline = Date.now() + 5 * 60_000
    while (!stopped && login === current && Date.now() < deadline) {
      let status
      try {
        const url = `${current.host}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(current.qrcode)}`
        // 这个接口本身就是 35s 长轮询：客户端必须留更长余量，
        // 否则会被自己的超时掐断，永远等不到 scaned/confirmed。
        status = await request(url, { method: 'GET', auth: false, timeoutMs: 60_000 })
      } catch (error) {
        const aborted = error?.name === 'TimeoutError' || /aborted due to timeout/i.test(String(error?.message))
        if (!aborted) log.warn?.(`[im-bridge/wechat] 扫码状态查询失败: ${error?.message ?? error}`)
        await sleep(aborted ? 500 : 2000)
        continue
      }
      if (status?.status && status.status !== lastLoginStatus) {
        lastLoginStatus = status.status
        log.info?.(`[im-bridge/wechat] 扫码状态: ${status.status}`)
        onLoginStatus?.(status.status, status)
      }
      switch (status?.status) {
        case 'confirmed': {
          botToken = status.bot_token
          baseUrl = status.baseurl || ILINK_HOST
          login = null
          onSession?.({
            botToken,
            baseUrl,
            ilinkBotId: status.ilink_bot_id,
            ilinkUserId: status.ilink_user_id,
          })
          setState('idle', '扫码成功')
          renewals = 0
          void startPolling()
          return
        }
        case 'expired':
        case 'verify_code_blocked': {
          login = null
          // 二维码只有约 2 分钟有效，人工扫码很容易来不及 —— 自动换新。
          if (status.status === 'expired' && autoRenew && !stopped && renewals < maxRenewals) {
            renewals += 1
            log.info?.(`[im-bridge/wechat] 二维码过期，自动换新（第 ${renewals} 次）`)
            setState('waiting-scan', `二维码已自动刷新（第 ${renewals} 次）`)
            void beginLogin()
            return
          }
          setState('need-login', status.status)
          return
        }
        case 'scaned_but_redirect': {
          if (status.redirect_host) current.host = `https://${status.redirect_host}`
          break
        }
        default:
          break
      }
      await sleep(1000)
    }
    if (login === current) login = null
  }

  // ---------------------------------------------------------------- 收消息

  async function startPolling() {
    if (stopped || !botToken || polling) return
    setState('polling')
    polling = (async () => {
      let backoff = 1000
      while (!stopped && botToken) {
        let payload
        try {
          payload = await request(`${baseUrl}/ilink/bot/getupdates`, {
            body: { get_updates_buf: cursor, base_info: baseInfo() },
            // 服务端长轮询 35s，客户端必须留更长的余量。
            timeoutMs: 60_000,
          })
          backoff = 1000
        } catch (error) {
          log.warn?.(`[im-bridge/wechat] getupdates 失败: ${error?.message ?? error}`)
          setState('reconnecting', `${Math.round(backoff / 1000)}s`)
          await sleep(backoff)
          backoff = Math.min(30_000, backoff * 2)
          continue
        }

        const ret = payload?.ret ?? payload?.errcode
        if (ret === -14) {
          botToken = null
          setState('expired', 'token 失效，需要重新扫码')
          break
        }
        if (ret !== undefined && ret !== 0) {
          log.warn?.(`[im-bridge/wechat] getupdates ret=${ret} ${payload?.errmsg ?? ''}`)
          await sleep(1500)
          continue
        }

        // 游标只在非空时更新并持久化。
        if (payload.get_updates_buf) {
          cursor = payload.get_updates_buf
          onSession?.({ getUpdatesBuf: cursor })
        }

        for (const message of payload.msgs ?? []) {
          if (message?.message_type !== 1) continue // 1 = USER, 2 = BOT
          const chatId = String(message.from_user_id ?? '')
          if (!chatId) continue
          if (message.context_token) contextTokens.set(chatId, message.context_token)
          onMessage?.({
            channelId: 'wechat',
            chatId,
            userId: chatId,
            text: textOf(message),
            messageId: String(message.message_id ?? ''),
            contextToken: message.context_token,
            media: mediaOf(message, baseUrl),
            raw: message,
          })
        }
        setState('polling')
      }
      polling = null
    })()
  }

  // ---------------------------------------------------------------- 发消息

  async function sendText(chatId, text) {
    if (!botToken) throw new Error('微信未绑定（需要先扫码）')
    const contextToken = contextTokens.get(String(chatId))
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: String(chatId),
        client_id: `dsh-im-bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        message_type: 2,
        message_state: 2,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: 1, text_item: { text: String(text ?? '') } }],
      },
      base_info: baseInfo(),
    }
    const result = await request(`${baseUrl}/ilink/bot/sendmessage`, { body })
    if (result?.ret !== undefined && result.ret !== 0) {
      throw new Error(`微信发消息失败: ret=${result.ret} ${result.errmsg ?? ''}`)
    }
    return result
  }

  /**
   * 本地文件 → iLink CDN。返回媒体引用，供 item_list 组装。
   *
   * filesize 是**加密后**的长度：PKCS#7 至少补 1 字节，所以正好等于
   * ceil((rawsize + 1) / 16) * 16，与 Node 默认的块加密填充一致。
   *
   * aes_key 的编码必须和**服务端下发的形态一致**：入站收到的 aes_key 是
   * 44 字符的 base64 —— 解出来是 **32 个 ASCII 十六进制字符**，而不是 16 个原始
   * 字节。出站如果按 base64(16B) 发，客户端会 hex 解出垃圾 → 解密失败 →
   * 微信里表现为"文件下载失败"。
   */
  async function uploadToCdn(toUserId, absPath, fileName) {
    const buffer = fs.readFileSync(absPath)
    if (!buffer.length) throw new Error('文件为空')
    const aesKey = randomBytes(16)
    const hexKey = aesKey.toString('hex')
    /** 与服务端一致的线上形态：base64(hex32)。 */
    const wireAesKey = Buffer.from(hexKey, 'utf8').toString('base64')
    const filekey = randomBytes(16).toString('hex')
    const rawsize = buffer.length
    const diag = [`kind=outbound name=${fileName} raw=${rawsize}B media_type=${guessMediaType(fileName)}`]
    const prepared = await request(`${baseUrl}/ilink/bot/getuploadurl`, {
      body: {
        filekey,
        media_type: guessMediaType(fileName),
        to_user_id: String(toUserId),
        rawsize,
        rawfilemd5: createHash('md5').update(buffer).digest('hex'),
        filesize: Math.ceil((rawsize + 1) / 16) * 16,
        no_need_thumb: true,
        aeskey: hexKey,
        base_info: baseInfo(),
      },
    })
    const uploadUrl = prepared?.upload_full_url
      || `${CDN_UPLOAD}?encrypted_query_param=${encodeURIComponent(prepared?.upload_param ?? '')}&filekey=${encodeURIComponent(filekey)}`
    const cipher = createCipheriv('aes-128-ecb', aesKey, null)
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()])
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted,
    })
    const encryptedParam = response.headers.get('x-encrypted-param')
    diag.push(`upload http=${response.status} 密文=${encrypted.length}B x-encrypted-param=${encryptedParam ? '有' : '无'}`)
    if (!response.ok || !encryptedParam) {
      appendMediaLog(diag.join(' | '))
      throw new Error(`CDN 上传失败: HTTP ${response.status}${encryptedParam ? '' : '（缺少 x-encrypted-param 响应头）'}`)
    }
    const media = {
      encrypt_query_param: encryptedParam,
      // 与服务端下发的形态保持一致（base64 of hex32），否则客户端解不开。
      aes_key: wireAesKey,
      encrypt_type: 1,
    }
    // 自检要把内容再下回来一次；大文件不值得，按尺寸闸门跳过。
    const verifyLimit = verifyUploadMaxBytes ?? 4 * 1024 * 1024
    if (encrypted.length <= verifyLimit) {
      await verifyUpload(media, buffer, diag)
    } else {
      diag.push(`回读=跳过(${encrypted.length}B > ${verifyLimit}B)`)
    }
    appendMediaLog(diag.join(' | '))
    return { mediaType: guessMediaType(fileName), rawsize, media }
  }

  /**
   * 回读自检：把刚上传的内容下载回来，用我们给出的 aes_key 还原。
   *
   * 微信里"文件下载失败"= 客户端解不开，而 API 照样返回 ret=0。
   * 唯一能在用户看到之前发现的办法就是自己回读一遍。
   *  - 下载接口本身报错 → 只记日志、不阻塞（可能只是这个端点不对发送方开放）
   *  - 下载到了但解不开 / 还原不一致 → **明确失败**，绝不发一个注定打不开的文件
   */
  async function verifyUpload(media, original, diag) {
    let raw
    try {
      const url = `${baseUrl}/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) {
        diag.push(`回读=http${response.status}(跳过校验)`)
        return
      }
      raw = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      diag.push(`回读=异常(${String(error?.message ?? error).slice(0, 50)})(跳过校验)`)
      return
    }
    const decrypted = tryDecryptMedia(raw, media.aes_key)
    if (!decrypted.ok) {
      diag.push(`回读=${raw.length}B 解密失败[${decrypted.tried.join(',')}]`)
      throw new Error(
        '微信文件自检失败：上传的内容用我们给出的 aes_key 解不开，客户端会显示「下载失败」。\n'
        + `诊断：${diag.join(' | ')}`,
      )
    }
    const same = decrypted.bytes.equals(original)
    diag.push(`回读=解密成功(${decrypted.form}) 内容${same ? '一致' : '不一致'}`)
    if (!same) {
      throw new Error(`微信文件自检失败：回读内容与原文不一致。\n诊断：${diag.join(' | ')}`)
    }
  }

  async function sendFile(chatId, absPath, fileName) {
    if (!botToken) throw new Error('微信未绑定（需要先扫码）')
    const name = fileName || path.basename(absPath)
    const { mediaType, rawsize, media } = await uploadToCdn(chatId, absPath, name)
    const item = mediaType === 1
      ? { type: 2, image_item: { media } }
      : { type: 4, file_item: { file_name: name, len: String(rawsize), media } }
    const contextToken = contextTokens.get(String(chatId))
    const result = await request(`${baseUrl}/ilink/bot/sendmessage`, {
      body: {
        msg: {
          from_user_id: '',
          to_user_id: String(chatId),
          client_id: `dsh-im-bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          message_type: 2,
          message_state: 2,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [item],
        },
        base_info: baseInfo(),
      },
    })
    if (result?.ret !== undefined && result.ret !== 0) {
      throw new Error(`微信发文件失败: ret=${result.ret} ${result.errmsg ?? ''}`)
    }
    return result
  }

  return {
    id: 'wechat',
    get state() {
      return state
    },
    get bound() {
      return !!botToken
    },
    async start() {
      stopped = false
      if (botToken) await startPolling()
      else setState('need-login')
    },
    async stop() {
      stopped = true
      login = null
      await Promise.resolve(polling).catch(() => {})
      polling = null
    },
    beginLogin,
    sendText,
    sendFile,
    /** 对外暴露当前凭据，供 index.js 持久化。 */
    snapshot() {
      return { botToken, baseUrl, getUpdatesBuf: cursor }
    },
    status() {
      return { channelId: 'wechat', state, bound: !!botToken }
    },
  }
}
