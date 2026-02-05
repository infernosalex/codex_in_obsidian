import { Editor, MarkdownView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { FileSystemAdapter } from "obsidian";
import { DEFAULT_SETTINGS, CodexChatSettings, CodexChatSettingTab } from "./settings";
import { CodexAuth } from "./auth";
import { CodexService } from "./codex-service";
import { VaultContext } from "./context";
import { CodexChatView, VIEW_TYPE_CODEX_CHAT } from "./views/chat-view";
import { resolveCodexBinary, clearShellEnvCache } from "./shell-env";

export default class CodexChatPlugin extends Plugin {
	settings: CodexChatSettings = DEFAULT_SETTINGS;
	auth: CodexAuth = new CodexAuth(DEFAULT_SETTINGS.codexBinaryPath);
	codexService: CodexService = new CodexService(DEFAULT_SETTINGS);
	vaultContext: VaultContext = new VaultContext(this.app);

	async onload() {
		await this.loadSettings();

		// Initialize services with loaded settings
		this.auth = new CodexAuth(this.settings.codexBinaryPath);
		this.codexService = new CodexService(this.settings);
		this.vaultContext = new VaultContext(this.app);

		// Set vault base path so codex runs with the vault as cwd
		if (this.app.vault.adapter instanceof FileSystemAdapter) {
			this.codexService.setVaultBasePath(this.app.vault.adapter.getBasePath());
		}

		// Register the chat sidebar view
		this.registerView(VIEW_TYPE_CODEX_CHAT, (leaf) => new CodexChatView(leaf, this));

		// Ribbon icon to open/focus the chat
		this.addRibbonIcon("message-square", "Open codex chat", () => {
			void this.activateChatView();
		});

		// ─── Commands ───

		// Open chat panel
		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => {
				void this.activateChatView();
			},
		});

		// Send selection to codex
		this.addCommand({
			id: "send-selection-to-codex",
			name: "Send selection to codex",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const selection = editor.getSelection();
				const text = selection || editor.getValue();
				const source = view.file?.basename ?? "note";
				const isSelection = !!selection;

				const label = isSelection
					? `Selected text from "${source}"`
					: `Full content of "${source}"`;

				const prompt = `${label}:\n\`\`\`\n${text}\n\`\`\`\n\nPlease analyze this content and provide helpful insights.`;

				const chatView = await this.activateChatView();
				if (chatView) {
					await chatView.sendUserMessage(prompt);
				}
			},
		});

		// Insert last codex response at cursor (or replace selection)
		this.addCommand({
			id: "insert-codex-response",
			name: "Insert last codex response at cursor",
			editorCallback: (editor: Editor) => {
				const chatView = this.getChatView();
				if (!chatView) {
					new Notice("Open codex chat first to get a response.");
					return;
				}
				const lastResponse = chatView.getLastResponse();
				if (!lastResponse) {
					new Notice("No codex response to insert.");
					return;
				}

				const selection = editor.getSelection();
				if (selection) {
					// Replace the selected text with the response
					editor.replaceSelection(lastResponse);
					new Notice("Selection replaced with codex response.");
				} else {
					// Insert at cursor
					const cursor = editor.getCursor();
					editor.replaceRange(lastResponse, cursor);
					new Notice("Codex response inserted.");
				}
			},
		});

		// Sign in to codex
		this.addCommand({
			id: "codex-sign-in",
			name: "Sign in to codex",
			callback: async () => {
				await this.auth.triggerLogin();
			},
		});

		// Settings tab
		this.addSettingTab(new CodexChatSettingTab(this.app, this));

		// Check if Codex CLI is available on startup
		this.checkCodexAvailability();
	}

	onunload() {
		this.codexService.destroy();
		this.auth.destroy();
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		// Settings keys are stored at the top level alongside chatMessages
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { chatMessages, ...settingsData } = data;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			settingsData as Partial<CodexChatSettings>
		);
	}

	async saveSettings() {
		// Preserve chatMessages when saving settings
		const existing = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const merged: Record<string, unknown> = { ...existing, ...this.settings };
		await this.saveData(merged);
		// Clear cached shell env so changes to binary path are re-resolved
		clearShellEnvCache();
		// Update services with new settings
		this.auth.setBinaryPath(this.settings.codexBinaryPath);
		this.codexService.updateSettings(this.settings);
	}

	/**
	 * Check if the user is authenticated and prompt login if not.
	 * Returns true if authenticated, false if not.
	 */
	async ensureAuthenticated(): Promise<boolean> {
		const authenticated = await this.auth.isAuthenticated();
		if (!authenticated) {
			new Notice(
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				"Not signed in to Codex. Use the \"Sign in to codex\" command or go to Settings \u2192 Codex chat.",
				8000
			);
			return false;
		}
		return true;
	}

	/**
	 * Open or focus the Codex Chat sidebar.
	 */
	async activateChatView(): Promise<CodexChatView | null> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_CODEX_CHAT);

		if (leaves.length > 0) {
			leaf = leaves[0] ?? null;
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: VIEW_TYPE_CODEX_CHAT,
					active: true,
				});
			}
		}

		if (leaf) {
			void workspace.revealLeaf(leaf);
			const view = leaf.view;
			if (view instanceof CodexChatView) {
				return view;
			}
		}

		return null;
	}

	/**
	 * Get an existing chat view instance without creating one.
	 */
	private getChatView(): CodexChatView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_CHAT);
		for (const leaf of leaves) {
			if (leaf.view instanceof CodexChatView) {
				return leaf.view;
			}
		}
		return null;
	}

	/**
	 * Verify the Codex CLI is installed and notify the user if not.
	 */
	private checkCodexAvailability() {
		// Give Obsidian a moment to finish loading
		window.setTimeout(() => {
			void (async () => {
				const resolved = resolveCodexBinary(this.settings.codexBinaryPath);
				const ok = await this.codexService.testConnection();
				if (!ok) {
					new Notice(
						`Codex CLI not found (searched: ${resolved}).\n` +
						"Install it with: npm i -g @openai/codex\n" +
						"Then configure the binary path in Settings \u2192 Codex Chat.",
						10000
					);
				}
			})();
		}, 3000);
	}
}
