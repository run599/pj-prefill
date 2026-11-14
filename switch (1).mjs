#!/usr/bin/env node
// pj-prefill 开关 CLI —— 不开 DSH 也能切（写文件，插件运行期热读）。
//
// 用法：
//   node tools/switch.mjs                              查看当前开关
//   node tools/switch.mjs on|off                       全局（同时写 enabled 文件 → **立刻生效**）
//   node tools/switch.mjs on|off --project [路径]      按项目（缺省 = 当前工作目录）
//   node tools/switch.mjs on|off --session <会话id>    按会话
//   node tools/switch.mjs clear --project [路径]       删除该项目的覆盖项
//   node tools/switch.mjs clear --session <会话id>     删除该会话的覆盖项
//
// 生效时机（重要，别记混）：
//   · 全局 on/off —— 同时写 switch.json 的 enabled 与旧版 enabled 文件，**当前进程立刻生效**
//     （旧版代码只认 enabled 文件；新版两者都认）。
//   · 按项目 / 按会话 —— 只有 v1.3.0+ 的代码会读，需宿主重启过一次才生效。
import { readFileSync, writeFileSync } from 'node:fs'
import { ENABLED_FILE, SWITCH_FILE } from '../lib/paths.mjs'
import { loadSwitch, saveSwitch, setSwitch, resolveSwitch, normPath, normSession, readPeerEnabled, PEER_STATE_FILE } from '../lib/switch.mjs'

const argv = process.argv.slice(2)

function flagValue(name) {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : '(current)'   // 后面没跟值 = 用缺省
}

/** 写旧版总闸文件：全局开关同时写它，保证"不用重启也生效"。 */
function writeEnabledFile(on) {
  try {
    writeFileSync(ENABLED_FILE, on ? '1' : '0', 'utf8')
    return true
  } catch {
    return false
  }
}

function readEnabledFile() {
  try {
    return readFileSync(ENABLED_FILE, 'utf8').trim()
  } catch {
    return '(缺失，回退 config.enabled)'
  }
}

function show() {
  const sw = loadSwitch()
  const resolved = resolveSwitch(null)
  const peer = readPeerEnabled()
  console.log('pj-prefill 开关')
  console.log('  switch.json        : ' + SWITCH_FILE)
  console.log('  全局 enabled       : ' + sw.enabled)
  console.log('  enabled 文件       : ' + ENABLED_FILE + '  = ' + JSON.stringify(readEnabledFile()))
  console.log('  姊妹开关 pj-toggle  : ' + (peer ? '开' : '关') + '   (' + PEER_STATE_FILE + ')')
  const projects = Object.entries(sw.projects)
  const sessions = Object.entries(sw.sessions)
  console.log('  按项目覆盖         : ' + (projects.length ? '' : '(无)'))
  for (const [k, v] of projects) console.log('      ' + (v ? '开' : '关') + '  ' + k)
  console.log('  按会话覆盖         : ' + (sessions.length ? '' : '(无)'))
  for (const [k, v] of sessions) console.log('      ' + (v ? '开' : '关') + '  ' + k)
  console.log('  当前目录解析结果   : ' + (resolved.enabled ? '注入' : '不注入')
    + '（由 ' + normPath(process.cwd()) + ' 决定；实际以会话的 cwd 为准）')
  console.log('')
  console.log('  注（2026-10-12 起）：')
  console.log('    · 判定只看两样：enabled 文件 / switch.json（会话 > 项目 > 全局）—— 任一为关即不注入。')
  console.log('    · 姊妹开关 pj-toggle **只作显示**，不参与判定（去掉了读侧 AND：它会把"开"压住，')
  console.log('      表现为"点了没反应"，比原来的矛盾更难查）。')
  console.log('    · 全局 on/off 能**关掉** boost（它读 switch.json 全局层），但**打不开** boost ——')
  console.log('      要打开 boost 请用头部按钮或插件页卡片（它们走 remote，能改它的内存态）。')
}

function main() {
  const action = (argv.find((a) => ['on', 'off', 'clear', 'status'].includes(a)) || 'status').toLowerCase()

  if (action === 'status') {
    show()
    return
  }

  const wantOn = action === 'on' ? true : action === 'off' ? false : null
  const projArg = flagValue('--project')
  const sessArg = flagValue('--session')

  if (action === 'clear') {
    const sw = loadSwitch()
    if (projArg !== undefined) {
      const key = normPath(projArg === '(current)' ? process.cwd() : projArg)
      if (!key) throw new Error('--project 需要路径')
      delete sw.projects[key]
      saveSwitch(sw)
      console.log('已删除项目覆盖：' + key)
    }
    if (sessArg !== undefined) {
      if (sessArg === '(current)') throw new Error('--session 需要会话 id')
      const key = normSession(sessArg)
      delete sw.sessions[key]
      saveSwitch(sw)
      console.log('已删除会话覆盖：' + key)
    }
    if (projArg === undefined && sessArg === undefined) throw new Error('clear 需要 --project 或 --session')
    console.log('')
    show()
    return
  }

  if (wantOn === null) throw new Error('未知动作：' + action)

  if (projArg !== undefined) {
    const key = projArg === '(current)' ? process.cwd() : projArg
    setSwitch({ scope: 'project', value: wantOn, target: key })
    console.log('项目 ' + normPath(key) + ' → ' + (wantOn ? '注入' : '不注入'))
  } else if (sessArg !== undefined) {
    if (sessArg === '(current)') throw new Error('--session 需要会话 id')
    setSwitch({ scope: 'session', value: wantOn, target: sessArg })
    console.log('会话 ' + normSession(sessArg) + ' → ' + (wantOn ? '注入' : '不注入'))
  } else {
    setSwitch({ scope: 'global', value: wantOn })
    const wroteFile = writeEnabledFile(wantOn)
    console.log('全局 → ' + (wantOn ? '注入' : '不注入') + '（switch.json 已写；enabled 文件' + (wroteFile ? '已写 → 立刻生效' : '写失败，需重启后生效') + '）')
  }

  console.log('')
  show()
}

try {
  main()
} catch (e) {
  console.error('错误：' + String((e && e.message) || e))
  console.error('用法见本文件顶部注释（node tools/switch.mjs on|off|clear|status [--project 路径] [--session id]）')
  process.exitCode = 1
}
