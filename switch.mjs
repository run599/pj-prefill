// 三层开关（v1.3.0）：全局 / 按项目 / 按会话。
//
// 为什么要它：prefill 挂在 profile 层，**对所有会话生效**。实际用起来，"每个项目都被注入
// 破甲前缀"是负担 —— 很多项目要的是干净、正常的输出。所以开关分三层，优先级从高到低：
//
//     sessions[<会话 id>]   >   projects[<cwd 规范化>]   >   enabled（全局）
//
// 全部**运行期热读**：改 switch.json 立即生效，不需要重启 DSH（与 lib/config.mjs 一致）。
//
// 与插件自带总闸的关系（两者是 AND，不是替代）：
//   · switch.json（本文件）—— 日常用这个，可精确到"某个项目关掉"
//   · enabled 文件 / config.enabled（lib/config.mjs）—— 应急全停用，一个文件管死
//
// switch.json 形状（键都会被本模块规范化，手写大小写/斜杠都不影响匹配）：
// {
//   "enabled": true,
//   "projects": { "e:/远控": false },
//   "sessions": { "session-90a927e4-…": false }
// }
//
// 设计约束（踩过的坑，改这个文件前先读）：
//   1. 绝不让"读配置失败"导致挂载失败：全部 try/catch 回退默认（默认开）。
//   2. 临时文件必须与目标同目录 —— os/fs 的 rename 不能跨盘（2026-10-07 在会话修复脚本里踩过）。
//   3. 返回值必须是无损 JSON（不可含 undefined），因为它会被工具直接返回给模型。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ENABLED_FILE, SWITCH_FILE } from './paths.mjs'

/**
 * 写旧版总闸文件（内容 '1'/'0'）—— `isEnabled()` 每次现读，所以这条路径**不用重启就生效**。
 * 插件页卡片的全局开关会同时写它与 switch.json：前者让"立刻生效"在旧代码上也成立，
 * 后者提供三层精度与姊妹开关联动。返回是否写成功。
 */
export function writeEnabledFlag(on) {
  try {
    writeFileSync(ENABLED_FILE, on ? '1' : '0', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 默认：**关**。2026-11-05 改为 fail-closed —— 文件缺失/损坏/解析失败一律视为关，
 *  不再回退成开。理由与 config.mjs 的 isEnabled() 相同：不确定状态不能等于授权。 */
export const DEFAULT_SWITCH = { enabled: false, projects: {}, sessions: {} }

/**
 * 姊妹插件 pj-toggle 的开关文件（它的界面按钮写的就是它）。
 *
 * 为什么 prefill 也要读它（2026-10-11 实测事故，用户报"我明明关了还在注入"）：
 * 两个插件原本各有一套"关"，于是出现**界面显示"关"、实际仍在注入**：
 *   · 按钮（pj-toggle）只写自己的 state.json；prefill 只读 switch.json → 关了一个，另一个照跑。
 * 现在两边互相读、各自再做一次 AND：
 *   · prefill 有效值 = switch.json(会话>项目>全局) AND pj-toggle/state.json
 *   · pj-toggle 有效值 = 自己的 state.json AND switch.json 全局层
 *   ⇒ 任一处"关"，两层全停 —— 界面状态与实际行为不可能再矛盾。
 */
export const PEER_STATE_FILE = 'E:\\MCP\\pj-toggle\\state.json'

/**
 * 读姊妹开关（pj-toggle）—— **历史遗留，仅供显示，不参与任何注入判定**。
 *
 * 2026-10-27：pj-toggle 已删除，PEER_STATE_FILE 指向的路径不再存在。
 * 2026-11-05：改为 fail-closed —— 文件缺失返回 false。
 *   此前"读不到就回退 true"正是状态输出里那个误导性 `peerEnabled: true`
 *   的来源（插件已删，界面却还显示姊妹插件是开的）。
 */
export function readPeerEnabled() {
  try {
    const parsed = JSON.parse(readFileSync(PEER_STATE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed.enabled === true : false
  } catch {
    return false
  }
}

/**
 * 读本插件自己的应急闸（`enabled` 文件，内容 '0' 即关）。
 *
 * 2026-10-21 加：`isEnabled()` 每次注入前都读它，但插件页卡片原先只显示 switch.json 的三层值，
 * 于是"应急闸被关、switch.json 还是开"时卡片写「prefill：开」而实际不注入 —— 又一处
 * "界面说开、行为是关"。把这道闸单独暴露出来，卡片显示的有效值才是真值，
 * 口径也与 pj-toggle 头部按钮（switch.json 全局 ∧ 本文件）一致。
 */
export function readEnabledGate() {
  try {
    // 与 config.mjs 的 isEnabled() 保持同一口径：**只有严格 '1' 才算开**。
    // 2026-11-05 由 `!== '0'` 收紧为 `=== '1'`，并 fail-closed（异常→false）。
    return readFileSync(ENABLED_FILE, 'utf8').trim() === '1'
  } catch {
    return false
  }
}

/** cwd 规范化：反斜杠→正斜杠、去尾部斜杠、转小写。保证 key 稳定可比。 */
export function normPath(p) {
  if (typeof p !== 'string') return null
  const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return s ? s.toLowerCase() : null
}

/** 会话 id 规范化（统一小写；uuid 本来就小写，手写大写也能命中）。 */
export function normSession(id) {
  if (typeof id !== 'string') return null
  const s = id.trim().toLowerCase()
  return s ? s : null
}

/** 从 agent 取 cwd：沿用 dsh-memory-evolve 的取法 agent.session.header.cwd，另留两个保守回退。 */
export function cwdOf(agent) {
  try {
    const v = agent?.session?.header?.cwd ?? agent?.header?.cwd ?? agent?.cwd
    return typeof v === 'string' && v.trim() ? v : null
  } catch {
    return null
  }
}

/** 从 agent 取会话 id（与 plugin.mjs 的 sessionIdOf 同源，字段名做多路兜底）。 */
export function sessionIdOf(agent) {
  try {
    const v = agent?.id ?? agent?.session?.id ?? agent?.session?.sessionId
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 读 switch.json 并规范化（容错：非法条目直接忽略，不影响其余）。 */
export function loadSwitch() {
  const file = readJson(SWITCH_FILE) ?? {}
  const out = { enabled: file.enabled !== false, projects: {}, sessions: {} }
  const projects = file.projects
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [k, v] of Object.entries(projects)) {
      const key = normPath(k)
      if (key) out.projects[key] = v !== false
    }
  }
  const sessions = file.sessions
  if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
    for (const [k, v] of Object.entries(sessions)) {
      const key = normSession(k)
      if (key) out.sessions[key] = v !== false
    }
  }
  return out
}

/** 原子写 switch.json（同目录临时文件 + rename；返回落盘路径）。 */
export function saveSwitch(next) {
  const body = JSON.stringify(
    {
      enabled: next.enabled !== false,
      projects: next.projects ?? {},
      sessions: next.sessions ?? {}
    },
    null,
    2
  ) + '\n'
  mkdirSync(dirname(SWITCH_FILE), { recursive: true })
  const tmp = SWITCH_FILE + '.tmp'
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, SWITCH_FILE)
  return SWITCH_FILE
}

/**
 * 解析一次会话的实际开关。
 * @param agent 可为空 —— 为空时只看全局层（CLI / 状态工具用）。
 * @returns 全部字段均为无损 JSON（无 undefined）。
 */
export function resolveSwitch(agent) {
  const sw = loadSwitch()
  const peer = readPeerEnabled()
  const session = sessionIdOf(agent)
  const cwd = cwdOf(agent)
  const projectKey = normPath(cwd)
  const sessionKey = normSession(session)

  // switch.json 三层解析：会话 > 项目 > 全局
  let layer = 'global'
  let value = sw.enabled
  if (projectKey && Object.prototype.hasOwnProperty.call(sw.projects, projectKey)) {
    layer = 'project'
    value = sw.projects[projectKey]
  }
  if (sessionKey && Object.prototype.hasOwnProperty.call(sw.sessions, sessionKey)) {
    layer = 'session'
    value = sw.sessions[sessionKey]
  }

  // 有效值只看 switch.json 这三层。
  //
  // 2026-10-12 改（重要）：**去掉了"与姊妹开关 AND"**。原设计（v1.3.1）让
  // 有效值 = 本文件 AND pj-toggle/state.json，本意是"任一处关就全关，界面不会骗人"；
  // 但实测出两个坏后果：
  //   ① 头部按钮关掉 boost 之后，插件页开关按"开"**毫无反应**（被 AND 压住）——
  //      用户看到的是"点了没反应"，比原来的矛盾更难理解；
  //   ② decidedBy 变成 peer(pj-toggle)，排查时看不出自己设的那一层。
  // 改为**写侧联动**：两个开关（头部按钮 / 插件页卡片）都同时写两层，谁按都一起动；
  // 读侧各看各的，不再有暗耦合。peerEnabled 仍保留**仅供显示**，不参与判定。
  const enabled = value !== false
  const gate = readEnabledGate()
  const scope = layer

  return {
    enabled,
    // 应急闸（enabled 文件）与"真正会不会注入" = 三层值 ∧ 应急闸
    gate,
    effective: enabled && gate,
    scope,
    layer,
    peerEnabled: peer,
    peerFile: PEER_STATE_FILE,
    global: sw.enabled,
    project: cwd ?? null,
    projectKey: projectKey ?? null,
    session: session ?? null,
    projects: sw.projects,
    sessions: sw.sessions,
    file: SWITCH_FILE
  }
}

/**
 * 改开关并落盘。
 * @param scope global | project | session
 * @param value true=开 / false=关
 * @param target project 作用域=项目路径；session 作用域=会话 id；缺省取 agent 的对应值
 * @param agent  提供默认 target 的会话上下文（**只在 agent 驱动器边界内才有值**：
 *   agents.currentInitiator() 是 AsyncLocalStorage，插件页卡片 / CLI 这类调用方拿到的是
 *   undefined）⇒ 无会话上下文的调用方**必须显式给 target**，否则下面直接拒绝。
 * @returns 落盘后重新解析的结果
 */
export function setSwitch({ scope = 'global', value, target, agent } = {}) {
  const on = value !== false
  const sw = loadSwitch()

  if (scope === 'global') {
    sw.enabled = on
  } else if (scope === 'project') {
    const key = normPath(target ?? cwdOf(agent))
    if (!key) throw new Error('project 作用域需要 target（项目路径）：调用方不在 agent 驱动器边界内时 agents.currentInitiator() 必然为 undefined（插件页卡片就是这种），所以必须显式给出项目路径；在会话内可直接用 pj_prefill_switch 工具（它自带当前会话的 cwd）')
    sw.projects[key] = on
  } else if (scope === 'session') {
    const key = normSession(target ?? sessionIdOf(agent))
    if (!key) throw new Error('session 作用域需要 target（会话 id）：调用方不在 agent 驱动器边界内时 agents.currentInitiator() 必然为 undefined（插件页卡片就是这种），所以必须显式给出会话 id；在会话内可直接用 pj_prefill_switch 工具（它自带当前会话 id）')
    sw.sessions[key] = on
  } else {
    throw new Error('未知 scope：' + String(scope) + '（应为 global | project | session）')
  }

  saveSwitch(sw)
  return resolveSwitch(agent)
}
