import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CodexChatPlugin from "./main";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ContextMode = "none" | "current-note" | "current-and-linked";
export type ReasoningEffort = "low" | "medium" | "high";

export interface PromptTemplate {
	name: string;
	template: string;
}

export interface CodexChatSettings {
	codexBinaryPath: string;
	sandboxMode: SandboxMode;
	contextMode: ContextMode;
	maxContextLength: number;
	modelOverride: string;
	reasoningEffort: ReasoningEffort;
	memoryTurns: number;
	contextBudgetRatio: number;
	promptTemplates: PromptTemplate[];
}

export const DEFAULT_SETTINGS: CodexChatSettings = {
	codexBinaryPath: "codex",
	sandboxMode: "read-only",
	contextMode: "current-note",
	maxContextLength: 10000,
	modelOverride: "",
	reasoningEffort: "medium",
	memoryTurns: 10,
	contextBudgetRatio: 0.6,
	promptTemplates: [
		{ name: "Summarize this note", template: "Please summarize the following note:\n\n{{note}}" },
		{ name: "Explain this code", template: "Please explain this code:\n\n{{selection}}" },
		{ name: "Improve writing", template: "Please improve the writing in this text:\n\n{{selection}}" },
	],
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

		// --- Memory turns ---
		new Setting(containerEl)
			.setName("Memory turns")
			.setDesc(
				"Number of prior user/assistant turn pairs to include as conversation memory (1–50)."
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 50, 1)
					.setValue(this.plugin.settings.memoryTurns)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.memoryTurns = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Context budget ratio ---
		new Setting(containerEl)
			.setName("Context budget ratio")
			.setDesc(
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				"How much of the max context length to allocate to vault context vs. conversation memory (0.1 = mostly memory, 0.9 = mostly vault context)."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 0.9, 0.1)
					.setValue(this.plugin.settings.contextBudgetRatio)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.contextBudgetRatio = value;
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

		// --- Prompt templates section ---
		new Setting(containerEl).setName("Prompt templates").setHeading();

		new Setting(containerEl).setDesc(
			"Reusable prompt templates. Use {{selection}}, {{note}}, and {{title}} as variables."
		);

		const templatesContainer = containerEl.createDiv({
			cls: "codex-templates-settings",
		});
		this.renderTemplateList(templatesContainer);

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

	private renderTemplateList(container: HTMLElement) {
		container.empty();

		for (let i = 0; i < this.plugin.settings.promptTemplates.length; i++) {
			const tmpl = this.plugin.settings.promptTemplates[i];
			if (!tmpl) continue;

			new Setting(container)
				.setName(tmpl.name)
				.setDesc(
					tmpl.template.length > 60
						? tmpl.template.slice(0, 60) + "..."
						: tmpl.template
				)
				.addButton((btn) =>
					btn
						.setIcon("pencil")
						.setTooltip("Edit")
						.onClick(() => {
							this.editTemplate(container, i);
						})
				)
				.addButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete")
						.onClick(async () => {
							this.plugin.settings.promptTemplates.splice(i, 1);
							await this.plugin.saveSettings();
							this.renderTemplateList(container);
						})
				);
		}

		new Setting(container).addButton((btn) =>
			btn
				.setButtonText("Add template")
				.setCta()
				.onClick(() => {
					this.plugin.settings.promptTemplates.push({
						name: "New template",
						template: "",
					});
					this.editTemplate(
						container,
						this.plugin.settings.promptTemplates.length - 1
					);
				})
		);
	}

	private editTemplate(container: HTMLElement, index: number) {
		const tmpl = this.plugin.settings.promptTemplates[index];
		if (!tmpl) return;

		container.empty();

		const nameEl = new Setting(container)
			.setName("Template name")
			.addText((text) =>
				text.setValue(tmpl.name).onChange((value) => {
					tmpl.name = value;
				})
			);
		void nameEl;

		const templateEl = container.createDiv({ cls: "codex-template-edit" });
		const textarea = templateEl.createEl("textarea", {
			cls: "codex-template-textarea",
			attr: { rows: "4", placeholder: "Enter template text..." },
		});
		textarea.value = tmpl.template;
		textarea.addEventListener("input", () => {
			tmpl.template = textarea.value;
		});

		new Setting(container)
			.addButton((btn) =>
				btn.setButtonText("Save").setCta().onClick(async () => {
					await this.plugin.saveSettings();
					this.renderTemplateList(container);
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.renderTemplateList(container);
				})
			);
	}
}
