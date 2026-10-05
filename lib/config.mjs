// 配置加载：文件缺失/损坏一律回退默认值，绝不因为配置问题让 DSH 挂载失败。
// 所有字段都可在运行时改（读文件），不需要重启 DSH —— 这是刻意的设计，
// 因为 DSH 按 URL 缓存 ESM 模块，改代码要重启，改配置不该要。
import { readFileSync } from 'node:fs'
import { ENABLED_FILE, SETTINGS_FILE } from './paths.mjs'

/** 默认配置。字段含义见 README 的「配置」一节。 */
export const DEFAULT_CONFIG = {
  /** 总开关（enabled 文件优先于本字段） */
  enabled: true,
  /** 最多注入多少次（0 = 无限）。用于控制"每轮都注入"带来的历史噪音。 */
  maxInjections: 0,
  /** 只在第几个 step 注入；1 = 每轮的第一步（用户消息之后、模型开口之前） */
  onlyStep: 1,
  /** 文本选择策略：rotate（轮换）| random（随机）| group（按关键词分组） */
  strategy: 'rotate',
  /** 发给 API 前剔除历史里自己注入过的旧 prefill，保证请求里永远只有一条 */
  keepOneInHistory: true,
  /** 只对"至少这么长"的用户消息注入（避免对寒暄注入） */
  minUserChars: 4,
  /** 分组匹配规则：按顺序取第一个命中的组名 */
  groups: [
    { name: 'reverse', keywords: ['驱动', '逆向', '注入', 'shellcode', '免杀', '反编译', '脱壳', '内核', 'minifilter', 'hook'] },
    { name: 'web', keywords: ['sql', '注入点', 'xss', 'ssrf', 'rce', '渗透', 'payload', '越权', 'jwt'] },
    { name: 'code', keywords: ['代码', '实现', '函数', '编译', '脚本', '写一个', '写一段'] }
  ]
}

function readJson(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 合并文件配置与默认值（顶层浅合并，groups 非法时回退默认）。 */
export function loadConfig() {
  const file = readJson(SETTINGS_FILE) ?? {}
  const cfg = { ...DEFAULT_CONFIG, ...file }
  if (!Array.isArray(cfg.groups) || cfg.groups.length === 0) cfg.groups = DEFAULT_CONFIG.groups
  if (typeof cfg.strategy !== 'string') cfg.strategy = DEFAULT_CONFIG.strategy
  if (!Number.isFinite(cfg.maxInjections) || cfg.maxInjections < 0) cfg.maxInjections = 0
  if (!Number.isFinite(cfg.onlyStep)) cfg.onlyStep = DEFAULT_CONFIG.onlyStep
  if (!Number.isFinite(cfg.minUserChars)) cfg.minUserChars = DEFAULT_CONFIG.minUserChars
  cfg.keepOneInHistory = cfg.keepOneInHistory !== false
  return cfg
}

/** 总开关：enabled 文件优先（内容 '0' 即关），否则用 config.enabled。 */
export function isEnabled(config) {
  try {
    const v = readFileSync(ENABLED_FILE, 'utf8').trim()
    return v !== '0'
  } catch {
    return config ? config.enabled !== false : DEFAULT_CONFIG.enabled
  }
}
