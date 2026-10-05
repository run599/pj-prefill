// 统计：进程内计数 + 落盘快照（供 pj_prefill_status 与外部脚本读取）。
import { readFileSync, writeFileSync } from 'node:fs'

export function makeStats(stateFile) {
  const state = {
    version: 1,
    bootAt: null,
    lastInjectAt: null,
    injections: 0,
    skips: {},
    errors: 0,
    lastText: null,
    lastGroup: null,
    sessions: []
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state))
  }

  function persist() {
    try {
      writeFileSync(stateFile, JSON.stringify(snapshot(), null, 2), 'utf8')
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }

  return {
    get state() {
      return state
    },
    snapshot,
    boot() {
      state.bootAt = new Date().toISOString()
      persist()
    },
    hitInject(info) {
      state.injections += 1
      state.lastInjectAt = new Date().toISOString()
      state.lastText = info.text ?? null
      state.lastGroup = info.group ?? null
      if (info.session && !state.sessions.includes(info.session)) {
        if (state.sessions.length < 50) state.sessions.push(info.session)
      }
      persist()
    },
    hitSkip(why) {
      state.skips[why] = (state.skips[why] || 0) + 1
    },
    hitError() {
      state.errors += 1
      persist()
    },
    /** 读回上一次进程落盘的快照（跨会话累计展示用）。 */
    readPersisted() {
      try {
        return JSON.parse(readFileSync(stateFile, 'utf8'))
      } catch {
        return null
      }
    }
  }
}
