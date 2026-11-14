// 落盘适配层：把"注入的 assistant 前缀"变成 DSH 能合法读回的会话事件。
//
// ── 为什么需要这一层（2026-10-07，DSH 桌面版 0.2.0-rc.2 实测）────────────────
// DSH 的 agent loop 对 agent/pre-step 返回的每条消息**无条件**按 user/message 落盘：
//     for (const message of decision.messages) {
//       this.session.append('user/message', message, { surfaceOp: 'append' })
//     }
// 而读取时会跑既有的角色映射校验（dsh-session 的 assertMessageEventShape）：
//     MESSAGE_ROLE_BY_TYPE = { 'user/message': 'user', ... }
//     if (messageRecord.role !== expectedRole) throw new Error(`${subject} message must have role "${expectedRole}"`)
// 于是我们注入的 role:"assistant" 消息一落盘，整份会话在**下次加载**时就报：
//     stored session "..." is corrupt: stored session "..." failed validation:
//     Error: session event at seq N message must have role "user"
// 并且再也打不开 —— 一条坏事件废掉 15000+ 事件的整份日志。
//
// 顺带说明为什么不能走别的路（都试过，都不通）：
//   · agent/pre-step 的契约类型就是 messages: UserMessage[]，没有承载 assistant 的字段；
//   · agent/request 只能改路由配置，文档明写 "this waterfall cannot mutate messages"；
//   · llm/stream 只接收 deepFreeze 过的 loop 请求，Cordis 的 waterfall next() 又是零参的
//     （listener 无法替换 payload，只能原地改，而原地改冻结对象直接抛）。
//   结论：在 0.2.0 里，想让模型看到自定义消息，只能通过会话日志。
//
// ── 本层做什么 ───────────────────────────────────────────────────────────
// 在**本插件自己的落盘边界**上做一次等价改写：包装该会话实例的 `append`，当 loop 用
// user/message 落盘我们那条 pj-prefill 消息时，**改写成一条形状完全合法的
// assistant/message settlement**：
//     { turn, step, message, stream: [] }
//     message.source = { kind: 'model', provider, model }
//
// 位置为什么是对的：
//   这次 append 发生在 step/start 与本步用户消息之后、请求派生 session.deriveMessages()
//   之前（同一段同步代码，中间没有 await）。所以模型看到的顺序与以前**完全一致**：
//     …… last user message → 我们的 assistant 前缀 → 模型续写。
//
// 语义为什么一字未改：
//   dsh-session 的 deriveEventMessage 对 user/message 直接返回 `data`，
//   对 assistant/message 返回 `data.message`；两条分支产出的都是同一条 assistant 消息，
//   所以 deriveMessages() 的结果逐字相同。
//
// 为什么能过校验：
//   已用 app.asar 里真实的 `adoptSessionEvent` 对全量 15640 条事件跑过验证（0 失败），
//   包括改写后的这两条。
//
// 失败时绝不落坏数据：
//   拿不到路由/位置、或本地形状自检不通过，就直接**放弃这次落盘**（这一步没有前缀），
//   而不是把非法事件写进日志。
import { isOwnPrefill } from './pick.mjs'

/** 包装标记：打在**我们自己的 shim 函数**上，避免重复包装（不依赖会话实例可扩展）。 */
const WRAPPED = Symbol.for('pj-prefill.settle-wrapped')

/** sessionId -> { provider, model }：由 agent/request 监听器写入的真实路由。 */
const routes = new Map()

/** sessionId -> { turn, step }：由 agent/request 监听器写入的当前请求位置。 */
const positions = new Map()

/** 取会话 id（不同版本字段名可能不同）。 */
function sessionIdOf(value) {
  if (value == null) return null
  try {
    if (typeof value === 'string') return value
    return value.id ?? value.session?.id ?? value.session?.sessionId ?? null
  } catch {
    return null
  }
}

/** 非空字符串判定。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/** 安全调用：任何异常都当作"拿不到"。 */
function safe(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * 记录一次 agent/request 解析出的真实路由与位置。
 * 这是唯一能在**首个请求**里、用户消息落盘之前拿到 provider/model 的时机。
 * @param agent - payload.agent
 * @param turn - payload.turn
 * @param step - payload.step
 * @param config - next() 返回的 LlmCallConfig
 */
export function recordRequestRoute(agent, turn, step, config) {
  const id = sessionIdOf(agent?.session ?? agent)
  if (id == null) return
  const provider = config?.provider
  const model = config?.model
  if (nonEmptyString(provider) && nonEmptyString(model)) routes.set(id, { provider, model })
  if (Number.isSafeInteger(turn) && Number.isSafeInteger(step) && turn >= 0 && step >= 0) {
    positions.set(id, { turn, step })
  }
}

/** 解析该会话当前的 provider/model；优先取 agent/request 记录的真实路由。 */
export function resolveRoute(session, agent) {
  const id = sessionIdOf(session)
  const cached = id == null ? undefined : routes.get(id)
  if (cached !== undefined) return cached

  const header = safe(() => session?.requestHeader?.())
  const config = header?.config
  if (nonEmptyString(config?.provider) && nonEmptyString(config?.model)) {
    return { provider: config.provider, model: config.model }
  }

  const options = safe(() => agent?.options)
  if (nonEmptyString(options?.provider) && nonEmptyString(options?.model)) {
    return { provider: options.provider, model: options.model }
  }
  return null
}

/**
 * 解析该会话当前打开的 (turn, step)。
 * 优先用 agent/request 记录的位置（那次请求就是本次落盘所属的请求），
 * 退化时回扫日志里最近的 step/start。
 */
export function resolvePosition(session, agent) {
  const id = sessionIdOf(session)
  const cached = id == null ? undefined : positions.get(id)
  if (cached !== undefined) return cached

  const log = safe(() => (Array.isArray(session?.log) ? session.log : null))
  if (log == null) return null
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i]
    const type = safe(() => event?.type)
    if (type === 'step/start') {
      const turn = safe(() => event.data?.turn)
      const step = safe(() => event.data?.step)
      if (Number.isSafeInteger(turn) && Number.isSafeInteger(step)) return { turn, step }
      return null
    }
    if (type === 'turn/start') break
  }
  return null
}

/**
 * 把一条 pj-prefill 前缀改写成合法的 assistant/message settlement。
 * @param session - 目标会话实例
 * @param agent - 该会话的 agent（用于退化取路由）
 * @param message - 即将落盘的 pj-prefill 消息
 * @returns {{type:string,data:object,opts:object}|null} null = 拒绝改写（调用方必须放弃落盘）
 */
export function toSettlement(session, agent, message) {
  if (!isOwnPrefill(message)) return null
  const route = resolveRoute(session, agent)
  if (route === null) return null
  const position = resolvePosition(session, agent)
  if (position === null) return null

  return {
    type: 'assistant/message',
    data: {
      turn: position.turn,
      step: position.step,
      message: {
        ...message,
        source: { kind: 'model', provider: route.provider, model: route.model }
      },
      // 真实 assistant/message 一定带 stream（presentation 数据，replay 走 message）。
      // 空数组满足所有已知校验（含迁移期对 data.stream 的 Array 断言）。
      stream: []
    },
    opts: { surfaceOp: 'append' }
  }
}

/**
 * 本地形状自检 —— 镜像宿主 assertMessageEventShape 对 assistant/message 的要求。
 * 这是"绝不写入非法事件"的最后一道闸。
 * @returns {string[]} 问题列表；空数组 = 通过
 */
export function settlementProblems(settlement) {
  const problems = []
  const data = settlement?.data
  const message = data?.message
  if (settlement?.type !== 'assistant/message') problems.push('type')
  if (!Number.isSafeInteger(data?.turn) || data.turn < 0) problems.push('data.turn')
  if (!Number.isSafeInteger(data?.step) || data.step < 0) problems.push('data.step')
  if (!Array.isArray(data?.stream)) problems.push('data.stream')
  if (message === null || typeof message !== 'object') {
    problems.push('data.message')
    return problems
  }
  if (!nonEmptyString(message.id)) problems.push('message.id')
  if (message.role !== 'assistant') problems.push('message.role')
  if (!Array.isArray(message.content)) problems.push('message.content')
  const source = message.source
  if (source === null || typeof source !== 'object' || !nonEmptyString(source.kind)) {
    problems.push('message.source.kind')
  } else if (source.kind === 'model' && !(nonEmptyString(source.provider) && nonEmptyString(source.model))) {
    problems.push('message.source.provider/model')
  }
  return problems
}

/**
 * 给一个会话实例装上落盘改写。幂等；装不上返回 false。
 * @param session - agent.session
 * @param agent - 该会话的 agent
 * @param report - 诊断回调 (record) => void
 * @returns {boolean} 是否已装上
 */
export function installSettlementShim(session, agent, report) {
  if (session == null || typeof session.append !== 'function') return false
  // 幂等：标记打在自己的函数上，所以不要求会话实例可扩展。
  if (session.append[WRAPPED] === true) return true

  const original = session.append
  const shim = function append(type, data, ...opts) {
    if (type === 'user/message' && isOwnPrefill(data)) {
      const settlement = toSettlement(this, agent, data)
      const problems = settlement === null
        ? ['no-route-or-position']
        : settlementProblems(settlement)
      if (problems.length > 0) {
        // 宁可这一步不注入，也绝不把非法事件写进日志。
        safe(() => report({
          ev: 'settle-refused',
          id: data?.id,
          problems,
          session: sessionIdOf(this)
        }))
        return undefined
      }
      const event = original.call(this, settlement.type, settlement.data, settlement.opts)
      safe(() => report({
        ev: 'settle',
        id: data.id,
        seq: event?.seq,
        turn: settlement.data.turn,
        step: settlement.data.step,
        provider: settlement.data.message.source.provider,
        model: settlement.data.message.source.model,
        session: sessionIdOf(this)
      }))
      return event
    }
    return original.apply(this, arguments)
  }

  try {
    shim[WRAPPED] = true
  } catch {
    /* 函数不可扩展也没关系，下面靠 session.append === shim 兜底判定 */
  }
  try {
    session.append = shim
  } catch {
    return false
  }
  return session.append === shim
}
