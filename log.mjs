// 日志：一行一条 JSONL，永不抛错（日志失败不能影响主流程）。
// 这是本插件唯一的自证入口 —— 宿主侧 UI 看不见 prefill 是否发生，只有这份日志能证明。
import { appendFileSync } from 'node:fs'

/**
 * @param path - 日志文件路径。
 * @returns 记录函数 (obj) => void
 */
export function makeLogger(path) {
  return function log(obj) {
    try {
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n')
    } catch {
      /* 见文件头 */
    }
  }
}
