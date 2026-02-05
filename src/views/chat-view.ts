import { ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type CodexChatPlugin from "../main";
import type { ChatMessage, CodexItem, CodexThreadEvent } from "../codex-service";
import type { PromptTemplate } from "../settings";

export const VIEW_TYPE_CODEX_CHAT = "codex-chat-view";

export class CodexChatView extends ItemView {
	plugin: CodexChatPlugin;

	private messagesEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private cancelBtn: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;
	private contextBadgeEl: HTMLElement | null = null;
	private authIndicatorEl: HTMLElement | null = null;
	private suggestionsEl: HTMLElement | null = null;
	private sessionLabelEl: HTMLElement | null = null;

	private messages: ChatMessage[] = [];
	private currentStreamEl: HTMLElement | null = null;
	private currentStreamText = "";
	private isGenerating = false;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private atMentionStart = -1;
	private selectedSuggestionIdx = 0;

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

		// Session switcher dropdown
		this.sessionLabelEl = headerLeft.createEl("span", {
			cls: "codex-session-label clickable-icon",
			attr: { "aria-label": "Switch conversation" },
		});
		this.updateSessionLabel();
		this.sessionLabelEl.addEventListener("click", (e) => {
			this.showSessionMenu(e);
		});

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

		// Export button
		const exportBtn = headerRight.createEl("button", {
			cls: "codex-export-btn clickable-icon",
			attr: { "aria-label": "Export conversation" },
		});
		setIcon(exportBtn, "file-down");
		exportBtn.addEventListener("click", () => {
			void this.exportToNote();
		});

		// New conversation button
		const newChatBtn = headerRight.createEl("button", {
			cls: "codex-new-chat-btn clickable-icon",
			attr: { "aria-label": "New conversation" },
		});
		setIcon(newChatBtn, "plus");
		newChatBtn.addEventListener("click", () => {
			this.startNewSession();
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

		// @file autocomplete suggestions (hidden by default)
		this.suggestionsEl = inputArea.createDiv({
			cls: "codex-file-suggestions codex-hidden",
		});

		this.inputEl = inputArea.createEl("textarea", {
			cls: "codex-chat-input",
			attr: {
				placeholder: "Ask Codex anything... (Ctrl+Enter to send, @ for files, / for commands)",
				rows: "3",
			},
		});

		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			// Handle suggestion navigation
			if (this.suggestionsEl && !this.suggestionsEl.hasClass("codex-hidden")) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					this.navigateSuggestions(1);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					this.navigateSuggestions(-1);
					return;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					e.preventDefault();
					this.selectSuggestion();
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					this.hideFileSuggestions();
					return;
				}
			}

			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				void this.handleSend();
			}
		});

		this.inputEl.addEventListener("input", () => {
			this.handleInputForAtMention();
		});

		const btnRow = inputArea.createDiv({ cls: "codex-chat-btn-row" });

		// Template picker button
		const templateBtn = btnRow.createEl("button", {
			cls: "codex-template-btn clickable-icon",
			attr: { "aria-label": "Insert template" },
		});
		setIcon(templateBtn, "layout-template");
		templateBtn.addEventListener("click", (e) => {
			this.showTemplatePicker(e);
		});

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
	 * Start a new conversation (creates a new session).
	 */
	startNewConversation() {
		this.startNewSession();
	}

	/**
	 * Export the current conversation to a vault note.
	 */
	async exportToNote(): Promise<void> {
		if (this.messages.length === 0) {
			new Notice("No messages to export.");
			return;
		}

		const session = this.plugin.sessionManager.getActiveSession();
		const sessionName = session?.name ?? "Codex chat";
		const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
		const fileName = `${sessionName} ${timestamp}.md`;

		const lines: string[] = [
			`# ${sessionName}`,
			``,
			`*Exported on ${new Date().toLocaleString()}*`,
			``,
		];

		for (const msg of this.messages) {
			if (msg.role === "user") {
				lines.push(`## User`, ``, msg.content, ``);
			} else {
				lines.push(`## Assistant`, ``, msg.content, ``);
			}
		}

		try {
			await this.app.vault.create(fileName, lines.join("\n"));
			new Notice(`Chat exported to "${fileName}".`);
		} catch (err) {
			new Notice("Failed to export chat.");
			console.error("Export error:", err);
		}
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
	 * Persist messages via the session manager.
	 */
	private async persistMessages() {
		try {
			this.plugin.sessionManager.updateMessages(this.messages);
		} catch (err) {
			console.warn("Failed to persist chat messages:", err);
		}
	}

	/**
	 * Restore messages from the active session.
	 */
	private async restoreMessages() {
		try {
			const session = this.plugin.sessionManager.getActiveSession();
			if (session && session.messages.length > 0) {
				this.messages = [...session.messages];
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
	 * Clear conversation in the current session.
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

		// Handle slash commands
		if (this.handleSlashCommand(userText)) {
			this.inputEl.value = "";
			this.hideFileSuggestions();
			return;
		}

		// Check auth before sending
		const authenticated = await this.plugin.ensureAuthenticated();
		if (!authenticated) return;

		this.inputEl.value = "";
		this.hideFileSuggestions();
		this.setGenerating(true);

		// Resolve @file mentions
		const { cleanedText, files: mentionedFiles } =
			this.plugin.vaultContext.resolveAtMentions(userText);

		// Add user message (show original text with @mentions)
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

		// 1. @file referenced content (from the vault budget)
		try {
			const atFileCtx = await this.plugin.vaultContext.buildAtFileContext(
				mentionedFiles,
				Math.floor(vaultBudget * 0.5)
			);
			if (atFileCtx) {
				fullPrompt += atFileCtx;
			}
		} catch (err) {
			console.warn("Failed to resolve @file references:", err);
		}

		// 2. Vault context (remaining vault budget)
		try {
			const remainingVaultBudget = vaultBudget - fullPrompt.length;
			if (remainingVaultBudget > 500) {
				const context = await this.plugin.vaultContext.buildContext(
					this.plugin.settings.contextMode,
					remainingVaultBudget
				);
				if (context) {
					fullPrompt += context;
				}
			}
		} catch (err) {
			console.warn("Failed to build vault context:", err);
		}

		// 3. Conversation memory (gets the remaining budget)
		const memory = this.buildConversationMemory(memoryBudget);
		if (memory) {
			fullPrompt += memory;
		}

		fullPrompt += "User request:\n" + cleanedText;

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

	// ─── Session management ───

	private startNewSession() {
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
		this.plugin.sessionManager.createSession();
		this.updateSessionLabel();
		this.renderWelcome();
	}

	private switchSession(id: string) {
		if (this.isGenerating) {
			this.plugin.codexService.cancel();
			this.setGenerating(false);
			this.setStatus("");
		}
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		// Save current messages before switching
		this.plugin.sessionManager.updateMessages(this.messages);
		const session = this.plugin.sessionManager.switchTo(id);
		if (!session) return;

		this.messages = [...session.messages];
		this.currentStreamEl = null;
		this.currentStreamText = "";
		if (this.messagesEl) {
			this.messagesEl.empty();
		}
		if (this.messages.length === 0) {
			this.renderWelcome();
		} else {
			for (const msg of this.messages) {
				if (msg.role === "user") {
					this.renderUserMessage(msg.content);
				} else {
					const el = this.createAssistantBubble();
					void this.renderMarkdownInEl(el, msg.content);
				}
			}
		}
		this.updateSessionLabel();
	}

	private updateSessionLabel() {
		if (!this.sessionLabelEl) return;
		const session = this.plugin.sessionManager.getActiveSession();
		const name = session?.name ?? "Codex chat";
		this.sessionLabelEl.setText(`▾ ${name}`);
	}

	private showSessionMenu(e: MouseEvent) {
		const menu = new Menu();
		const sessions = this.plugin.sessionManager.getSessions();
		const activeId = this.plugin.sessionManager.getActiveSessionId();

		for (const session of sessions) {
			menu.addItem((item) => {
				const label =
					session.id === activeId
						? `● ${session.name}`
						: `  ${session.name}`;
				item.setTitle(label);
				item.onClick(() => {
					this.switchSession(session.id);
				});
			});
		}

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle("New conversation");
			item.setIcon("plus");
			item.onClick(() => {
				this.startNewSession();
			});
		});

		menu.addItem((item) => {
			item.setTitle("Rename current");
			item.setIcon("pencil");
			item.onClick(() => {
				this.renameCurrentSession();
			});
		});

		if (sessions.length > 1) {
			menu.addItem((item) => {
				item.setTitle("Delete current");
				item.setIcon("trash");
				item.onClick(() => {
					const id = this.plugin.sessionManager.getActiveSessionId();
					if (id) {
						this.plugin.sessionManager.deleteSession(id);
						const next = this.plugin.sessionManager.getActiveSession();
						if (next) {
							this.switchSession(next.id);
						}
					}
				});
			});
		}

		menu.showAtMouseEvent(e);
	}

	private renameCurrentSession() {
		const session = this.plugin.sessionManager.getActiveSession();
		if (!session) return;

		const overlay = document.createElement("div");
		overlay.addClass("codex-rename-overlay");

		const box = document.createElement("div");
		box.addClass("codex-rename-box");

		const label = document.createElement("div");
		label.textContent = "Rename conversation";
		label.addClass("codex-rename-label");
		box.appendChild(label);

		const input = document.createElement("input");
		input.type = "text";
		input.value = session.name;
		input.addClass("codex-rename-input");
		box.appendChild(input);

		overlay.appendChild(box);
		document.body.appendChild(overlay);
		input.focus();
		input.select();

		const finish = (save: boolean) => {
			if (save && input.value.trim()) {
				this.plugin.sessionManager.rename(
					session.id,
					input.value.trim()
				);
				this.updateSessionLabel();
			}
			overlay.remove();
		};

		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") finish(true);
			if (e.key === "Escape") finish(false);
		});
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) finish(false);
		});
	}

	// ─── @file autocomplete ───

	private handleInputForAtMention() {
		if (!this.inputEl) return;

		const text = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart ?? 0;
		const beforeCursor = text.slice(0, cursorPos);

		// Match @ at the end of text before cursor
		const atMatch = beforeCursor.match(/@([^\s@]*)$/);

		if (atMatch) {
			this.atMentionStart = cursorPos - atMatch[0].length;
			const partial = atMatch[1] ?? "";
			this.showFileSuggestions(partial);
		} else {
			this.hideFileSuggestions();
		}
	}

	private showFileSuggestions(partial: string) {
		if (!this.suggestionsEl) return;

		const files = this.plugin.vaultContext.getFileSuggestions(partial, 8);
		if (files.length === 0) {
			this.hideFileSuggestions();
			return;
		}

		this.suggestionsEl.empty();
		this.selectedSuggestionIdx = 0;

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (!file) continue;
			const item = this.suggestionsEl.createDiv({
				cls: `codex-suggestion-item${i === 0 ? " codex-suggestion-active" : ""}`,
			});
			item.createEl("span", {
				cls: "codex-suggestion-name",
				text: file.basename,
			});
			if (file.parent?.path && file.parent.path !== "/") {
				item.createEl("span", {
					cls: "codex-suggestion-path",
					text: file.parent.path,
				});
			}
			item.addEventListener("click", () => {
				this.insertFileMention(file);
			});
		}

		this.suggestionsEl.removeClass("codex-hidden");
	}

	private hideFileSuggestions() {
		if (this.suggestionsEl) {
			this.suggestionsEl.addClass("codex-hidden");
		}
		this.atMentionStart = -1;
	}

	private navigateSuggestions(direction: number) {
		if (!this.suggestionsEl) return;
		const items = this.suggestionsEl.querySelectorAll(".codex-suggestion-item");
		if (items.length === 0) return;

		items[this.selectedSuggestionIdx]?.removeClass("codex-suggestion-active");
		this.selectedSuggestionIdx =
			(this.selectedSuggestionIdx + direction + items.length) % items.length;
		items[this.selectedSuggestionIdx]?.addClass("codex-suggestion-active");
	}

	private selectSuggestion() {
		if (!this.suggestionsEl) return;
		const items = this.suggestionsEl.querySelectorAll(".codex-suggestion-item");
		const selectedItem = items[this.selectedSuggestionIdx];
		if (!selectedItem) return;

		const nameEl = selectedItem.querySelector(".codex-suggestion-name");
		if (!nameEl) return;

		const fileName = nameEl.textContent ?? "";
		// Find the TFile
		const files = this.app.vault.getFiles().filter(
			(f) => f.basename === fileName
		);
		if (files[0]) {
			this.insertFileMention(files[0]);
		}
	}

	private insertFileMention(file: TFile) {
		if (!this.inputEl || this.atMentionStart < 0) return;

		const text = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart ?? text.length;

		const mention = file.basename.includes(" ")
			? `@"${file.basename}"`
			: `@${file.basename}`;

		const before = text.slice(0, this.atMentionStart);
		const after = text.slice(cursorPos);
		this.inputEl.value = before + mention + " " + after;
		this.inputEl.selectionStart = before.length + mention.length + 1;
		this.inputEl.selectionEnd = before.length + mention.length + 1;
		this.inputEl.focus();
		this.hideFileSuggestions();
	}

	// ─── Slash commands ───

	private handleSlashCommand(text: string): boolean {
		const trimmed = text.trim();

		if (trimmed === "/clear" || trimmed === "/new") {
			this.startNewSession();
			new Notice("New conversation started.");
			return true;
		}

		if (trimmed === "/export") {
			void this.exportToNote();
			return true;
		}

		const modelMatch = trimmed.match(/^\/model\s+(.+)/);
		if (modelMatch?.[1]) {
			this.plugin.settings.modelOverride = modelMatch[1].trim();
			void this.plugin.saveSettings();
			new Notice(`Model set to: ${modelMatch[1].trim()}`);
			return true;
		}

		if (trimmed === "/help") {
			const helpText = [
				"**Available commands:**",
				"- `/clear` or `/new` — Start a new conversation",
				"- `/export` — Export chat to a vault note",
				"- `/model <name>` — Switch the model",
				"- `/help` — Show this help",
				"- `@filename` — Reference a vault file",
			].join("\n");
			const helpMsg: ChatMessage = {
				role: "assistant",
				content: helpText,
				timestamp: Date.now(),
			};
			this.messages.push(helpMsg);
			const el = this.createAssistantBubble();
			void this.renderMarkdownInEl(el, helpText);
			void this.persistMessages();
			return true;
		}

		return false;
	}

	// ─── Template picker ───

	private showTemplatePicker(e: MouseEvent) {
		const templates = this.plugin.settings.promptTemplates;
		if (templates.length === 0) {
			new Notice("No prompt templates configured. Add them in settings.");
			return;
		}

		const menu = new Menu();
		for (const tmpl of templates) {
			menu.addItem((item) => {
				item.setTitle(tmpl.name);
				item.onClick(() => {
					this.applyTemplate(tmpl);
				});
			});
		}
		menu.showAtMouseEvent(e);
	}

	private applyTemplate(tmpl: PromptTemplate) {
		const resolved = this.resolveTemplateVariables(tmpl.template);
		if (this.inputEl) {
			this.inputEl.value = resolved;
			this.inputEl.focus();
		}
	}

	private resolveTemplateVariables(template: string): string {
		let result = template;

		// {{selection}} — current editor selection
		const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		const selection = editor?.getSelection() ?? "";
		result = result.replace(/\{\{selection\}\}/g, selection);

		// {{note}} — full content of active note
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			// We can't do async here easily, so use a placeholder note indicator
			result = result.replace(/\{\{title\}\}/g, activeFile.basename);
		} else {
			result = result.replace(/\{\{title\}\}/g, "(no active note)");
		}

		// {{note}} — will be resolved on send if needed, for now insert a marker
		// Actually, let's read the file content synchronously from cache
		if (activeFile) {
			const cache = this.app.vault.getAbstractFileByPath(activeFile.path);
			if (cache) {
				// Use cachedRead in an async-safe way — but templates go into input, so user can edit
				result = result.replace(
					/\{\{note\}\}/g,
					`@${activeFile.basename.includes(" ") ? `"${activeFile.basename}"` : activeFile.basename}`
				);
			}
		} else {
			result = result.replace(/\{\{note\}\}/g, "(no active note)");
		}

		return result;
	}
}
