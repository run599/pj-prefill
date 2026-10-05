// 核心决策：给定"即将发给模型的 messages"，返回注入后的新数组。
//
// 全部是纯函数、无 I/O、无 DSH 依赖 —— 这样 tools/selftest.mjs 能直接把所有
// 分支断言掉，而不用起一个 DSH 实例。
//
// 三个关键设计：
//   1. 累积防护（keepOneInHistory）：DSH 会把 prefill 落盘成 surface 事件，
//      于是历史里会逐轮累积假的 assistant 消息。我们在【请求层】把它们全部剔掉，
//      再插一条新的 → 发给 API 的 messages 里永远只有一条 prefill。
//   2. 末尾是 assistant 就不再注入：避免出现连续两条 assistant（部分 API 会报错）。
//   3. 只在目标 step 注入：后续 step 是工具循环，末尾通常是 tool 结果，插 prefill 无意义。
import { pickGroup, selectText } from './texts.mjs'

/** 自己注入的 prefill 消息的 id 前缀（累积防护靠它识别）。 */
export const PREFILL_ID_PREFIX = 'pj-prefill-'

/** 这条消息是不是本插件注入的 prefill。 */
export function isOwnPrefill(m) {
  return !!m
    && m.role === 'assistant'
    && typeof m.id === 'string'
    && m.id.startsWith(PREFILL_ID_PREFIX)
}

/** 构造一条 prefill 消息。source.kind 用 'model'，与真实模型消息同族，避免自定义值被 schema 拒。 */
export function makePrefillMessage(text, seq, now = Date.now()) {
  return {
    id: PREFILL_ID_PREFIX + now + '-' + seq,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model' }
  }
}

/** 取最后一条用户消息的纯文本（用于分组与长度判断）。 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const t = c
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
      if (t) return t
    }
  }
  return ''
}

/**
 * 决策：要不要注入、注入什么、注入后 messages 长什么样。
 *
 * @param messages - decision.messages（即将发给模型的数组）
 * @param ctx.config - loadConfig() 的结果
 * @param ctx.pool - loadTexts() 的结果
 * @param ctx.seq - 本进程内已注入次数（用于上限与轮换）
 * @param ctx.step - 当前 step
 * @param ctx.now - 时间戳（可注入，便于测试）
 * @param ctx.rand - 伪随机（可注入，便于测试）
 * @returns {{action:'inject'|'skip', why?:string, messages?:Array, text?:string, group?:string, stripped?:number, roles?:string[]}}
 */
export function planInjection(messages, ctx) {
  const { config, pool, seq = 0, step, now = Date.now(), rand = Math.random } = ctx ?? {}

  if (!Array.isArray(messages) || messages.length === 0) {
    return { action: 'skip', why: 'no-messages' }
  }
  if (config.onlyStep !== undefined && step !== config.onlyStep) {
    return { action: 'skip', why: 'step-not-target', step }
  }
  if (config.maxInjections > 0 && seq >= config.maxInjections) {
    return { action: 'skip', why: 'max-injections', seq }
  }

  // 累积防护：先剔掉历史里自己注入过的 prefill
  const ownCount = messages.filter(isOwnPrefill).length
  const cleaned = config.keepOneInHistory === false
    ? messages.slice()
    : messages.filter(m => !isOwnPrefill(m))

  if (cleaned.length === 0) {
    return { action: 'skip', why: 'only-own-prefill-left', stripped: ownCount }
  }

  const last = cleaned[cleaned.length - 1]
  if (last && last.role === 'assistant') {
    return { action: 'skip', why: 'last-is-assistant', stripped: ownCount }
  }

  const userText = lastUserText(cleaned)
  const minChars = Number.isFinite(config.minUserChars) ? config.minUserChars : 0
  if (userText.trim().length < minChars) {
    return { action: 'skip', why: 'user-too-short', chars: userText.trim().length, stripped: ownCount }
  }

  const group = config.strategy === 'group' ? pickGroup(userText, config.groups) : 'default'
  const picked = selectText(pool, {
    strategy: config.strategy,
    group,
    counter: seq,
    rand
  })

  const msg = makePrefillMessage(picked.text, seq + 1, now)
  return {
    action: 'inject',
    messages: [...cleaned, msg],
    text: picked.text,
    group: picked.group,
    stripped: ownCount,
    roles: cleaned.map(m => (m && m.role) || '?')
  }
}
