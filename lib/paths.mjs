// 路径常量：全部相对项目根解析，便于整目录搬移。
//
// 刻意保留两个"历史路径"不搬家，避免与既有部署/自证流程错位：
//   · prefill.log  —— 旧版单文件插件就写在这里，检查脚本与人工排查都认这个路径
//   · prefill.txt  —— 旧版文本池位置，仍然作为 config/prefill.txt 的兼容回退
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** lib/ 目录 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 项目根目录（lib/ 的上一级） */
export const ROOT = dirname(HERE)

/** 配置目录 */
export const CONFIG_DIR = join(ROOT, 'config')

/** 文本池（优先） */
export const TEXTS_FILE = join(CONFIG_DIR, 'prefill.txt')

/** 文本池（旧版位置，兼容回退） */
export const LEGACY_TEXTS_FILE = join(ROOT, 'prefill.txt')

/** 策略配置 */
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json')

/** 总开关文件：存在且内容不是 0 才注入；不存在时用 config.enabled */
export const ENABLED_FILE = join(ROOT, 'enabled')

/** 注入日志（JSONL） */
export const LOG_FILE = join(ROOT, 'prefill.log')

/** 跨进程统计快照 */
export const STATE_FILE = join(ROOT, 'state.json')
