/**
 * 微信出站文件的离线测试（stub fetch）。
 *
 * 覆盖线上那次"发送成功但微信提示下载失败"：
 *   - aes_key 必须以服务端同款形态发出（base64 of 32 个 ASCII hex 字符），
 *     而不是 base64(16 原始字节)
 *   - 上传的密文必须能用这个 aes_key 解回原文
 *   - 回读自检在"解不开"时必须报错，而不是把一个注定打不开的文件发出去
 *
 *   node scripts/test-wechat-upload.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-im-wx-upload-'))
const FILE = path.join(tmp, 'report.md')
const CONTENT = '# 报告\n\n'.repeat(200) // 约 1.6KB
fs.writeFileSync(FILE, CONTENT, 'utf8')
const ORIGINAL = fs.readFileSync(FILE)

function assert(condition, label) {
  if (condition) console.log(`  ✅ ${label}`)
  else {
    console.error(`  ❌ ${label}`)
    process.exitCode = 1
  }
}

/** 把 aes_key 按"服务端形态"解回 16 字节：base64 → 32 个 ASCII hex → hex 解码。 */
function decodeWireKey(wireKey) {
  const ascii = Buffer.from(wireKey, 'base64').toString('latin1')
  if (!/^[0-9a-fA-F]{32}$/.test(ascii)) return null
  return Buffer.from(ascii, 'hex')
}

function makeStub({ corruptKey = false } = {}) {
  const log = []
  const state = { ciphertext: null, sentMessage: null }

  const json = (value, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return JSON.stringify(value) },
    async arrayBuffer() { return Buffer.from(JSON.stringify(value)) },
  })

  const stub = async (url, options = {}) => {
    const method = options?.method ?? 'GET'
    log.push({ url, method })

    if (url.includes('/ilink/bot/getuploadurl')) {
      return json({ upload_param: 'UP_PARAM', upload_full_url: 'https://cdn.example.com/c2c/upload?x=1' })
    }
    if (url.startsWith('https://cdn.example.com/')) {
      state.ciphertext = Buffer.from(options.body)
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'x-encrypted-param' ? 'EQP_1' : null) },
        async text() { return '' },
      }
    }
    if (url.includes('/c2c/download')) {
      // 回读：故意返回用"另一把 key"加密的内容，模拟客户端解不开
      if (corruptKey) {
        const wrong = createCipheriv('aes-128-ecb', randomBytes(16), null)
        const bad = Buffer.concat([wrong.update(ORIGINAL), wrong.final()])
        return { ok: true, status: 200, headers: { get: () => null }, async arrayBuffer() { return bad } }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async arrayBuffer() { return state.ciphertext ?? Buffer.alloc(0) },
      }
    }
    if (url.includes('/ilink/bot/sendmessage')) {
      state.sentMessage = JSON.parse(options.body)
      return json({ ret: 0, message_id: 'm1' })
    }
    return json({ ret: -1, errmsg: `unexpected ${url}` }, 500)
  }

  return { stub, log, state }
}

async function makeChannel() {
  const { createWechatChannel } = await import('../lib/channels/wechat.js')
  return createWechatChannel({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    credentials: { botToken: 'stub-token', baseUrl: 'https://ilink.example' },
  })
}

const originalFetch = globalThis.fetch

// ---------------------------------------------------------------- 正常路径
console.log('--- 正常上传 ---')
{
  const { stub, log, state } = makeStub()
  globalThis.fetch = stub
  try {
    const channel = await makeChannel()
    const result = await channel.sendFile('user-openid', FILE, 'report.md')
    assert(result?.ret === 0, 'sendmessage 返回 ret=0')

    const urls = log.map((c) => c.url)
    assert(urls.some((u) => u.includes('/ilink/bot/getuploadurl')), '先调 getuploadurl')
    assert(urls.some((u) => u.startsWith('https://cdn.example.com/')), '再 PUT/POST 密文到 CDN')
    assert(urls.some((u) => u.includes('/ilink/bot/sendmessage')), '最后发消息')

    const item = state.sentMessage?.msg?.item_list?.[0]
    assert(item?.type === 4, 'item 类型是文件（type=4）')
    assert(item?.file_item?.file_name === 'report.md', 'file_name 正确')
    assert(item?.file_item?.len === String(ORIGINAL.length), 'len 是原始字节数')

    const media = item?.file_item?.media
    assert(media?.encrypt_query_param === 'EQP_1', 'encrypt_query_param 来自 x-encrypted-param')

    // 关键：aes_key 必须是"base64 of 32 个 ASCII hex 字符"
    const wire = String(media?.aes_key ?? '')
    const key = decodeWireKey(wire)
    assert(wire.length === 44, `aes_key 是 44 字符（实际 ${wire.length}）`)
    assert(key !== null, 'aes_key 解出来是 32 个 ASCII hex 字符（服务端同款形态）')

    // 用这个 key 必须能把上传的密文解回原文
    let plain = null
    let decryptError = null
    try {
      const decipher = createDecipheriv('aes-128-ecb', key, null)
      plain = Buffer.concat([decipher.update(state.ciphertext), decipher.final()])
    } catch (error) {
      decryptError = error
    }
    if (decryptError) console.error(`    解密抛错: ${decryptError.message}`)
    if (plain && !plain.equals(ORIGINAL)) {
      console.error(`    原文 ${ORIGINAL.length}B head=${ORIGINAL.subarray(0, 12).toString('hex')}`)
      console.error(`    解出 ${plain.length}B head=${plain.subarray(0, 12).toString('hex')}`)
      console.error(`    密文 ${state.ciphertext?.length}B`)
    }
    assert(plain !== null && plain.equals(ORIGINAL), '用发出的 aes_key 能解回原文（客户端才会成功）')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ---------------------------------------------------------------- 自检失败
console.log('\n--- 回读自检（客户端解不开时必须报错） ---')
{
  const { stub } = makeStub({ corruptKey: true })
  globalThis.fetch = stub
  try {
    const channel = await makeChannel()
    let error = null
    try {
      await channel.sendFile('user-openid', FILE, 'report.md')
    } catch (caught) {
      error = caught
    }
    assert(error !== null, '自检失败时抛错，不发一个注定打不开的文件')
    assert(String(error?.message ?? '').includes('自检失败'), '错误信息说明是自检失败')
    assert(String(error?.message ?? '').includes('诊断'), '错误信息带上诊断')
  } finally {
    globalThis.fetch = originalFetch
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${process.exitCode ? '❌ 有断言失败' : '✅ 全部通过'}`)
