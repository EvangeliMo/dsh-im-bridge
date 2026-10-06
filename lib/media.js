/**
 * 入站附件（图片 / 文件）处理。
 *
 * 两条通道共用：把"下载 → （必要时解密）→ 存成 Host 附件 → 组装 prompt content"
 * 收在一处。**任何一步失败都不许把整条消息弄丢** —— 退化成纯文本 + 一句说明，
 * 正文照样发给模型。
 *
 * Host 侧接口（已核实）：
 *   ctx.attachments.saveImage({ data, mediaType, name? }) -> ImageAttachmentRef
 *     → prompt 里写 {type:'image', attachment}
 *   ctx.fileUploads.uploadStream({ sessionId, data, name? }) -> { receiptId, file }
 *     → prompt 里写 {type:'file', receiptId}
 *       （**不能**写 attachment，否则 Host 报 "File was not uploaded for this session."）
 *
 * 诊断日志：%DSH_HOME%\storages\im_bridge_media.log（每个附件一行）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDecipheriv } from 'node:crypto'

const IMAGE_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const MEDIA_LOG = path.join(HOME, 'storages', 'im_bridge_media.log')

/** 声明的 media type 或扩展名 → Host 认识的图片类型；不是图片就返回 null。 */
export function imageMediaTypeFor(name, contentType) {
  const declared = String(contentType ?? '').toLowerCase().split(';')[0].trim()
  if (Object.values(IMAGE_EXT).includes(declared)) return declared
  const ext = String(name ?? '').toLowerCase().split('.').pop()
  return IMAGE_EXT[ext] ?? null
}

/**
 * 按**真实字节**判断图片类型。
 * 渠道给的文件名/声明的 content-type 经常不可信（微信统一给 media-xxx.jpg，
 * 里面可能是 PNG/WebP，也可能是密文），所以优先看魔数。
 */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** AES-128-ECB + PKCS#7 解密（iLink 的 CDN 媒体是加密存的）。 */
export function decryptAesEcb(ciphertext, base64Key) {
  const key = Buffer.from(String(base64Key ?? ''), 'base64')
  if (key.length !== 16) throw new Error(`aes_key 长度不对（${key.length} 字节，应为 16）`)
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * aes_key 在不同渠道/版本里出现过的几种形态，逐个试：
 *   1. base64 → 16 字节（标准）
 *   2. 32 位十六进制字符串
 *   3. base64 → 32 个 ASCII hex 字符（再 hex 解一次）
 */
export function candidateAesKeys(aesKey) {
  const raw = String(aesKey ?? '').trim()
  const out = []
  if (!raw) return out
  if (/^[0-9a-fA-F]{32}$/.test(raw)) out.push({ form: 'hex32', key: Buffer.from(raw, 'hex') })
  try {
    const decoded = Buffer.from(raw, 'base64')
    if (decoded.length === 16) out.push({ form: 'base64-16B', key: decoded })
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('latin1'))) {
      out.push({ form: 'base64-hex32', key: Buffer.from(decoded.toString('latin1'), 'hex') })
    }
  } catch {
    /* 不是合法 base64 就算了 */
  }
  return out
}

/** 试所有 key 形态；返回第一个能正确去填充的结果。 */
export function tryDecryptMedia(ciphertext, aesKey) {
  const tried = []
  for (const candidate of candidateAesKeys(aesKey)) {
    try {
      const decipher = createDecipheriv('aes-128-ecb', candidate.key, null)
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return { ok: true, bytes: plain, form: candidate.form, tried }
    } catch (error) {
      tried.push(`${candidate.form}:${String(error?.message ?? error).slice(0, 40)}`)
    }
  }
  return { ok: false, bytes: ciphertext, tried }
}

export function appendMediaLog(line) {
  try {
    fs.mkdirSync(path.dirname(MEDIA_LOG), { recursive: true })
    fs.appendFileSync(MEDIA_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 日志只是诊断设施，写不了不影响功能 */
  }
}

const hex = (bytes, n = 8) => Buffer.from(bytes ?? []).subarray(0, n).toString('hex')

async function downloadBytes(descriptor, { timeoutMs, maxBytes, log, diag }) {
  const response = await fetch(descriptor.url, {
    headers: descriptor.headers ?? undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  diag.push(`http=${response.status} url=${String(descriptor.url).slice(0, 80)}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength && declaredLength > maxBytes) {
    throw new Error(`文件 ${(declaredLength / 1048576).toFixed(1)}MB 超过上限 ${Math.round(maxBytes / 1048576)}MB`)
  }
  let bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) {
    throw new Error(`文件 ${(bytes.length / 1048576).toFixed(1)}MB 超过上限 ${Math.round(maxBytes / 1048576)}MB`)
  }
  diag.push(`raw=${bytes.length}B head=${hex(bytes)} magic=${sniffImageType(bytes) ?? '非图片'}`)

  if (descriptor.aesKey) {
    const result = tryDecryptMedia(bytes, descriptor.aesKey)
    diag.push(`encryptType=${descriptor.encryptType ?? '(无)'} aesKeyLen=${String(descriptor.aesKey).length} 解密=${result.ok ? `成功(${result.form})` : `失败[${result.tried.join(',')}]`}`)
    if (result.ok) {
      bytes = result.bytes
      diag.push(`plain=${bytes.length}B head=${hex(bytes)} magic=${sniffImageType(bytes) ?? '非图片'}`)
    } else {
      log?.warn?.('[im-bridge] 媒体解密失败，按原样使用（细节见 im_bridge_media.log）')
    }
  } else if (!sniffImageType(bytes)) {
    diag.push('无 aes_key 且内容不是已知图片格式（可能本来就是密文）')
  }
  return bytes
}

/**
 * 把一条入站消息组装成 prompt content。
 *
 * @param {object} input
 * @param {object} input.ctx          Cordis context（用 ctx.get('attachments') / ('fileUploads')）
 * @param {string} input.sessionId    目标会话（文件暂存必须要它）
 * @param {string} input.text         正文
 * @param {Array}  input.attachments  [{ kind, name, url?, bytes?, aesKey?, contentType? }]
 * @returns {Promise<Array>} prompt content parts
 */
export async function buildUserContent({ ctx, log, text, attachments = [], sessionId, config = {}, forceFile = false }) {
  const limits = {
    timeoutMs: config.attachmentTimeoutMs ?? 30_000,
    maxBytes: config.maxAttachmentBytes ?? 20 * 1024 * 1024,
  }
  const parts = []
  const notes = []
  const fileUploads = ctx?.get?.('fileUploads')

  const body = String(text ?? '').trim()
  if (body) parts.push({ type: 'text', text: body })

  for (const attachment of attachments) {
    const name = attachment.name || (attachment.kind === 'image' ? 'image' : 'file')
    const diag = [`kind=${attachment.kind} name=${name}`]
    try {
      const bytes = attachment.bytes?.length
        ? Buffer.from(attachment.bytes)
        : await downloadBytes(attachment, { ...limits, log, diag })

      if (!bytes.length) throw new Error('内容为空')

      // 先按真实字节判类型，判不出来再退回文件名/声明的 content-type。
      const sniffed = sniffImageType(bytes)
      const mediaType = attachment.kind === 'image'
        ? (sniffed ?? imageMediaTypeFor(name, attachment.contentType))
        : sniffed
      diag.push(`判定=${mediaType ?? '不是图片'}`)

      // 图片：**不要**自己 saveImage —— Host 的 admitPromptContent 会把 image part
      // 当作"待保存的编码图片"再存一次（admitEncodedImages → saveImages → saveInput
      // 读的就是 part.data / part.mediaType）。传 {type:'image', attachment} 会因为
      // 缺 data 而在 Host 的兜底 catch 里变成 "prompt rejected"。
      if (mediaType && !forceFile) {
        parts.push({
          type: 'image',
          mediaType,
          data: bytes.toString('base64'),
          ...(name ? { name } : {}),
        })
        diag.push('image=编码形态(交给 Host 保存)')
        appendMediaLog(diag.join(' | '))
        continue
      }

      // 文件必须走 fileUploads 暂存：Host 的 prompt 只认 {type:'file', receiptId}。
      if (!fileUploads || !sessionId) throw new Error('Host 没有可用的 fileUploads（文件无法附加）')
      const uploaded = await fileUploads.uploadStream({
        sessionId,
        name,
        data: (async function* yieldBytes() { yield bytes })(),
      })
      if (!uploaded?.receiptId) throw new Error('fileUploads 未返回 receiptId')
      parts.push({ type: 'file', receiptId: uploaded.receiptId })
      diag.push('fileUploads=成功')
    } catch (error) {
      log?.warn?.(`[im-bridge] 附件 ${name} 处理失败: ${error?.message ?? error}`)
      notes.push(`附件 ${name} 处理失败：${error?.message ?? error}`)
      diag.push(`失败=${String(error?.message ?? error).slice(0, 80)}`)
    }
    appendMediaLog(diag.join(' | '))
  }

  if (!parts.length) parts.push({ type: 'text', text: '（对方发来附件，但没有可用的文字或附件内容）' })
  if (notes.length) parts.push({ type: 'text', text: `[插件提示] ${notes.join('；')}` })
  return parts
}

/** 去掉所有 file part —— 文件暂存失败时用它兜底重发，保证正文一定能过。 */
export function withoutFileParts(parts) {
  return (parts ?? []).filter((part) => part?.type !== 'file')
}
