/**
 * 入站附件（图片/文件）离线测试。
 *
 * 覆盖：
 *   - 两条通道把协议字段解析成统一附件描述
 *   - 下载 → AES-128-ECB 解密 → saveImage/saveFile
 *   - 图片没过校验时降级成文件
 *   - 下载失败时**退化成纯文本**，正文不能丢
 *
 *   node scripts/test-media.mjs
 */
import { createCipheriv, randomBytes } from 'node:crypto'

import {
  buildUserContent,
  candidateAesKeys,
  decryptAesEcb,
  imageMediaTypeFor,
  sniffImageType,
  tryDecryptMedia,
} from '../lib/media.js'
import { mediaOf as qqMediaOf } from '../lib/channels/qq.js'
import { mediaOf as wechatMediaOf } from '../lib/channels/wechat.js'

function assert(condition, label) {
  if (condition) console.log(`  ✅ ${label}`)
  else {
    console.error(`  ❌ ${label}`)
    process.exitCode = 1
  }
}

// ------------------------------------------------------------------ 协议解析

console.log('--- 协议字段 → 统一附件描述 ---')
const qqImage = qqMediaOf({ attachments: [{ url: 'https://cdn/1', filename: 'a.png', content_type: 'image/png', size: 12 }] })
assert(qqImage.length === 1 && qqImage[0].kind === 'image', 'QQ：png 判为图片')
assert(qqImage[0].name === 'a.png' && qqImage[0].url === 'https://cdn/1', 'QQ：名字与 URL 正确')

const qqFile = qqMediaOf({ attachments: [{ url: 'https://cdn/2', filename: 'doc.pdf', content_type: 'application/pdf' }] })
assert(qqFile[0].kind === 'file', 'QQ：pdf 判为文件')
assert(qqMediaOf({ attachments: [{ filename: 'nourl.png' }] }).length === 0, 'QQ：没有 url 的附件被忽略')
assert(qqMediaOf({}).length === 0, 'QQ：没有 attachments 时返回空')

const wxImage = wechatMediaOf(
  { message_id: 'm1', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'EQP', aes_key: 'KEY' } } }] },
  'https://ilink.example',
)
assert(wxImage.length === 1 && wxImage[0].kind === 'image', '微信：type=2 判为图片')
assert(wxImage[0].url.includes('/c2c/download?encrypted_query_param=EQP'), '微信：拼出了 CDN 下载地址')
assert(wxImage[0].aesKey === 'KEY', '微信：aes_key 透传下去')

const wxFile = wechatMediaOf(
  { message_id: 'm2', item_list: [{ type: 4, file_item: { file_name: '报告.pdf', media: { full_url: 'https://cdn/full' } } }] },
  'https://ilink.example',
)
assert(wxFile[0].kind === 'file' && wxFile[0].name === '报告.pdf', '微信：type=4 用 file_name 作名字')
assert(wxFile[0].url === 'https://cdn/full', '微信：优先用 full_url')

// ------------------------------------------------------------------ 图片类型判定

console.log('\n--- 图片类型判定 ---')
assert(imageMediaTypeFor('a.PNG', undefined) === 'image/png', '按扩展名（大小写无关）')
assert(imageMediaTypeFor('x', 'image/jpeg; charset=binary') === 'image/jpeg', '按 content-type（带参数）')
assert(imageMediaTypeFor('a.pdf', 'application/pdf') === null, '非图片返回 null')

// ------------------------------------------------------------------ 组装 prompt content

const saved = { images: [], uploads: [] }
function makeCtx({ failImage = false, noFileUploads = false } = {}) {
  saved.images.length = 0
  saved.uploads.length = 0
  return {
    get(service) {
      if (service === 'attachments') {
        return {
          async saveImage(input) {
            if (failImage) throw new Error('image exceeds maxImagePixels')
            saved.images.push(input)
            return { attachmentId: 'img-1', mediaType: input.mediaType, bytes: input.data.length, width: 4, height: 4, name: input.name }
          },
        }
      }
      if (service === 'fileUploads') {
        if (noFileUploads) return undefined
        return {
          async uploadStream({ sessionId, name, data }) {
            const chunks = []
            for await (const chunk of data) chunks.push(Buffer.from(chunk))
            const bytes = Buffer.concat(chunks)
            saved.uploads.push({ sessionId, name, bytes })
            return {
              receiptId: `receipt-${saved.uploads.length}`,
              file: { attachmentId: 'file-1', name: name ?? 'file', bytes: bytes.length },
            }
          },
        }
      }
      return undefined
    },
  }
}

const originalFetch = globalThis.fetch
let fetchResponse = null
globalThis.fetch = async () => fetchResponse

const log = { info: () => {}, warn: () => {} }
// 16 字节，够魔数嗅探（真实 PNG 头）
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)])
// 明确不是图片的字节，用来测"文件"路径（否则会被魔数嗅探成图片）
const binBytes = Buffer.from('plain non-image payload for file tests', 'utf8')

console.log('\n--- 组装 content ---')
{
  const parts = await buildUserContent({ ctx: makeCtx(), log, text: '看看这张图' })
  assert(parts.length === 1 && parts[0].type === 'text', '纯文本：只产出一个 text part')
}

{
  fetchResponse = { ok: true, status: 200, headers: { get: () => null }, async arrayBuffer() { return pngBytes } }
  const parts = await buildUserContent({
    ctx: makeCtx(),
    log,
    text: '看看这张图',
    attachments: [{ kind: 'image', name: 'a.png', url: 'https://cdn/1' }],
  })
  assert(parts.length === 2 && parts[0].type === 'text', '图片：text + image 两个 part')
  assert(
    parts[1].type === 'image' && parts[1].mediaType === 'image/png' && typeof parts[1].data === 'string',
    '图片：产出 Host 要的编码形态 {type, mediaType, data}',
  )
  assert(Buffer.from(parts[1].data, 'base64').equals(pngBytes), '图片：data 是原文的 base64')
  assert(saved.images.length === 0, '图片：插件不再自己 saveImage（Host 的 admitEncodedImages 会存）')
}

{
  // forceFile：图片降级成文件附件（Host 拒绝图片时 router 会走这一档）
  fetchResponse = { ok: true, status: 200, headers: { get: () => null }, async arrayBuffer() { return pngBytes } }
  const parts = await buildUserContent({
    ctx: makeCtx(),
    log,
    sessionId: 'session-x',
    text: '大图',
    forceFile: true,
    attachments: [{ kind: 'image', name: 'big.png', url: 'https://cdn/big' }],
  })
  assert(saved.uploads.length === 1, 'forceFile：图片改走 fileUploads')
  assert(parts.some((p) => p.type === 'file' && p.receiptId), 'forceFile：产出带 receiptId 的 file part')
  assert(!parts.some((p) => p.type === 'image'), 'forceFile：不再产出 image part')
}

{
  fetchResponse = { ok: false, status: 404, headers: { get: () => null }, async arrayBuffer() { throw new Error('nope') } }
  const parts = await buildUserContent({
    ctx: makeCtx(),
    log,
    text: '正文不能丢',
    attachments: [{ kind: 'image', name: 'x.png', url: 'https://cdn/missing' }],
  })
  assert(parts[0].type === 'text' && parts[0].text === '正文不能丢', '下载失败时正文仍然保留')
  assert(parts.some((p) => p.type === 'text' && p.text.includes('处理失败')), '并且给出失败提示')
}

// ------------------------------------------------------------------ AES 解密

console.log('\n--- AES-128-ECB 解密（微信 CDN 媒体） ---')
{
  const key = randomBytes(16)
  const plaintext = Buffer.from('这是文件的真实内容 hello world', 'utf8')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  const roundTrip = decryptAesEcb(ciphertext, key.toString('base64'))
  assert(roundTrip.equals(plaintext), '加解密往返一致')

  fetchResponse = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async arrayBuffer() { return ciphertext },
  }
  const parts = await buildUserContent({
    ctx: makeCtx(),
    log,
    sessionId: 'session-x',
    text: '解密后的文件',
    attachments: [{ kind: 'file', name: 'secret.bin', url: 'https://cdn/enc', aesKey: key.toString('base64') }],
  })
  assert(parts.some((p) => p.type === 'file' && p.receiptId), '加密媒体能解出内容')
  assert(saved.uploads.length === 1 && saved.uploads[0].bytes.equals(plaintext), '上传的是解密后的明文')
}

{
  // aes_key 是坏的 → 不抛错，按原样使用（宁可用密文也别丢消息）
  fetchResponse = { ok: true, status: 200, headers: { get: () => null }, async arrayBuffer() { return binBytes } }
  const parts = await buildUserContent({
    ctx: makeCtx(),
    log,
    sessionId: 'session-x',
    text: '坏 key',
    attachments: [{ kind: 'file', name: 'x.bin', url: 'https://cdn/x', aesKey: 'not-a-key' }],
  })
  assert(parts.some((p) => p.type === 'file' && p.receiptId), '坏 aes_key 不致命，仍按原文附件处理')
}

{
  // 没有 fileUploads 时不能硬塞 {type:'file',attachment}（Host 会拒），
  // 应当降级成提示，正文照常。
  fetchResponse = { ok: true, status: 200, headers: { get: () => null }, async arrayBuffer() { return binBytes } }
  const parts = await buildUserContent({
    ctx: makeCtx({ noFileUploads: true }),
    log,
    text: '文件正文',
    sessionId: 'session-x',
    attachments: [{ kind: 'file', name: 'a.bin', url: 'https://cdn/a' }],
  })
  assert(parts[0].type === 'text' && parts[0].text === '文件正文', '没有 fileUploads 时正文仍在')
  assert(parts.some((p) => p.type === 'text' && p.text.includes('fileUploads')), '并且说明了原因')
  assert(!parts.some((p) => p.type === 'file'), '不会产出 Host 会拒绝的 file part')
}

// ------------------------------------------------------------------ 真实字节判定与 key 容错

console.log('\n--- 按魔数判定图片（不信任文件名） ---')
{
  const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(20)])
  assert(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0])) === 'image/jpeg', 'JPEG 魔数')
  assert(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === 'image/png', 'PNG 魔数')
  assert(sniffImageType(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) === 'image/gif', 'GIF 魔数')
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])
  assert(sniffImageType(webp) === 'image/webp', 'WebP 魔数')
  // 用户那次真机收到的：看起来就是 AES 密文
  assert(sniffImageType(Buffer.from('7def168736fcce0bf95d645a9dc74be2', 'hex')) === null, '密文不会被误判成图片')
}

console.log('\n--- aes_key 形态容错 ---')
{
  const key = randomBytes(16)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const plaintext = Buffer.from('真正的图片内容占位', 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  assert(candidateAesKeys(key.toString('base64')).some((c) => c.form === 'base64-16B'), '识别 base64 形态')
  assert(candidateAesKeys(key.toString('hex')).some((c) => c.form === 'hex32'), '识别 hex32 形态')
  assert(
    candidateAesKeys(Buffer.from(key.toString('hex')).toString('base64')).some((c) => c.form === 'base64-hex32'),
    '识别 base64(hex32) 形态',
  )

  assert(tryDecryptMedia(ciphertext, key.toString('base64')).ok, 'base64 形态能解开')
  assert(tryDecryptMedia(ciphertext, key.toString('hex')).ok, 'hex32 形态能解开')
  assert(
    tryDecryptMedia(ciphertext, Buffer.from(key.toString('hex')).toString('base64')).ok,
    'base64(hex32) 形态能解开',
  )
  assert(tryDecryptMedia(ciphertext, key.toString('base64')).bytes.equals(plaintext), '解出来的是原文')

  const wrong = tryDecryptMedia(ciphertext, randomBytes(16).toString('base64'))
  assert(!wrong.ok && wrong.bytes.equals(ciphertext), 'key 不对时不抛错、原样返回（不丢消息）')
  const empty = tryDecryptMedia(ciphertext, '')
  assert(!empty.ok && empty.bytes.equals(ciphertext), '没有 key 时原样返回')
}

globalThis.fetch = originalFetch
console.log(`\n${process.exitCode ? '❌ 有断言失败' : '✅ 全部通过'}`)
