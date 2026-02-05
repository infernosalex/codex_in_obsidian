import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type CodexChatPlugin from "../main";
import type { ChatMessage, CodexItem, CodexThreadEvent } from "../codex-service";

export const VIEW_TYPE_CODEX_CHAT = "codex-chat-view";

/**
 * Maximum number of messages to persist across reloads.
 */
const MAX_PERSISTED_MESSAGES = 50;

export class CodexChatView extends ItemView {
	plugin: CodexChatPlugin;

	private messagesEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private cancelBtn: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;
	private contextBadgeEl: HTMLElement | null = null;
	private authIndicatorEl: HTMLElement | null = null;

	private messages: ChatMessage[] = [];
	private currentStreamEl: HTMLElement | null = null;
	private currentStreamText = "";
	private isGenerating = false;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CodexChatPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CODEX_CHAT;
	}

	getDisplayText(): string {
		return "Codex chat";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen() {
		const container = this.contentEl;
		container.empty();
		container.addClass("codex-chat-container");

		// Header
		const header = container.createDiv({ cls: "codex-chat-header" });
		const headerLeft = header.createDiv({ cls: "codex-chat-header-left" });
		headerLeft.createEl("h4", { text: "Codex chat" });

		// Auth status indicator (clickable dot)
		this.authIndicatorEl = headerLeft.createEl("span", {
			cls: "codex-auth-indicator",
			attr: { "aria-label": "Auth status" },
		});
		this.authIndicatorEl.addEventListener("click", () => {
			void this.handleAuthIndicatorClick();
		});
		void this.updateAuthIndicator();

		const headerRight = header.createDiv({ cls: "codex-chat-header-right" });

		this.contextBadgeEl = headerRight.createEl("span", {
			cls: "codex-context-badge",
		});
		this.updateContextBadge();

		// New conversation button
		const newChatBtn = headerRight.createEl("button", {
			cls: "codex-new-chat-btn clickable-icon",
			attr: { "aria-label": "New conversation" },
		});
		setIcon(newChatBtn, "plus");
		newChatBtn.addEventListener("click", () => {
			this.clearConversation();
		});

		// Status bar
		this.statusEl = container.createDiv({ cls: "codex-chat-status codex-hidden" });

		// Messages container
		this.messagesEl = container.createDiv({ cls: "codex-chat-messages" });

		// Restore persisted messages or show welcome
		await this.restoreMessages();
		if (this.messages.length === 0) {
			this.renderWelcome();
		}

		// Input area
		const inputArea = container.createDiv({ cls: "codex-chat-input-area" });

		this.inputEl = inputArea.createEl("textarea", {
			cls: "codex-chat-input",
			attr: {
				placeholder: "Ask Codex anything... (Ctrl+Enter to send)",
				rows: "3",
			},
		});

		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				void this.handleSend();
			}
		});

		const btnRow = inputArea.createDiv({ cls: "codex-chat-btn-row" });

		this.cancelBtn = btnRow.createEl("button", {
			text: "Cancel",
			cls: "codex-chat-cancel-btn codex-hidden",
		});
		this.cancelBtn.addEventListener("click", () => {
			this.handleCancel();
		});

		this.sendBtn = btnRow.createEl("button", {
			text: "Send",
			cls: "codex-chat-send-btn",
		});
		this.sendBtn.addEventListener("click", () => {
			void this.handleSend();
		});

		// Listen for active leaf changes to update context badge
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.updateContextBadge();
			})
		);
	}

	async onClose() {
		this.plugin.codexService.cancel();
		await this.persistMessages();
	}

	// ─── Public API ───

	/**
	 * Send a message programmatically (e.g. from "Send Selection" command).
	 */
	async sendUserMessage(text: string) {
		if (this.inputEl) {
			this.inputEl.value = text;
		}
		await this.handleSend();
	}

	/**
	 * Get the last assistant response text.
	 */
	getLastResponse(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (this.messages[i]?.role === "assistant") {
				return this.messages[i]?.content ?? "";
			}
		}
		return "";
	}

	/**
	 * Focus the chat input textarea.
	 */
	focusInput() {
		this.inputEl?.focus();
	}

	/**
	 * Start a new conversation (clears messages, shows welcome).
	 */
	startNewConversation() {
		this.clearConversation();
	}

	// ─── Internal ───

	/**
	 * Build a conversation-memory preamble from prior messages.
	 * Respects the configurable memory depth and character budget.
	 */
	private buildConversationMemory(maxChars: number): string {
		if (this.messages.length === 0) return "";

		const memoryTurns = this.plugin.settings.memoryTurns;
		const recentMessages = this.messages.slice(-(memoryTurns * 2));
		if (recentMessages.length === 0) return "";

		const header = "Previous conversation:\n";
		let totalLength = header.length;
		const parts: string[] = [header];

		for (const msg of recentMessages) {
			const role = msg.role === "user" ? "User" : "Assistant";
			const perMsgLimit = Math.max(500, Math.floor((maxChars - totalLength) / 2));
			const content = msg.content.length > perMsgLimit
				? msg.content.slice(0, perMsgLimit) + "...(truncated)"
				: msg.content;
			const line = `${role}: ${content}\n`;
			if (totalLength + line.length > maxChars) break;
			parts.push(line);
			totalLength += line.length;
		}
		parts.push("\n");
		return parts.join("");
	}

	/**
	 * Persist messages to plugin data so they survive reloads.
	 */
	private async persistMessages() {
		try {
			const data = ((await this.plugin.loadData()) ?? {}) as Record<string, unknown>;
			// Keep only the most recent messages
			data.chatMessages = this.messages.slice(-MAX_PERSISTED_MESSAGES).map(
				(m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })
			);
			await this.plugin.saveData(data);
		} catch (err) {
			console.warn("Failed to persist chat messages:", err);
		}
	}

	/**
	 * Restore messages from plugin data.
	 */
	private async restoreMessages() {
		try {
			const data = (await this.plugin.loadData()) as Record<string, unknown> | null;
			if (data?.chatMessages && Array.isArray(data.chatMessages)) {
				this.messages = data.chatMessages as ChatMessage[];
				// Re-render all messages
				for (const msg of this.messages) {
					if (msg.role === "user") {
						this.renderUserMessage(msg.content);
					} else {
						const el = this.createAssistantBubble();
						void this.renderMarkdownInEl(el, msg.content);
					}
				}
			}
		} catch (err) {
			console.warn("Failed to restore chat messages:", err);
		}
	}

	/**
	 * Clear conversation and show welcome screen.
	 */
	private clearConversation() {
		if (this.isGenerating) {
			this.plugin.codexService.cancel();
			this.setGenerating(false);
			this.setStatus("");
		}
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		this.messages = [];
		this.currentStreamEl = null;
		this.currentStreamText = "";
		if (this.messagesEl) {
			this.messagesEl.empty();
		}
		this.renderWelcome();
		void this.persistMessages();
	}

	/**
	 * Update the auth status indicator.
	 */
	private async updateAuthIndicator() {
		if (!this.authIndicatorEl) return;
		const ok = await this.plugin.auth.isAuthenticated();
		this.authIndicatorEl.toggleClass("codex-auth-ok", ok);
		this.authIndicatorEl.toggleClass("codex-auth-missing", !ok);
		this.authIndicatorEl.setAttribute(
			"aria-label",
			ok ? "Signed in" : "Not signed in — click to sign in"
		);
	}

	private async handleAuthIndicatorClick() {
		const ok = await this.plugin.auth.isAuthenticated();
		if (!ok) {
			await this.plugin.auth.triggerLogin();
			void this.updateAuthIndicator();
		} else {
			new Notice("Already signed in to codex.");
		}
	}

	private renderWelcome() {
		if (!this.messagesEl) return;
		const welcome = this.messagesEl.createDiv({ cls: "codex-welcome" });
		welcome.createEl("h5", { text: "Welcome to codex chat" });
		welcome.createEl("p", {
			text: "Ask questions about your notes, get help writing, or explore ideas. Your current note is automatically included as context.",
		});
		welcome.createEl("p", {
			text: "Make sure the codex CLI is installed and you're signed in via the settings tab.",
			cls: "codex-welcome-hint",
		});
	}

	private async handleSend() {
		if (!this.inputEl || this.isGenerating) return;

		const userText = this.inputEl.value.trim();
		if (!userText) return;

		// Check auth before sending
		const authenticated = await this.plugin.ensureAuthenticated();
		if (!authenticated) return;

		this.inputEl.value = "";
		this.setGenerating(true);

		// Add user message
		const userMsg: ChatMessage = {
			role: "user",
			content: userText,
			timestamp: Date.now(),
		};
		this.messages.push(userMsg);
		this.renderUserMessage(userText);

		// Build full prompt with smart context budgeting
		let fullPrompt = "";
		const totalBudget = this.plugin.settings.maxContextLength;
		const ratio = this.plugin.settings.contextBudgetRatio;
		const vaultBudget = Math.floor(totalBudget * ratio);
		const memoryBudget = totalBudget - vaultBudget;

		// 1. Vault context (gets its share of the budget)
		try {
			const context = await this.plugin.vaultContext.buildContext(
				this.plugin.settings.contextMode,
				vaultBudget
			);
			if (context) {
				fullPrompt += context;
			}
		} catch (err) {
			console.warn("Failed to build vault context:", err);
		}

		// 2. Conversation memory (gets the remaining budget)
		const memory = this.buildConversationMemory(memoryBudget);
		if (memory) {
			fullPrompt += memory;
		}

		fullPrompt += "User request:\n" + userText;

		// Create streaming response element
		this.currentStreamText = "";
		this.currentStreamEl = this.createAssistantBubble();
		this.setStatus("Thinking...");

		try {
			await this.plugin.codexService.sendMessage(fullPrompt, {
				onEvent: (event: CodexThreadEvent) => {
					this.handleStreamEvent(event);
				},
				onTextChunk: (text: string) => {
					this.appendStreamText(text);
				},
				onComplete: (fullText: string) => {
					this.finalizeResponse(fullText);
				},
				onError: (error: string) => {
					this.handleStreamError(error);
				},
			});
		} catch (err) {
			if (!this.currentStreamText) {
				this.handleStreamError(
					err instanceof Error ? err.message : "Unknown error"
				);
			}
		}
	}

	private handleCancel() {
		this.plugin.codexService.cancel();
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		this.setGenerating(false);
		this.setStatus("");
		if (this.currentStreamEl && !this.currentStreamText) {
			this.currentStreamEl.remove();
			this.currentStreamEl = null;
		}
	}

	private handleStreamEvent(event: CodexThreadEvent) {
		switch (event.type) {
			case "item.started":
				if (event.item?.type === "reasoning") {
					this.setStatus("Reasoning...");
				} else if (event.item?.type === "command_execution") {
					this.setStatus(
						`Running: ${event.item.command?.slice(0, 60) ?? "command"}...`
					);
				} else if (event.item?.type === "file_change") {
					this.setStatus("Modifying files...");
				}
				break;
			case "item.completed":
				if (event.item?.type === "command_execution") {
					this.appendCommandOutput(event.item);
				}
				break;
		}
	}

	private appendStreamText(text: string) {
		this.currentStreamText += text;

		// Debounce markdown re-renders to avoid excessive work during fast streaming.
		// Plain text is shown immediately; full markdown render fires at most every 150ms.
		if (this.currentStreamEl) {
			// Immediate lightweight update: just set text so user sees progress
			this.currentStreamEl.setText(this.currentStreamText);
		}

		if (!this.renderTimer) {
			this.renderTimer = setTimeout(() => {
				this.renderTimer = null;
				if (this.currentStreamEl) {
					void this.renderMarkdownInEl(this.currentStreamEl, this.currentStreamText);
				}
			}, 150);
		}

		this.scrollToBottom();
	}

	private appendCommandOutput(item: CodexItem) {
		if (!this.messagesEl) return;

		const cmdEl = this.messagesEl.createDiv({ cls: "codex-command-output" });
		cmdEl.createEl("div", {
			cls: "codex-command-label",
			text: `$ ${item.command ?? "command"}`,
		});
		if (item.output) {
			cmdEl.createEl("pre", {
				cls: "codex-command-pre",
				text: item.output.slice(0, 2000),
			});
		}
		const exitText = item.exit_code === 0 ? "✓" : `✗ exit ${item.exit_code}`;
		cmdEl.createEl("span", {
			cls: `codex-command-exit ${item.exit_code === 0 ? "success" : "error"}`,
			text: exitText,
		});
		this.scrollToBottom();
	}

	private finalizeResponse(fullText: string) {
		// Clear debounced render timer
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}

		const text = fullText || this.currentStreamText;

		if (this.currentStreamEl && text) {
			void this.renderMarkdownInEl(this.currentStreamEl, text);
			// Add copy button to the assistant bubble
			this.addCopyButton(this.currentStreamEl, text);
		}

		const assistantMsg: ChatMessage = {
			role: "assistant",
			content: text,
			timestamp: Date.now(),
		};
		this.messages.push(assistantMsg);

		this.currentStreamEl = null;
		this.currentStreamText = "";
		this.setGenerating(false);
		this.setStatus("");
		this.scrollToBottom();
		void this.persistMessages();
	}

	private handleStreamError(error: string) {
		if (this.currentStreamEl) {
			const errContainer = this.currentStreamEl.createDiv({
				cls: "codex-error",
			});
			errContainer.createEl("span", { text: `Error: ${error}` });

			// Add retry button
			const retryBtn = errContainer.createEl("button", {
				text: "Retry",
				cls: "codex-retry-btn",
			});
			retryBtn.addEventListener("click", () => {
				// Remove the error bubble
				const parentMsg = this.currentStreamEl?.closest(".codex-msg");
				if (parentMsg) parentMsg.remove();
				// Remove the last user message from the array and re-send
				const lastUserMsg = this.findLastUserMessage();
				if (lastUserMsg) {
					// Remove the failed assistant attempt (not in messages[] yet)
					if (this.inputEl) {
						this.inputEl.value = lastUserMsg;
					}
					void this.handleSend();
				}
			});
		}

		this.setGenerating(false);
		this.setStatus("");
		this.currentStreamEl = null;
		this.currentStreamText = "";
		this.scrollToBottom();
	}

	private findLastUserMessage(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (this.messages[i]?.role === "user") {
				return this.messages[i]?.content ?? "";
			}
		}
		return "";
	}

	/**
	 * Add a copy-to-clipboard button on an assistant message bubble.
	 */
	private addCopyButton(contentEl: HTMLElement, text: string) {
		const bubbleEl = contentEl.closest(".codex-bubble-assistant");
		if (!bubbleEl) return;

		const copyBtn = bubbleEl.createEl("button", {
			cls: "codex-copy-btn clickable-icon",
			attr: { "aria-label": "Copy to clipboard" },
		});
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void navigator.clipboard.writeText(text).then(() => {
				new Notice("Copied to clipboard.");
				setIcon(copyBtn, "check");
				setTimeout(() => setIcon(copyBtn, "copy"), 2000);
			});
		});
	}

	private renderUserMessage(text: string) {
		if (!this.messagesEl) return;

		// Remove welcome message on first send
		const welcome = this.messagesEl.querySelector(".codex-welcome");
		if (welcome) welcome.remove();

		const msgEl = this.messagesEl.createDiv({ cls: "codex-msg codex-msg-user" });
		const bubble = msgEl.createDiv({ cls: "codex-bubble codex-bubble-user" });
		bubble.setText(text);
		this.scrollToBottom();
	}

	private createAssistantBubble(): HTMLElement {
		if (!this.messagesEl) {
			// Fallback — should never happen
			return document.createElement("div");
		}
		const msgEl = this.messagesEl.createDiv({ cls: "codex-msg codex-msg-assistant" });
		const bubble = msgEl.createDiv({ cls: "codex-bubble codex-bubble-assistant" });
		const content = bubble.createDiv({ cls: "codex-bubble-content" });
		this.scrollToBottom();
		return content;
	}

	private async renderMarkdownInEl(el: HTMLElement, markdown: string) {
		el.empty();
		await MarkdownRenderer.render(
			this.app,
			markdown,
			el,
			"",
			this
		);
	}

	private setGenerating(generating: boolean) {
		this.isGenerating = generating;
		if (this.sendBtn) {
			this.sendBtn.disabled = generating;
			this.sendBtn.setText(generating ? "..." : "Send");
		}
		if (this.cancelBtn) {
			this.cancelBtn.toggleClass("codex-hidden", !generating);
		}
		if (this.inputEl) {
			this.inputEl.disabled = generating;
		}
	}

	private setStatus(text: string) {
		if (!this.statusEl) return;
		if (text) {
			this.statusEl.setText(text);
			this.statusEl.removeClass("codex-hidden");
		} else {
			this.statusEl.addClass("codex-hidden");
		}
	}

	private updateContextBadge() {
		if (!this.contextBadgeEl) return;
		const mode = this.plugin.settings.contextMode;
		if (mode === "none") {
			this.contextBadgeEl.setText("");
			this.contextBadgeEl.addClass("codex-hidden");
		} else {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				const label =
					mode === "current-and-linked"
						? `📄 ${activeFile.basename} + links`
						: `📄 ${activeFile.basename}`;
				this.contextBadgeEl.setText(label);
				this.contextBadgeEl.removeClass("codex-hidden");
			} else {
				this.contextBadgeEl.setText("No active note");
				this.contextBadgeEl.removeClass("codex-hidden");
			}
		}
	}

	private scrollToBottom() {
		if (this.messagesEl) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}
}
