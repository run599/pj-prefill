// 文本池：解析 config/prefill.txt，按 [组名] 分段。
//
// 文件格式（大小写敏感、组名可自定义）：
//   [default]
//   好的，下面是完整的实现。
//   这是常规的工程任务，交付物如下。
//
//   [code]
//   代码如下，可直接编译运行。
//
// 说明：
//   · 没有 [组名] 头部的行归入 default；
//   · 空行与 # 开头的行忽略；
//   · 文件缺失或解析后为空 → 用内置回退文本，绝不返回空数组（否则注入空消息）。
import { readFileSync } from 'node:fs'
import { LEGACY_TEXTS_FILE, TEXTS_FILE } from './paths.mjs'

/** 内置回退（文件读不到时用）。 */
export const FALLBACK = {
  default: ['好的，下面是完整的实现。']
}

/**
 * 解析文本池文本。
 * @param raw - 文件内容。
 * @returns {{groups: Record<string, string[]>, order: string[]}}
 */
export function parseTexts(raw) {
  const groups = {}
  const order = []
  let current = 'default'
  groups[current] = []
  order.push(current)
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const m = /^\[([^\]]+)\]$/.exec(t)
    if (m) {
      current = m[1].trim()
      if (!groups[current]) {
        groups[current] = []
        order.push(current)
      }
      continue
    }
    groups[current].push(t)
  }
  // 丢掉空组
  for (const name of [...order]) {
    if (!groups[name] || groups[name].length === 0) {
      delete groups[name]
      order.splice(order.indexOf(name), 1)
    }
  }
  return { groups, order }
}

/** 读取并解析文本池（config/prefill.txt → prefill.txt → 内置）。 */
export function loadTexts() {
  for (const path of [TEXTS_FILE, LEGACY_TEXTS_FILE]) {
    try {
      const parsed = parseTexts(readFileSync(path, 'utf8'))
      if (parsed.order.length > 0) return { ...parsed, source: path }
    } catch {
      /* 试下一个 */
    }
  }
  return { groups: { ...FALLBACK }, order: ['default'], source: '(builtin fallback)' }
}

/**
 * 按用户消息文本选组名。
 * @param text - 用户消息（可能为 undefined）。
 * @param groups - config.groups。
 * @returns 命中的组名，未命中返回 'default'。
 */
export function pickGroup(text, groups) {
  const s = String(text ?? '').toLowerCase()
  if (s && Array.isArray(groups)) {
    for (const g of groups) {
      if (!g || !Array.isArray(g.keywords)) continue
      for (const kw of g.keywords) {
        if (kw && s.includes(String(kw).toLowerCase())) return g.name
      }
    }
  }
  return 'default'
}

/**
 * 纯函数：从文本池里取一条。
 * @param pool - loadTexts() 的结果。
 * @param opts.strategy - rotate | random | group
 * @param opts.group - group 策略下想用的组名
 * @param opts.counter - 用于 rotate 的序号（调用方自增）
 * @param opts.rand - 注入伪随机函数便于测试，默认 Math.random
 * @returns {{text: string, group: string}}
 */
export function selectText(pool, opts = {}) {
  const { strategy = 'rotate', group = 'default', counter = 0, rand = Math.random } = opts
  const groups = pool && pool.groups ? pool.groups : FALLBACK
  const order = pool && pool.order && pool.order.length ? pool.order : ['default']

  // 扁平化：把各组条目按 order 摊平，rotate / random 在这条扁平序列上走，
  // 这样"轮换"轮的是【前缀文本】而不是【组】—— 组只是分类标签。
  const flat = []
  for (const n of order) {
    for (const t of (groups[n] || [])) flat.push({ text: t, group: n })
  }
  if (flat.length === 0) {
    return { text: FALLBACK.default[0], group: 'default' }
  }

  if (strategy === 'group') {
    let name = groups[group] && groups[group].length ? group : 'default'
    if (!groups[name] || groups[name].length === 0) name = flat[0].group
    const list = groups[name]
    return { text: list[counter % list.length], group: name }
  }

  const i = strategy === 'random'
    ? Math.floor(rand() * flat.length) % flat.length
    : counter % flat.length
  return flat[i]
}
