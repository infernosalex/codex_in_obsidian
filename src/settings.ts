import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CodexChatPlugin from "./main";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ContextMode = "none" | "current-note" | "current-and-linked";
export type ReasoningEffort = "low" | "medium" | "high";

export interface CodexChatSettings {
	codexBinaryPath: string;
	sandboxMode: SandboxMode;
	contextMode: ContextMode;
	maxContextLength: number;
	modelOverride: string;
	reasoningEffort: ReasoningEffort;
}

export const DEFAULT_SETTINGS: CodexChatSettings = {
	codexBinaryPath: "codex",
	sandboxMode: "read-only",
	contextMode: "current-note",
	maxContextLength: 10000,
	modelOverride: "",
	reasoningEffort: "medium",
};

export class CodexChatSettingTab extends PluginSettingTab {
	plugin: CodexChatPlugin;

	constructor(app: App, plugin: CodexChatPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Binary path ---
		new Setting(containerEl)
			.setName("Binary path")
			.setDesc(
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				"Path to the Codex CLI binary. Use 'codex' if it's on your PATH."
			)
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder("codex")
					.setValue(this.plugin.settings.codexBinaryPath)
					.onChange(async (value) => {
						this.plugin.settings.codexBinaryPath =
							value.trim() || "codex";
						await this.plugin.saveSettings();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					const ok = await this.plugin.codexService.testConnection();
					new Notice(
						ok
							? "Codex CLI found and responding!"
							: "Could not reach Codex CLI. Check the binary path."
					);
				})
			);

		// --- Sandbox mode ---
		new Setting(containerEl)
			.setName("Sandbox mode")
			.setDesc(
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				"Controls what Codex is allowed to do. 'read-only' is safest."
			)
			.addDropdown((dd) =>
				dd
					.addOption("read-only", "Read-only (safe)")
					.addOption("workspace-write", "Workspace write")
					.addOption(
						"danger-full-access",
						"Full access (dangerous)"
					)
					.setValue(this.plugin.settings.sandboxMode)
					.onChange(async (value) => {
						this.plugin.settings.sandboxMode =
							value as SandboxMode;
						await this.plugin.saveSettings();
					})
			);

		// --- Context mode ---
		new Setting(containerEl)
			.setName("Context mode")
			.setDesc(
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				"What vault context to include when sending messages to Codex."
			)
			.addDropdown((dd) =>
				dd
					.addOption("none", "None")
					.addOption("current-note", "Current note")
					.addOption(
						"current-and-linked",
						"Current note + linked notes"
					)
					.setValue(this.plugin.settings.contextMode)
					.onChange(async (value) => {
						this.plugin.settings.contextMode =
							value as ContextMode;
						await this.plugin.saveSettings();
					})
			);

		// --- Max context length ---
		new Setting(containerEl)
			.setName("Max context length")
			.setDesc(
				"Maximum number of characters of vault context to include in prompts."
			)
			.addSlider((slider) =>
				slider
					.setLimits(1000, 50000, 1000)
					.setValue(this.plugin.settings.maxContextLength)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxContextLength = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Model override ---
		new Setting(containerEl)
			.setName("Model override")
			.setDesc(
				"Optionally specify a model name (e.g. 'o3-mini'). Leave blank for default."
			)
			.addText((text) =>
				text
					.setPlaceholder("(default)")
					.setValue(this.plugin.settings.modelOverride)
					.onChange(async (value) => {
						this.plugin.settings.modelOverride = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// --- Reasoning effort ---
		new Setting(containerEl)
			.setName("Reasoning effort")
			.setDesc("How much reasoning effort the model should use.")
			.addDropdown((dd) =>
				dd
					.addOption("low", "Low")
					.addOption("medium", "Medium")
					.addOption("high", "High")
					.setValue(this.plugin.settings.reasoningEffort)
					.onChange(async (value) => {
						this.plugin.settings.reasoningEffort =
							value as ReasoningEffort;
						await this.plugin.saveSettings();
					})
			);

		// --- Auth section ---
		new Setting(containerEl).setName("Authentication").setHeading();

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("Sign in with ChatGPT")
			.setDesc(
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				"Authenticate using your ChatGPT account (no API key required). You must have the Codex CLI installed."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Sign in")
					.setCta()
					.onClick(async () => {
						await this.plugin.auth.triggerLogin();
					})
			);
	}
}
