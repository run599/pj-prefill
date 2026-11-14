// pj-prefill 客户端：把「破甲」注册成**插件页里的一张卡片**（自带开关）。
//
// 挂载点（2026-10-12 从 app.asar 的 @deepseek-ai/dsh-client-ui-plugin-manager 读出）：
//   插件页把 `plugins.item` 的注册渲染成卡片；点开详情页时按 id 渲染两段：
//     renderSlot("plugins.item", { view: "summary" })      → 一行摘要
//     renderSlot("plugins.item", { view: "page", form })    → 配置区（开关放这里）
//   官方 ui-settings-shell / ui-settings-agent-loop 用的就是这个插槽。
//
// 为什么必须"包名挂载"才有这个文件：内核 @deepseek-ai/dsh-client-modules 按**包名**解析
// 客户端入口（plugins/<id>/client.js）。file:// 挂载的插件拿不到客户端包 —— 这就是之前
// "做了开关但界面上看不到"的根因。自 v1.4.0 起 pj-prefill 走包名挂载。
//
// 开关语义（2026-10-12 定案，改之前先读）：
//   · **总开关（全局）**：同时写两层 —— 本插件的 prefill（remote.pjPrefill）与
//     boost 段（remote.pjToggle）。谁按都一起动，所以两个入口永远一致。
//   · **本项目 / 本会话**：只对 prefill 生效（boost 是 systemPrompt.section 的 text 回调，
//     拿不到 agent，做不到按项目/按会话）。这是硬边界，不是偷懒。
//   · 读侧**不做 AND**（v1.3.1 试过，害处大于好处：按钮关 boost 后本卡片的"开"没反应）。
//
// 三个坑（都踩过，别删）：
//   1. locale 字典的值**必须是字符串** —— 写成函数会让整条插槽注册失败且无任何报错。
//   2. 图标具名导出在两条版本线上名字不同（16 后缀 vs Regular/Medium）→ 防御式 pick，
//      解析不到就**不传 icon**（undefined 交给 createElement = React #130 = 整条槽崩）。
//   3. Button 可能解析不到 → 退化成原生 <button>（字符串标签是合法内置元素）。
window.__ModuleLoader__.load({
  id: "dsh-pj-prefill",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives") ?? {};

    const pick = (...names) => {
      for (const name of names) {
        if (primitives[name]) return primitives[name];
      }
      return undefined;
    };
    const Button = pick("Button");
    const ButtonTag = Button ?? "button";
    const { useEffect, useState } = React;

    const PACKAGE_NAME = "dsh-pj-prefill";
    const NS = "pjPrefill";
    const BOOST_NS = "pjToggle";

    const zh = {
      title: "破甲（prefill 注入 + boost 段）",
      on: "开",
      off: "关",
      unknown: "未知",
      globalSwitch: "总开关（全局）",
      project: "本项目",
      session: "本会话",
      prefill: "prefill 注入",
      boost: "boost 段",
      gate: "应急闸（enabled 文件）",
      override: "覆盖",
      none: "无覆盖",
      switching: "切换中…",
      connectFail: "连接宿主失败",
      projOff: "本项目：关",
      projOn: "本项目：开",
      sessOff: "本会话：关",
      sessOn: "本会话：开",
      boostUnavailable: "（boost 插件未挂载）",
      projectTarget: "目标项目",
      projectPlaceholder: "项目路径，如 E:\\your-project",
      sessionTarget: "目标会话",
      sessionPlaceholder: "会话 id，如 session-9f3c…",
      projectOverrides: "已设的项目覆盖",
      sessionOverrides: "已设的会话覆盖",
      needTarget: "请先填目标：项目作用域填项目路径（如 E:\\your-project），会话作用域填会话 id（session-…）。会话内也可以直接用 pj_prefill_switch 工具（它自带当前会话的 cwd/id）。",
      hint: "总开关会同时切换两层，改完立刻生效（插件热读 switch.json，无需重启）。按项目/按会话只对 prefill 生效，且**必须写明目标**：插件页没有“当前会话”上下文，宿主不会替你猜（内核契约要求跨 wire 边界的身份显式传递）。",
    };
    const en = {
      title: "Jailbreak (prefill injection + boost section)",
      on: "on",
      off: "off",
      unknown: "unknown",
      globalSwitch: "Master switch (global)",
      project: "This project",
      session: "This session",
      prefill: "prefill injection",
      boost: "boost section",
      gate: "Kill switch (enabled file)",
      override: "override",
      none: "none",
      switching: "Switching…",
      connectFail: "Host connection failed",
      projOff: "This project: off",
      projOn: "This project: on",
      sessOff: "This session: off",
      sessOn: "This session: on",
      boostUnavailable: "(boost plugin not mounted)",
      projectTarget: "Target project",
      projectPlaceholder: "project path, e.g. E:\\your-project",
      sessionTarget: "Target session",
      sessionPlaceholder: "session id, e.g. session-9f3c…",
      projectOverrides: "Project overrides set",
      sessionOverrides: "Session overrides set",
      needTarget: "Set a target first: a project path (e.g. E:\\your-project) for project scope, or a session id (session-…) for session scope. Inside a session you can also use the pj_prefill_switch tool, which already knows the current cwd/id.",
      hint: "The master switch moves both layers together and applies immediately (the plugin hot-reads switch.json; no restart). Project/session scope affects prefill only and REQUIRES an explicit target: the plugin page has no \"current session\", and the host will not guess (the kernel contract requires identities at wire boundaries to be explicit).",
    };

    const identity = (value) => value;
    const wireCodec = (typeSymbol) => ({
      mode: "strict",
      typeSymbol,
      schema: { parse: identity },
      create: () => ({ parse: identity }),
    });
    const jsonParameter = (name, typeSymbol) => ({
      name,
      wire: name,
      source: "json",
      codec: wireCodec(typeSymbol),
    });
    const CONTRIBUTION = {
      package: PACKAGE_NAME,
      descriptors: [
        {
          id: PACKAGE_NAME + "#pjPrefill/getState",
          service: NS,
          namespace: NS,
          method: "getState",
          invocation: { kind: "direct" },
          parameters: [],
          result: wireCodec(PACKAGE_NAME + "#PjPrefillState"),
        },
        {
          id: PACKAGE_NAME + "#pjPrefill/setEnabled",
          service: NS,
          namespace: NS,
          method: "setEnabled",
          invocation: { kind: "direct" },
          parameters: [jsonParameter("request", PACKAGE_NAME + "#SetEnabledRequest")],
          result: wireCodec(PACKAGE_NAME + "#PjPrefillState"),
        },
        {
          id: PACKAGE_NAME + "#pjPrefill/setScope",
          service: NS,
          namespace: NS,
          method: "setScope",
          invocation: { kind: "direct" },
          parameters: [jsonParameter("request", PACKAGE_NAME + "#SetScopeRequest")],
          result: wireCodec(PACKAGE_NAME + "#PjPrefillState"),
        },
      ],
    };

    const row = (label, value, key) =>
      h("div", { key, style: { display: "flex", gap: 8, fontSize: 12, lineHeight: "18px" } }, [
        h("span", { key: "l", style: { opacity: 0.7, minWidth: 150 } }, label),
        h("span", { key: "v" }, value),
      ]);

    function PrefillCard({ view, api, t }) {
      const [state, setState] = useState({ ready: false, busy: false, error: "", data: undefined, boost: undefined });
      // 「本项目 / 本会话」两个目标输入框。
      // 为什么必须有：这两个动作经 remote 进宿主，而宿主侧用的是
      //   agents.currentInitiator()  （AsyncLocalStorage）
      // 插件页**没有会话上下文**，它必然返回 undefined，于是 setSwitch 抛
      //   "project 作用域需要 target（项目路径），或一个带 cwd 的会话上下文"
      // 旧代码把 target 一律留空 ⇒ 这四个按钮从来没成功过。内核契约也明写：跨 wire
      // 边界的身份必须显式传递（"subjects and owners remain explicit"），宿主不会猜。
      const [projTarget, setProjTarget] = useState("");
      const [sessTarget, setSessTarget] = useState("");

      // 一次拉两层状态：本插件（含三层解析）与 boost（可能未挂载 → undefined）
      const refresh = (active) => {
        Promise.all([
          api.getState().catch((e) => { throw e; }),
          api.getBoostState().catch(() => undefined),
        ])
          .then(([data, boost]) => {
            if (active === undefined || active) {
              // busy 时跳过：操作还没落盘，拿旧值覆盖只会让界面闪回一次
              setState((c) => (c.busy ? c : { ready: true, busy: false, error: "", data, boost }));
            }
          })
          .catch((error) => {
            if (active === undefined || active) {
              const message = error instanceof Error ? error.message : String(error);
              setState((c) => (c.busy ? c : { ready: true, busy: false, error: message, data: undefined, boost: undefined }));
            }
          });
      };

      /*
       * 2026-10-21 修：原先只在挂载时拉一次 ⇒ 在会话头部按了破甲按钮后，卡片仍显示旧状态
       * （用户看到"头部关了、插件里还写着开"）。现在聚焦/可见性变化 + 3 秒轮询都刷新。
       */
      useEffect(() => {
        let active = true;
        refresh(active);
        const timer = setInterval(() => refresh(active), 3000);
        const onWake = () => refresh(active);
        window.addEventListener("focus", onWake);
        document.addEventListener("visibilitychange", onWake);
        return () => {
          active = false;
          clearInterval(timer);
          window.removeEventListener("focus", onWake);
          document.removeEventListener("visibilitychange", onWake);
        };
      }, [api]);

      const run = (fn) => {
        setState((c) => ({ ...c, busy: true, error: "" }));
        Promise.resolve()
          .then(fn)
          .then(() => { refresh(undefined); })
          .catch((error) => setState((c) => ({ ...c, busy: false, error: error instanceof Error ? error.message : String(error) })));
      };

      const data = state.data;
      const boost = state.boost;
      // 2026-10-21：prefill 一律显示**有效值**（三层 ∧ 应急闸），与头部按钮同一口径；
      // 旧宿主没有 effective 字段时回退到三层值。
      const prefillOn = data ? (data.effective ?? data.enabled) === true : false;
      const statusText = !data
        ? (state.error ? t("connectFail") : t("switching"))
        : t("prefill") + "：" + (prefillOn ? t("on") : t("off")) + " · " + t("boost") + "：" + (boost ? (boost.enabled ? t("on") : t("off")) : t("unknown"));

      if (view === "summary") {
        return h("span", { style: { opacity: 0.8 } }, statusText);
      }

      const btn = (key, label, onClick, primary, disabled) => {
        const props = {
          key,
          type: "button",
          onClick,
          disabled: disabled === true || !state.ready || state.busy,
          title: state.error || label,
        };
        if (Button) {
          props.size = "sm";
          props.variant = primary ? "primary" : "outline";
        }
        return h(ButtonTag, props, label);
      };

      const normKey = (p) => (typeof p === "string" ? p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : null);
      const projOverride = data ? data.projects.find((p) => p.key === normKey(data.project)) : undefined;
      const sessOverride = data ? data.sessions.find((s) => s.key === data.session) : undefined;
      const ov = (o) => (o ? (o.enabled ? t("on") : t("off")) : t("none"));
      // 把**全部**覆盖列出来。只看"当前项"是不够的：插件页没有会话上下文，data.project 恒为
      // null，于是设完一个项目覆盖后界面仍显示"无覆盖" —— 用户会以为没生效（2026-10-14 的连带坑）。
      const fmtOverrides = (list) => (list.length === 0
        ? t("none")
        : list.map((p) => p.key + "=" + (p.enabled ? t("on") : t("off"))).join("  ·  "));

      // 目标框默认值 = 宿主解析出的"当前会话"值（只有在会话上下文里调用时才非空，
      // 插件页里是空的）。只做一次性填充，之后不覆盖用户已输入的内容。
      useEffect(() => {
        if (!data) return;
        setProjTarget((prev) => (prev ? prev : (typeof data.project === "string" ? data.project : "")));
        setSessTarget((prev) => (prev ? prev : (typeof data.session === "string" ? data.session : "")));
      }, [data]);

      // 没目标就在本地拒绝：不要让宿主抛一句用户看不懂、也无从下手的话回来。
      const setScope = (scope, value) => {
        const typed = (scope === "project" ? projTarget : sessTarget).trim();
        if (!typed) {
          setState((c) => ({ ...c, busy: false, error: t("needTarget") }));
          return;
        }
        run(() => api.setScope({ scope, value, target: typed }));
      };

      const children = [
        h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } }, [
          h("strong", { key: "s" }, t("title")),
          h("span", { key: "st", style: { fontSize: 12, opacity: 0.85 } }, statusText),
        ]),
        h("div", { key: "btns", style: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 } }, [
          /*
           * 2026-10-21 修（用户报"两处显示正好相反"）：原本文案是**下一步动作**
           *   —— global 为开时按钮写「总开关（全局）：关」；
           *   而会话头部按钮写的是**当前状态**「破甲：开」。
           * 同一个 global 值，一个说"关"一个说"开"，读起来就是"两边反着"。
           * 现在统一成「当前值 → 点后值」，两头语义一致，也和下面的状态行不冲突。
           */
          btn("m", t("globalSwitch") + (data ? "：" + (data.global ? t("on") : t("off"))
            + " → " + (data.global ? t("off") : t("on")) : ""),
            () => run(() => api.setMaster(!(data && data.global))), true),
        ]),
        // 每个 scope 一行：目标输入框 + 该 scope 的关/开按钮。
        // target 由输入框显式提供 ⇒ 不再依赖宿主猜"当前会话"。
        h("div", { key: "proj", style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 6 } }, [
          h("span", { key: "l", style: { fontSize: 12, opacity: 0.7, minWidth: 150 } }, t("projectTarget")),
          h("input", {
            key: "i",
            type: "text",
            value: projTarget,
            placeholder: t("projectPlaceholder"),
            onChange: (e) => setProjTarget(e && e.target ? e.target.value : ""),
            style: { flex: 1, minWidth: 200, fontSize: 12, padding: "2px 6px" },
          }),
          btn("p1", t("projOff"), () => setScope("project", false)),
          btn("p2", t("projOn"), () => setScope("project", true)),
        ]),
        h("div", { key: "sess", style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 } }, [
          h("span", { key: "l", style: { fontSize: 12, opacity: 0.7, minWidth: 150 } }, t("sessionTarget")),
          h("input", {
            key: "i",
            type: "text",
            value: sessTarget,
            placeholder: t("sessionPlaceholder"),
            onChange: (e) => setSessTarget(e && e.target ? e.target.value : ""),
            style: { flex: 1, minWidth: 200, fontSize: 12, padding: "2px 6px" },
          }),
          btn("s1", t("sessOff"), () => setScope("session", false)),
          btn("s2", t("sessOn"), () => setScope("session", true)),
        ]),
      ];

      if (data) {
        children.push(h("div", { key: "info", style: { display: "grid", gap: 2, marginBottom: 8 } }, [
          row(t("globalSwitch"), data.global ? t("on") : t("off"), "r1"),
          row(t("prefill"), (prefillOn ? t("on") : t("off")) + "（" + t("override") + "：" + data.decidedBy + "）", "r2"),
          // 单独一行：三层值都开、注入却停了，唯一可能是这道闸被关（isEnabled 每次注入都读它）
          row(t("gate"), data.gateEnabled === false ? t("off") : t("on"), "r2b"),
          row(t("boost"), (boost ? (boost.enabled ? t("on") : t("off")) : t("unknown")) + "  " + (boost ? "" : t("boostUnavailable")), "r3"),
          row(t("project"), (data.project ?? "-") + "  ·  " + ov(projOverride), "r4"),
          row(t("session"), (data.session ?? "-") + "  ·  " + ov(sessOverride), "r5"),
          row(t("projectOverrides"), fmtOverrides(data.projects), "r6"),
          row(t("sessionOverrides"), fmtOverrides(data.sessions), "r7"),
        ]));
      }
      if (state.error) {
        children.push(h("div", { key: "err", style: { fontSize: 12, color: "#c0392b" } }, t("connectFail") + "：" + state.error));
      }
      children.push(h("div", { key: "hint", style: { fontSize: 12, opacity: 0.7 } }, t("hint")));
      return h("div", null, children);
    }

    const inject = ["slots", "locale", "remote"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "pj-prefill: dictionaries");
      const mount = ctx.remote.$mount(CONTRIBUTION);

      const call = async (namespace, method, request) => {
        await mount;
        const remote = ctx.get("remote." + namespace);
        if (remote === undefined) throw new Error(namespace + " remote unavailable");
        const result = request === undefined ? await remote[method]() : await remote[method](request);
        if (!result.ok) throw new Error((result.error && result.error.message) || method + " failed");
        return result.value;
      };

      const api = {
        getState: () => call(NS, "getState"),
        setEnabled: (request) => call(NS, "setEnabled", request),
        setScope: (request) => call(NS, "setScope", request),
        // boost 层：同一个 remote 由 pj-toggle 提供；未挂载时返回 undefined（卡片显示"未知"）
        getBoostState: () => call(BOOST_NS, "getState"),
        setBoostEnabled: (request) => call(BOOST_NS, "setEnabled", request),
        /** 总开关 = 同时写两层（写侧联动，谁按都一起动） */
        setMaster: async (enabled) => {
          const prefill = await call(NS, "setEnabled", { enabled });
          try {
            await call(BOOST_NS, "setEnabled", { enabled });
          } catch (error) {
            console.warn("[pj-prefill] boost 层切换失败（prefill 已切换）：" + String((error && error.message) || error));
          }
          return prefill;
        },
      };

      const t = ctx.locale.bind(NS);
      ctx.slots.inject("plugins.item", () => ctx.slots.register({
        name: "plugins.item",
        id: "pj-prefill",
        order: 60,
        label: () => t("title"),
        locale: NS,
        inject: () => ({ api, t }),
      }, PrefillCard));
      console.log("[pj-prefill] 客户端已注册到插件页卡片（plugins.item，id=pj-prefill）");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
