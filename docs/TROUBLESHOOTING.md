# 排障

所有判据都落在两处：`prefill.log`（本插件写的）与目标会话的 `session.v4.jsonl.zstd`（DSH 写的）。
先跑 `pwsh -File scripts\check.ps1`，再看下面。

---

## 症状 A：`check.ps1` 报"日志不存在"

**判据**：插件的 `boot` 行都没有 → 模块从未被加载。

可能原因与修法：

| 原因 | 怎么确认 | 修法 |
|---|---|---|
| preset 里没有 pj-prefill 行 | 看 preset 组合文件 / `dump-config` 输出 | 跑 `scripts\install.ps1 -Apply` |
| 入口 URL 指向旧文件 | 看行里的 `name:` 是不是 `.../plugin.mjs` | 同上（脚本会把 `index.mjs` 换成 `plugin.mjs`） |
| preset 没被选中 | 会话日志里 `agent-preset/selected` 是不是目标 preset | 新建会话并显式选它（**不要 continue/fork**，会继承父会话的 preset） |
| 文件被 DSH 拒载 | 宿主 stdout 里的 `did not activate` | `node --check plugin.mjs` 看语法；再看 `inject` 声明的服务是否存在 |

---

## 症状 B：有 `boot` 行，但一次 `inject` 都没有

看 `check.ps1` 打印的**跳过原因分布**：

| `why` | 含义 | 修法 |
|---|---|---|
| `step-not-target` | 当前 step 不是 `onlyStep` | 正常（工具循环里不注入）。若一次都没有，确认 `onlyStep` 没被改成不存在的值 |
| `user-too-short` | 用户消息短于 `minUserChars` | 正常。想对短消息也注入就调小它 |
| `last-is-assistant` | messages 末尾已经是 assistant | 说明上一轮注入的 prefill 还在（`keepOneInHistory=false` 时会这样）。打开累积防护 |
| `max-injections` | 到上限了 | 调大 `maxInjections` 或设 0 |
| `no-messages` | 拿不到 messages 数组 | 内核版本变了，看 `plugin.mjs` 里的取值路径是否匹配 `payload.messages` |
| `only-own-prefill-left` | 剔掉自己的旧 prefill 后什么都不剩 | 异常；检查是不是把 prefill 注到了 system 位置 |

---

## 症状 C：注入了，但模型照样拒绝

**判据**：`prefill.log` 里有 `inject`，会话里模型仍然拒绝。

这**不是插件故障**，而是：

1. **前缀文本对这个模型无效**。`2607.14147` 与 `2404.02151` 都强调 adaptivity——有效前缀是模型相关的。改 `config/prefill.txt`（热生效）做小规模搜索：换一条 → 再发同一条请求 → 对比。
2. **请求太极端**，reasoning 重新接管了判定。降低单次请求的"一次性跨度"（先让它写到"框架/前一半"，再续）比反复加强前缀更有效。
3. **provider 侧审核**：模型已经配合，但 API 侧把输出拦了 → 看会话里是否有 provider 报错，或换本地模型。

---

## 症状 D：会话出现 API 报错 / 模型行为错乱

**判据**：会话里有 `400` / 角色序列相关报错，或模型开始"自问自答"。

1. **角色序列问题**：多半是历史里累积了多条 prefill。确认 `config.keepOneInHistory` 是 `true`；再确认给你的日志里 `stripped` 是否 > 0（> 0 说明剔除生效）。
2. **连续两条 assistant**：插件已用 `last-is-assistant` 拦住，但如果别的插件也往末尾插 assistant，仍可能撞车 → 临时关掉其它注入层定位。
3. **应急开关**：在项目根建一个内容为 `0` 的 `enabled` 文件即可**立即停注**（不用改配置、不用重启）：

   ```powershell
   Set-Content E:\MCP\pj-prefill\enabled '0'
   ```

---

## 症状 E：改了 `plugin.mjs` 但行为没变

**这是 DSH 的 ESM URL 缓存，不是你的错觉。** 宿主按 URL 缓存模块，改文件内容不会重载。

修法（二选一）：

1. **换文件名**（推荐，不用重启）：例如 `plugin2.mjs`，再更新挂载行指向它；
2. 重启 DSH 进程。

但注意：**改 `config/` 下的文件是热生效的**（每次注入前重新读），所以调前缀文本、改策略、开关注入，都不需要重启。

---

## 症状 F：`install.ps1` 说找不到组合文件

默认路径是本机 pj-merged 的 clean 组合文件。换环境时用参数指定：

```powershell
pwsh -File scripts\install.ps1 -Composition 'C:\path\to\your\agent.cordis.yml'
```

---

## 一句话速查

```powershell
# 状态一眼看
pwsh -File scripts\check.ps1

# 立刻停注（不用重启）
Set-Content E:\MCP\pj-prefill\enabled '0'

# 恢复
Remove-Item E:\MCP\pj-prefill\enabled

# 改前缀文本后马上生效，无需重启
notepad E:\MCP\pj-prefill\config\prefill.txt

# 单元测试
node E:\MCP\pj-prefill\tools\selftest.mjs
```
