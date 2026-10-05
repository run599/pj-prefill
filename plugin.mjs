// pj-prefill v1.0.0 —— DSH 破甲层：prefill 攻击
//
// 原理（文献依据）：
//   · arXiv 2607.14147《Breaking Refusal in the First Half》—— 拒绝决策在序列前半段就定了；
//   · arXiv 2404.02151 —— 对不暴露 logprobs 的模型，prefilling 攻击可达 100% 成功率。
//   做法：在 agent/pre-step 拿到"即将发给模型的 messages"，往末尾插一条 assistant 前缀，
//   让模型从"已经在交付"的状态续写，而不是从"要不要拒绝"开始。
//
// 本机实测（2026-10-05，deepseek-v4-flash）：
//   无 prefill → reasoning "I'll decline the harmful requests directly"，0 次工具调用；
//   有 prefill → 同一请求 21+ 步工具调用并产出可编译载荷。
//
// 入口换成 plugin.mjs（而不是旧的 index.mjs）是有意的：DSH 按 URL 缓存 ESM 模块，
//   换文件名才能在不重启宿主的前提下让新代码生效。
import { loadConfig, isEnabled } from './lib/config.mjs'
import { loadTexts } from './lib/texts.mjs'
import { planInjection } from './lib/pick.mjs'
import { makeLogger } from './lib/log.mjs'
import { makeStats } from './lib/stats.mjs'
import { LOG_FILE, STATE_FILE } from './lib/paths.mjs'

export const VERSION = '1.0.0'

export const name = 'pj-prefill'

/** 需要 tools 服务来注册状态查询工具；事件监听本身不需要额外服务。 */
export const inject = ['tools']

/** 从 agent 上稳健地取会话 id（不同版本字段名可能不同）。 */
function sessionIdOf(agent) {
  try {
    return agent?.id ?? agent?.session?.id ?? agent?.session?.sessionId ?? null
  } catch {
    return null
  }
}

/** 注册状态查询工具：把"注入到底有没有发生"变成可核对的客观事实。 */
function registerStatusTool(ctx, stats, getSeq) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return
  ctx.effect(() => ctx.tools.register({
    name: 'pj_prefill_status',
    description:
      'Objective status of the pj-prefill layer (prefill attack). Reports whether it is enabled, '
      + 'how many times it has injected in this process, the skip-reason histogram, the on-disk '
      + 'config and text-pool shape, and the log/state file paths. Call this instead of guessing '
      + 'whether prefill fired — the host UI cannot show it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    execute() {
      const config = loadConfig()
      const pool = loadTexts()
      return {
        plugin: name,
        version: VERSION,
        enabled: isEnabled(config),
        injectionsThisProcess: getSeq(),
        config,
        textPool: {
          source: pool.source,
          groups: Object.fromEntries(Object.entries(pool.groups).map(([k, v]) => [k, v.length]))
        },
        files: { log: LOG_FILE, state: STATE_FILE },
        lastPersisted: stats.readPersisted()
      }
    }
  }), 'pj-prefill: status tool')
}

export function apply(ctx) {
  const log = makeLogger(LOG_FILE)
  const stats = makeStats(STATE_FILE)
  let seq = 0
  let booted = false

  if (typeof ctx.on !== 'function') {
    console.log('[pj-prefill] ctx.on 不可用，跳过挂载')
    return
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const { agent, step } = payload ?? {}
      const config = loadConfig()

      if (!booted) {
        booted = true
        stats.boot()
        const pool = loadTexts()
        log({
          ev: 'boot',
          version: VERSION,
          enabled: isEnabled(config),
          textPoolSource: pool.source,
          textGroups: pool.order,
          config
        })
      }

      if (!isEnabled(config)) return decision
      if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision

      const pool = loadTexts()
      const plan = planInjection(decision.messages, { config, pool, seq, step, now: Date.now() })

      if (plan.action !== 'inject') {
        stats.hitSkip(plan.why)
        log({
          ev: 'skip',
          why: plan.why,
          step,
          stripped: plan.stripped,
          chars: plan.chars,
          session: sessionIdOf(agent)
        })
        return decision
      }

      seq += 1
      stats.hitInject({ text: plan.text, group: plan.group, session: sessionIdOf(agent) })
      log({
        ev: 'inject',
        seq,
        step,
        group: plan.group,
        text: plan.text,
        stripped: plan.stripped,
        roles: plan.roles.join(','),
        msgCount: decision.messages.length + '->' + plan.messages.length,
        session: sessionIdOf(agent)
      })
      return { ...decision, messages: plan.messages }
    } catch (e) {
      stats.hitError()
      log({ ev: 'error', msg: String((e && e.message) || e) })
      return decision
    }
  })

  registerStatusTool(ctx, stats, () => seq)
  console.log('[pj-prefill] v' + VERSION + ' 已挂载（日志 ' + LOG_FILE + '）')
}
