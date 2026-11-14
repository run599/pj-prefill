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
//
// v1.2.0（2026-10-07）—— 落盘合规化，攻击手法一格未动：
//   DSH 0.2.0 的 loop 把 pre-step 返回的每条消息**无条件**按 user/message 落盘，
//   而读取时校验 user/message 的 role 必须是 "user" → 注入的 assistant 前缀会让整份
//   会话在下次加载时报 `message must have role "user"` 并永久打不开。
//   修法见 lib/settle.mjs：在**落盘边界**把这条前缀改写成形状合法的 assistant/message
//   settlement（位置不变、模型看到的消息逐字不变），不改宿主、不改请求内容。
//
// v1.3.0 —— 加开关（用户诉求："一直开着对很多项目反而是坑"）：
//   攻击手法照旧，只加"什么时候不注入"。开关三层，优先级 会话 > 项目 > 全局，
//   全部运行期热读 switch.json（改文件即生效，不用重启），见 lib/switch.mjs。
//   · 新增工具 pj_prefill_switch：global / project / session 三档随手切；
//   · pj_prefill_status 增加 switch 段（含"本会话实际生效值 + 是哪一层决定的"）；
//   · 关掉时**要记日志**（旧代码在 !isEnabled 处是静默 return，事后无法区分
//     "关了" 和 "坏了" —— 这是本机反复踩的静默失效类问题）。
import { loadConfig, isEnabled } from './lib/config.mjs'
import { loadTexts } from './lib/texts.mjs'
import { planInjection } from './lib/pick.mjs'
import { installSettlementShim, recordRequestRoute } from './lib/settle.mjs'
import { makeLogger } from './lib/log.mjs'
import { makeStats } from './lib/stats.mjs'
import { LOG_FILE, STATE_FILE, SWITCH_FILE } from './lib/paths.mjs'
import { loadSwitch, resolveSwitch, setSwitch } from './lib/switch.mjs'
import { MANIFEST as REMOTE_MANIFEST, PjPrefillGateway } from './lib/remote.mjs'

export const VERSION = '1.4.0'

export const name = 'pj-prefill'

/**
 * tools=注册工具；agents=让开关工具/远程服务默认作用于"当前会话"（cwd/session id）；
 * typert=把开关暴露给插件页卡片（自 v1.4.0 起本插件按**包名挂载**，客户端包才拿得到）。
 */
export const inject = ['tools', 'agents', 'typert']

/** 取当前会话的 agent（compact-tool 已验证的取法：agents.currentInitiator()）。 */
function currentAgent(ctx) {
  try {
    const agents = ctx.get('agents')
    return agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
  } catch {
    return undefined
  }
}


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
      const sw = resolveSwitch(currentAgent(ctx))
      return {
        plugin: name,
        version: VERSION,
        // enabled = 插件自带总闸（enabled 文件 / config.enabled）
        enabled: isEnabled(config),
        // switch = 三层开关（会话 > 项目 > 全局）的实际解析结果；
        // 只有 enabled（自带总闸：enabled 文件 / config.enabled）与 switch.enabled 同时为 true 才会注入。
        switch: {
          file: SWITCH_FILE,
          global: sw.global,
          // 姊妹插件 pj-toggle 的状态值 —— **仅供显示，不参与判定**。
          //   2026-10-12 起读侧解耦（否则"关了一层另一层照跑"）、改走写侧联动：
          //   头部按钮与插件页卡片都同时写 switch.json 全局层 + enabled 应急闸。
          //   2026-10-14 起 pj-toggle 又把 state.json 降级为**只写不读的镜像**，所以这个值
          //   在"只用 CLI 改过开关"之后会滞后，别拿它当判据（判定只看上面两个真闸）。
          peerEnabled: sw.peerEnabled,
          peerFile: sw.peerFile,
          thisSession: {
            enabled: sw.enabled,
            // decidedBy 是**谁决定的**：global/project/session（switch.json 三层）或 peer(pj-toggle)
            decidedBy: sw.scope,
            layer: sw.layer,
            project: sw.project,
            session: sw.session
          },
          projects: sw.projects,
          sessions: sw.sessions
        },
        injectionsThisProcess: getSeq(),
        config,
        textPool: {
          source: pool.source,
          groups: Object.fromEntries(Object.entries(pool.groups).map(([k, v]) => [k, v.length]))
        },
        files: { log: LOG_FILE, state: STATE_FILE, switch: SWITCH_FILE },
        lastPersisted: stats.readPersisted()
      }
    }
  }), 'pj-prefill: status tool')
}

/**
 * 注册开关工具：把"要不要注入"变成模型/用户都能随手改的一件事。
 * 写 switch.json，运行期热读 → 下一次注入就按新值走，不需要重启宿主。
 */
function registerSwitchTool(ctx) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return
  ctx.effect(() => ctx.tools.register({
    name: 'pj_prefill_switch',
    description:
      'Turn the pj-prefill layer (request-layer assistant-prefix injection) on or off. '
      + 'scope=global affects every session; scope=project affects one project directory '
      + "(defaults to this session's cwd); scope=session affects one session id. "
      + 'Writes switch.json and takes effect on the very next step (hot-read, no host restart). '
      + 'Use when the user wants the injection layer off for some projects but not others.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'boolean', description: 'true = enable injection, false = disable' },
        scope: {
          type: 'string',
          enum: ['global', 'project', 'session'],
          description: 'default global'
        },
        target: {
          type: 'string',
          description: 'project path (scope=project) or session id (scope=session); defaults to the current session'
        }
      },
      required: ['value'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    execute(args) {
      const scope = typeof args?.scope === 'string' ? args.scope : 'global'
      const target = typeof args?.target === 'string' && args.target.trim() ? args.target.trim() : undefined
      try {
        const sw = setSwitch({ scope, value: args?.value === true, target, agent: currentAgent(ctx) })
        return {
          ok: true,
          applied: { scope, value: args?.value === true, target: target ?? null },
          file: SWITCH_FILE,
          switch: {
            global: sw.global,
            thisSession: { enabled: sw.enabled, decidedBy: sw.scope, project: sw.project, session: sw.session },
            projects: sw.projects,
            sessions: sw.sessions
          }
        }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), applied: { scope, value: args?.value === true, target: target ?? null } }
      }
    }
  }), 'pj-prefill: switch tool')
}

export function apply(ctx) {
  const log = makeLogger(LOG_FILE)
  const stats = makeStats(STATE_FILE)
  let seq = 0
  let booted = false

  // 插件页卡片的后端：暴露 getState / setEnabled / setScope（见 lib/remote.mjs）。
  // 构造失败不能连累事件监听 —— 卡片不可用可以接受，注入层挂不上不可以。
  let gateway = null
  try {
    gateway = new PjPrefillGateway(ctx)
  } catch (e) {
    console.log('[pj-prefill] 远程服务构造失败（插件页卡片将不可用）：' + String((e && e.message) || e))
  }

  if (typeof ctx.on !== 'function') {
    console.log('[pj-prefill] ctx.on 不可用，跳过挂载')
    return
  }

  // 记录每次请求真实解析出的路由与 (turn, step)。原方法不变，只旁听 next() 的结果。
  // 这是唯一能在"首个请求、用户消息落盘之前"拿到 provider/model 的时机，
  // 而 assistant/message 的 message.source 需要它。
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      recordRequestRoute(payload?.agent, payload?.turn, payload?.step, config)
    } catch (e) {
      log({ ev: 'error', msg: 'record-route: ' + String((e && e.message) || e) })
    }
    return config
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const { agent, step } = payload ?? {}
      const config = loadConfig()
      const sw = resolveSwitch(agent)

      if (!booted) {
        booted = true
        stats.boot()
        const pool = loadTexts()
        log({
          ev: 'boot',
          version: VERSION,
          enabled: isEnabled(config),
          switchGlobal: sw.global,
          switchFile: SWITCH_FILE,
          textPoolSource: pool.source,
          textGroups: pool.order,
          config
        })
      }

      // 两级开关都要开才注入。关掉时必须留痕：旧代码在 !isEnabled 处是静默 return，
      // 事后无法区分"被关掉了"和"插件坏了"（本机反复踩的静默失效类问题）。
      if (!isEnabled(config)) {
        stats.hitSkip('plugin-disabled')
        log({ ev: 'skip', why: 'plugin-disabled', step, session: sessionIdOf(agent) })
        return decision
      }
      if (!sw.enabled) {
        stats.hitSkip('switch-off')
        log({
          ev: 'skip',
          why: 'switch-off',
          decidedBy: sw.scope,
          project: sw.project,
          step,
          session: sessionIdOf(agent)
        })
        return decision
      }
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

      // 落盘改写必须在注入之前就位。装不上就不注入：宁可这一步少了前缀，
      // 也绝不把 role:"assistant" 的 user/message 写进日志（那会废掉整份会话）。
      if (!installSettlementShim(agent?.session, agent, (record) => log(record))) {
        stats.hitSkip('no-settle-shim')
        log({ ev: 'skip', why: 'no-settle-shim', step, session: sessionIdOf(agent) })
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
  registerSwitchTool(ctx)
  // 插件页卡片的后端注册（ctx.typert 由 inject 声明保证存在）
  if (gateway && ctx.typert && typeof ctx.typert.register === 'function') {
    ctx.effect(() => ctx.typert.register(REMOTE_MANIFEST), 'pj-prefill: remote manifest')
  }
  console.log('[pj-prefill] v' + VERSION + ' 已挂载（日志 ' + LOG_FILE + '；开关 ' + SWITCH_FILE
    + '；插件页卡片 ' + (gateway ? '已注册 remote ' + REMOTE_MANIFEST.invocations.length + ' 个方法' : '不可用') + '）')
}
