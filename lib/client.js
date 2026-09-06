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
				detail: "taskStateBasicDetail"
			},
			{
				key: "taskStatePrompt",
				label: "taskStatePrompt",
				detail: "taskStatePromptDetail"
			},
			{
				key: "toolResultPruner",
				label: "toolResultPruner",
				detail: "toolResultPrunerDetail"
			},
			{
				key: "compactionBasic",
				label: "compactionBasic",
				detail: "compactionBasicDetail"
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
			const [panelPosition, setPanelPosition] = (0, react.useState)({});
			const rootRef = (0, react.useRef)(null);
			const triggerRef = (0, react.useRef)(null);
			const panelId = (0, react.useId)();
			(0, react.useEffect)(() => {
				if (!open) return;
				const updatePanelPosition = () => {
					const trigger = triggerRef.current;
					if (trigger === null) return;
					const rect = trigger.getBoundingClientRect();
					const panelWidth = Math.min(360, window.innerWidth - 24);
					const left = Math.max(12, Math.min(window.innerWidth - panelWidth - 12, rect.right - panelWidth));
					const top = rect.bottom + 8;
					setPanelPosition({
						left,
						top
					});
				};
				updatePanelPosition();
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
					if (event.key === "Escape") setOpen(false);
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
					style: triggerStyle,
					"aria-expanded": open,
					"aria-controls": panelId,
					"aria-label": t("trigger"),
					title: t("panelLabel"),
					onClick: () => {
						setOpen((value) => !value);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: triggerIconStyle,
						"aria-hidden": "true",
						children: "✦"
					}), t("trigger")]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					id: panelId,
					style: {
						...panelStyle,
						...panelPosition
					},
					role: "dialog",
					"aria-label": t("panelLabel"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: headingStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("panelLabel") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: closeStyle,
								"aria-label": t("close"),
								onClick: () => setOpen(false),
								children: "×"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: introStyle,
							children: t("intro")
						}),
						EFFECTS.map((effect) => {
							const count = evidence?.[effect.key] ?? 0;
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
											children: count === 0 ? t("notTriggered") : t("evidence", { count })
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
			trigger: "增强功能",
			panelLabel: "当前会话的增强功能",
			intro: "功能会根据当前会话自动工作，详细记录可在轨迹中查看。",
			enabled: "已启用",
			evidence: "本会话触发 {count} 次",
			notTriggered: "本会话尚未触发",
			close: "关闭",
			taskStateBasic: "任务进度记忆",
			taskStateBasicDetail: "自动保存任务进度",
			taskStatePrompt: "请求上下文同步",
			taskStatePromptDetail: "自动同步当前任务状态",
			toolResultPruner: "工具结果整理",
			toolResultPrunerDetail: "减少重复和冗余内容",
			compactionBasic: "长对话整理",
			compactionBasicDetail: "按需压缩历史上下文",
			footer: "详细记录会出现在当前会话的轨迹中。"
		};
		const en = {
			trigger: "Enhanced features",
			panelLabel: "Enhanced features for this session",
			intro: "These features work automatically for the current session. Detailed records are available in the trajectory.",
			enabled: "Enabled",
			evidence: "Triggered {count} times in this session",
			notTriggered: "Not triggered in this session",
			close: "Close",
			taskStateBasic: "Task progress memory",
			taskStateBasicDetail: "Automatically saves task progress",
			taskStatePrompt: "Request context sync",
			taskStatePromptDetail: "Automatically syncs the current task state",
			toolResultPruner: "Tool-result cleanup",
			toolResultPrunerDetail: "Reduces repeated and unnecessary content",
			compactionBasic: "Long-conversation cleanup",
			compactionBasicDetail: "Compresses conversation history when needed",
			footer: "Detailed records appear in the current session trajectory."
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