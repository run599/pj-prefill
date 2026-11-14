// pj-prefill 的宿主侧 typert 远程服务 —— 供**插件页卡片**（lib/client.js）读写开关。
//
// 为什么要它：`file://` 挂载的插件拿不到客户端包，也没有可被插件页调用的通道。
// 自 v1.4.0 起 pj-prefill 改为**包名挂载**（profile package.json + junction + patch 写
// `name: dsh-pj-prefill`），于是可以：①对外提供客户端包；②用 typert 暴露这三个方法。
//
// 方法（客户端卡片调用）：
//   getState()                        → 当前解析结果（全局/项目/会话/姊妹开关 + 是谁决定的）
//   setEnabled({enabled})             → 全局总开关（同时写 switch.json 与旧版 enabled 文件）
//   setScope({scope,target,value})    → 按项目 / 按会话覆盖
//
// ⚠️ setScope 的 target 是**必需**的（2026-10-14 修）：这里的 agentOf(this.ctx) 就是
//   agents.currentInitiator()，而它是 AsyncLocalStorage —— **插件页卡片调进来时不在任何
//   agent 驱动器边界内，必然 undefined**，于是 scope=project/session 且没 target 时会抛
//   "……需要 target……"。所以：
//     · 客户端卡片（lib/client.js）必须把目标（项目路径 / 会话 id）显式带上来；
//     · 在会话内用 pj_prefill_switch 工具时才有"当前会话"可省。
//   （内核契约：跨 wire 边界的身份必须显式传递，宿主不猜。）
//
// 与 pj-toggle 的分工：pj-toggle 是**界面按钮 + boost 段**；本文件是**插件页卡片 +
// prefill 请求层注入**。两者都读同一份 switch.json，且都做 AND（任一为关，两层全停）。
//
// 依赖解析（与 pj-toggle 同一套做法，零联网）：@deepseek-ai/dsh-typert-protocol 与 zod
// 由本包 node_modules 下的 junction 指向 C:\Users\时\.dsh\profiles\node_modules 的同一份副本。
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { readPeerEnabled, resolveSwitch, setSwitch, writeEnabledFlag, PEER_STATE_FILE } from './switch.mjs'
import { SWITCH_FILE } from './paths.mjs'

export const PACKAGE_NAME = 'dsh-pj-prefill'
export const NS = 'pjPrefill'

/** 取当前会话的 agent（compact-tool 已验证的取法）；拿不到返回 undefined。 */
function agentOf(ctx) {
  try {
    const agents = ctx.get('agents')
    return agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
  } catch {
    return undefined
  }
}

/** 把 resolveSwitch 的结果摊平成**无损 JSON**（数组而非 map —— 避免 zod record 版本差异）。 */
export function stateOf(ctx) {
  const sw = resolveSwitch(agentOf(ctx))
  const pairs = (obj) => Object.entries(obj).map(([key, enabled]) => ({ key, enabled }))
  return {
    enabled: sw.enabled,
    // 2026-10-21：把"应急闸"与"真正会不会注入"一起送给界面，避免卡片显示的三层值
    // 与 enabled 文件的实际闸门打架（口径与头部按钮一致：三层 ∧ 应急闸）。
    gateEnabled: sw.gate,
    effective: sw.effective,
    global: sw.global,
    peerEnabled: sw.peerEnabled,
    decidedBy: sw.scope,
    layer: sw.layer,
    project: sw.project,
    session: sw.session,
    projects: pairs(sw.projects),
    sessions: pairs(sw.sessions),
    switchFile: SWITCH_FILE,
    peerFile: PEER_STATE_FILE
  }
}

// ── wire 形状：0.2.0 的 strict codec 必须带 create() 惰性工厂，rc.5 只认 schema 二者都带上 ──
const scalarOrNull = z.string().nullable()
const pair = z.object({ key: z.string(), enabled: z.boolean() })

const stateSchema = z.object({
  enabled: z.boolean(),
  gateEnabled: z.boolean(),
  effective: z.boolean(),
  global: z.boolean(),
  peerEnabled: z.boolean(),
  decidedBy: z.string(),
  layer: z.string(),
  project: scalarOrNull,
  session: scalarOrNull,
  projects: z.array(pair),
  sessions: z.array(pair),
  switchFile: z.string(),
  peerFile: z.string()
})

const setEnabledRequestSchema = z.object({ enabled: z.boolean() })

const setScopeRequestSchema = z.object({
  scope: z.enum(['project', 'session']),
  value: z.boolean(),
  target: z.string().optional()
})

function codec(typeSymbol, schema) {
  return { mode: 'strict', typeSymbol, schema, create: () => schema }
}

function jsonParameter(name, typeSymbol, schema) {
  return { name, wire: name, source: 'json', codec: codec(typeSymbol, schema) }
}

export const MANIFEST = {
  package: PACKAGE_NAME,
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: PACKAGE_NAME + '#pjPrefill/getState',
      service: NS,
      namespace: NS,
      method: 'getState',
      implementation: 'getState',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec(PACKAGE_NAME + '#PjPrefillState', stateSchema)
    },
    {
      id: PACKAGE_NAME + '#pjPrefill/setEnabled',
      service: NS,
      namespace: NS,
      method: 'setEnabled',
      implementation: 'setEnabled',
      invocation: { kind: 'direct' },
      parameters: [jsonParameter('request', PACKAGE_NAME + '#SetEnabledRequest', setEnabledRequestSchema)],
      result: codec(PACKAGE_NAME + '#PjPrefillState', stateSchema)
    },
    {
      id: PACKAGE_NAME + '#pjPrefill/setScope',
      service: NS,
      namespace: NS,
      method: 'setScope',
      implementation: 'setScope',
      invocation: { kind: 'direct' },
      parameters: [jsonParameter('request', PACKAGE_NAME + '#SetScopeRequest', setScopeRequestSchema)],
      result: codec(PACKAGE_NAME + '#PjPrefillState', stateSchema)
    }
  ],
  model: { services: [], events: [], objects: [] }
}

export class PjPrefillGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, NS)
  }

  getState() {
    return stateOf(this.ctx)
  }

  /** 全局总开关：同时写 switch.json 与旧版 enabled 文件（后者让"立刻生效"在旧代码上也成立）。 */
  setEnabled(request) {
    const on = request.enabled === true
    setSwitch({ scope: 'global', value: on })
    writeEnabledFlag(on)
    console.log('[pj-prefill] 全局开关 ' + (on ? '已开启' : '已关闭') + '（switch.json + enabled 文件）')
    return stateOf(this.ctx)
  }

  /** 按项目 / 按会话覆盖；target 缺省取当前会话的 cwd / session id。 */
  setScope(request) {
    const scope = request.scope === 'session' ? 'session' : 'project'
    const value = request.value === true
    const target = typeof request.target === 'string' && request.target.trim() ? request.target.trim() : undefined
    setSwitch({ scope, value, target, agent: agentOf(this.ctx) })
    console.log('[pj-prefill] ' + scope + ' 覆盖 → ' + (value ? '开' : '关') + (target ? '（' + target + '）' : '（当前会话）'))
    return stateOf(this.ctx)
  }
}
