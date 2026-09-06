window.__ModuleLoader__.load({
	id: "dsh-context-enhancement",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/ContextEnhancementAction.tsx
		const EFFECTS = [
			{
				key: "taskStateBasic",
				label: "taskStateBasic",
				detail: "taskStateBasicDetail",
				countLabel: "evidenceSaved"
			},
			{
				key: "taskStatePrompt",
				label: "taskStatePrompt",
				detail: "taskStatePromptDetail",
				countLabel: "evidenceRead"
			},
			{
				key: "toolResultPruner",
				label: "toolResultPruner",
				detail: "toolResultPrunerDetail",
				countLabel: "evidenceGrouped"
			},
			{
				key: "compactionBasic",
				label: "compactionBasic",
				detail: "compactionBasicDetail",
				countLabel: "evidenceCompacted"
			}
		];
		const rootStyle = {
			position: "relative",
			display: "inline-flex",
			zIndex: 2147483e3
		};
		const triggerStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			border: "1px solid var(--dsw-border-subtle, #d9dce3)",
			borderRadius: 7,
			background: "var(--dsw-surface-primary, #fff)",
			color: "var(--dsw-text-secondary, #5f6368)",
			cursor: "pointer",
			font: "inherit",
			fontSize: 12,
			lineHeight: 1.25,
			padding: "6px 10px",
			whiteSpace: "nowrap"
		};
		const triggerIconStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 15,
			height: 15,
			color: "#16834f",
			fontSize: 13
		};
		const panelStyle = {
			position: "fixed",
			zIndex: 2147483001,
			width: "min(360px, calc(100vw - 24px))",
			maxHeight: "calc(100vh - 24px)",
			overflowY: "auto",
			padding: 14,
			border: "1px solid var(--dsw-border-subtle, #d9dce3)",
			borderRadius: 8,
			background: "var(--dsw-surface-primary, #fff)",
			boxShadow: "0 10px 28px rgb(0 0 0 / 14%)",
			color: "var(--dsw-text-primary, #1f2329)"
		};
		const headingStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 14,
			fontWeight: 600
		};
		const introStyle = {
			margin: "6px 0 8px",
			color: "var(--dsw-text-secondary, #6b7280)",
			fontSize: 12,
			lineHeight: 1.4
		};
		const rowStyle = {
			display: "grid",
			gridTemplateColumns: "10px minmax(0, 1fr) auto",
			gap: 8,
			alignItems: "start",
			padding: "10px 0",
			borderTop: "1px solid var(--dsw-border-subtle, #e8e9ed)"
		};
		const dotStyle = {
			width: 7,
			height: 7,
			marginTop: 5,
			borderRadius: "50%",
			background: "#20a464"
		};
		const detailStyle = {
			marginTop: 3,
			color: "var(--dsw-text-secondary, #6b7280)",
			fontSize: 12,
			lineHeight: 1.35
		};
		const statusStyle = {
			color: "#16834f",
			fontSize: 12,
			whiteSpace: "nowrap"
		};
		const countStyle = {
			marginTop: 4,
			color: "var(--dsw-text-secondary, #6b7280)",
			fontSize: 11,
			whiteSpace: "nowrap"
		};
		const closeStyle = {
			border: 0,
			background: "transparent",
			color: "var(--dsw-text-secondary, #6b7280)",
			cursor: "pointer",
			font: "inherit",
			fontSize: 16,
			lineHeight: 1,
			padding: 2
		};
		/** Render a compact, user-facing status action for contextual sessions. */
		function ContextEnhancementAction({ sessionId, useSessions, useProjection, t }) {
			const agentPreset = useSessions((state) => state.byId[sessionId]?.projectionValues?.agentPreset);
			const evidence = useProjection("contextEnhancement");
			const [open, setOpen] = (0, react.useState)(false);
			const [triggerActive, setTriggerActive] = (0, react.useState)(false);
			const [panelPosition, setPanelPosition] = (0, react.useState)({});
			const rootRef = (0, react.useRef)(null);
			const triggerRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const closeRef = (0, react.useRef)(null);
			const panelId = (0, react.useId)();
			const closePanel = () => {
				setOpen(false);
				requestAnimationFrame(() => triggerRef.current?.focus());
			};
			(0, react.useEffect)(() => {
				if (!open) return;
				const updatePanelPosition = () => {
					const trigger = triggerRef.current;
					if (trigger === null) return;
					const rect = trigger.getBoundingClientRect();
					const panelWidth = Math.min(360, window.innerWidth - 24);
					const left = Math.max(12, Math.min(window.innerWidth - panelWidth - 12, rect.right - panelWidth));
					const panelHeight = panelRef.current?.offsetHeight ?? 0;
					const below = rect.bottom + 8;
					const top = panelHeight > 0 && below + panelHeight > window.innerHeight - 12 ? Math.max(12, rect.top - panelHeight - 8) : below;
					setPanelPosition({
						left,
						top
					});
				};
				updatePanelPosition();
				requestAnimationFrame(() => {
					updatePanelPosition();
					closeRef.current?.focus();
				});
				window.addEventListener("resize", updatePanelPosition);
				window.addEventListener("scroll", updatePanelPosition, true);
				return () => {
					window.removeEventListener("resize", updatePanelPosition);
					window.removeEventListener("scroll", updatePanelPosition, true);
				};
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const close = (event) => {
					if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
				};
				const closeOnEscape = (event) => {
					if (event.key === "Escape") closePanel();
				};
				document.addEventListener("pointerdown", close);
				document.addEventListener("keydown", closeOnEscape);
				return () => {
					document.removeEventListener("pointerdown", close);
					document.removeEventListener("keydown", closeOnEscape);
				};
			}, [open]);
			if (agentPreset !== "contextual") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				style: rootStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					ref: triggerRef,
					type: "button",
					style: {
						...triggerStyle,
						...triggerActive || open ? {
							borderColor: "var(--dsw-border-strong, #b8bdc7)",
							background: "var(--dsw-surface-secondary, #f5f6f8)",
							color: "var(--dsw-text-primary, #1f2329)"
						} : {}
					},
					"aria-expanded": open,
					"aria-haspopup": "dialog",
					"aria-controls": panelId,
					"aria-label": t("trigger"),
					title: t("panelLabel"),
					onMouseEnter: () => setTriggerActive(true),
					onMouseLeave: () => setTriggerActive(false),
					onFocus: () => setTriggerActive(true),
					onBlur: () => setTriggerActive(false),
					onClick: () => {
						setOpen((value) => !value);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: triggerIconStyle,
						"aria-hidden": "true",
						children: "✦"
					}), t("trigger")]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					ref: panelRef,
					id: panelId,
					style: {
						...panelStyle,
						...panelPosition
					},
					role: "dialog",
					"aria-modal": "false",
					"aria-label": t("panelLabel"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: headingStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("panelLabel") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								ref: closeRef,
								type: "button",
								style: closeStyle,
								"aria-label": t("close"),
								onClick: closePanel,
								children: "×"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: introStyle,
							children: t("intro")
						}),
						EFFECTS.map((effect) => {
							const count = effect.key === "taskStateBasic" || effect.key === "taskStatePrompt" ? evidence?.taskStateRequests ?? 0 : evidence?.[effect.key] ?? 0;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: dotStyle,
										"aria-hidden": "true"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t(effect.label) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: detailStyle,
										children: t(effect.detail)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: { textAlign: "right" },
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: statusStyle,
											children: t("enabled")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: countStyle,
											children: count === 0 ? t("notTriggered") : t(effect.countLabel, { count })
										})]
									})
								]
							}, effect.label);
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								...detailStyle,
								paddingTop: 10
							},
							children: t("footer")
						})
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Context-enhancement header panel dictionaries. */
		const NS = "contextEnhancement";
		const zh = {
			trigger: "当前状态",
			panelLabel: "当前状态",
			intro: "以下能力正在为当前会话工作，次数表示已经实际生效的操作。",
			enabled: "已启用",
			evidenceSaved: "已保存 {count} 次",
			evidenceRead: "已读取 {count} 次",
			evidenceGrouped: "已归纳 {count} 组",
			evidenceCompacted: "已压缩 {count} 次",
			notTriggered: "尚未生效",
			close: "关闭",
			taskStateBasic: "保存会话摘要",
			taskStateBasicDetail: "自动提炼并保存当前会话中的重要信息",
			taskStatePrompt: "读取会话摘要",
			taskStatePromptDetail: "在后续请求中继续参考已保存的会话信息",
			toolResultPruner: "归纳工具操作",
			toolResultPrunerDetail: "将一组连续的工具调用和结果压缩为结果摘要，减少冗长工具输出",
			compactionBasic: "压缩较早的对话内容",
			compactionBasicDetail: "将较早的对话提炼成摘要，减少上下文占用",
			footer: "详细记录会出现在当前会话的轨迹中。"
		};
		const en = {
			trigger: "Current status",
			panelLabel: "Current status",
			intro: "These capabilities are working for this session. Counts show completed actions.",
			enabled: "Enabled",
			evidenceSaved: "Saved {count} times",
			evidenceRead: "Read {count} times",
			evidenceGrouped: "Summarized {count} groups",
			evidenceCompacted: "Compressed {count} times",
			notTriggered: "Not active yet",
			close: "Close",
			taskStateBasic: "Save session summary",
			taskStateBasicDetail: "Extract and save important information from this session",
			taskStatePrompt: "Read session summary",
			taskStatePromptDetail: "Use the saved session information in later requests",
			toolResultPruner: "Summarize tool operations",
			toolResultPrunerDetail: "Compress a group of consecutive tool calls and results into a result summary",
			compactionBasic: "Compress earlier conversation",
			compactionBasicDetail: "Extract earlier conversation into a summary to reduce context usage",
			footer: "Detailed records appear in the trajectory for this session."
		};
		//#endregion
		//#region src/client/index.ts
		const inject = ["locale", "slots"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "context-enhancement: dictionaries");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "context-enhancement",
				order: 10,
				locale: NS
			}, ContextEnhancementAction));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map