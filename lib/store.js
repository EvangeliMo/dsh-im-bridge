/**
 * Tiny durable state store for dsh-im-bridge.
 *
 * Holds only what the bridge itself owns — never Harness session data:
 *   chats["<channelId>:<chatId>"] = {
 *     sessionId,            // the session this chat is currently bound to
 *     lastList: [{ n, sessionId, title }],  // the numbering shown by /会话列表
 *     verbose,              // whether to narrate tool calls
 *     updatedAt,
 *   }
 *
 * Writes are atomic (tmp + rename) and coalesced, so a burst of commands
 * cannot leave a half-written JSON file behind.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'storages', 'im_bridge_state.json')

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    /* missing or corrupt: start clean */
  }
  return { version: 1, chats: {} }
}

export function createStore(log = console) {
  let state = readState()
  if (!state.chats || typeof state.chats !== 'object') state.chats = {}

  let flushing = null

  function flush() {
    if (flushing) return flushing
    flushing = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50)) // coalesce bursts
      flushing = null
      try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
        const tmp = `${STATE_FILE}.tmp-${process.pid}`
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
        fs.renameSync(tmp, STATE_FILE)
      } catch (error) {
        log.warn?.(`[im-bridge] 状态写入失败: ${error?.message ?? error}`)
      }
    })()
    return flushing
  }

  const keyOf = (channelId, chatId) => `${channelId}:${chatId}`

  return {
    file: STATE_FILE,

    getChat(channelId, chatId) {
      return state.chats[keyOf(channelId, chatId)] ?? {}
    },

    setChat(channelId, chatId, patch) {
      const key = keyOf(channelId, chatId)
      state.chats[key] = { ...state.chats[key], ...patch, updatedAt: Date.now() }
      void flush()
      return state.chats[key]
    },

    /** Bind a chat to a session and remember the numbering that produced it. */
    bind(channelId, chatId, sessionId, lastList) {
      return this.setChat(channelId, chatId, {
        sessionId: sessionId ?? null,
        ...(lastList ? { lastList } : {}),
      })
    },

    unbind(channelId, chatId) {
      return this.setChat(channelId, chatId, { sessionId: null })
    },

    all() {
      return state.chats
    },

    async flush() {
      await flush()
      // flush() resets the handle before awaiting the timer; drain once more.
      while (flushing) await flushing
    },
  }
}
