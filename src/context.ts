import { App, MarkdownView, TFile, CachedMetadata } from "obsidian";
import type { ContextMode } from "./settings";

/**
 * Builds vault context to prepend to Codex prompts.
 */
export class VaultContext {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Build a context string based on the configured mode.
	 */
	async buildContext(
		mode: ContextMode,
		maxLength: number
	): Promise<string> {
		if (mode === "none") {
			return "";
		}

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			return "";
		}

		const parts: string[] = [];
		let totalLength = 0;

		// Always include the current note
		const currentContent = await this.getFileContent(activeFile);
		const currentSection = this.formatNoteContext(
			activeFile.basename,
			activeFile.path,
			currentContent,
			maxLength
		);
		parts.push(currentSection);
		totalLength += currentSection.length;

		// Optionally include linked notes
		if (mode === "current-and-linked" && totalLength < maxLength) {
			const linkedFiles = this.getLinkedFiles(activeFile);
			for (const linkedFile of linkedFiles) {
				if (totalLength >= maxLength) break;

				const content = await this.getFileContent(linkedFile);
				const remaining = maxLength - totalLength;
				const section = this.formatNoteContext(
					linkedFile.basename,
					linkedFile.path,
					content,
					remaining
				);
				parts.push(section);
				totalLength += section.length;
			}
		}

		if (parts.length === 0) {
			return "";
		}

		return (
			"Context from Obsidian vault:\n" +
			"─".repeat(40) +
			"\n" +
			parts.join("\n" + "─".repeat(40) + "\n") +
			"\n" +
			"─".repeat(40) +
			"\n\n"
		);
	}

	/**
	 * Get the content of a note, selected text, or the full note.
	 */
	async getSelectedOrFullContent(): Promise<{
		text: string;
		source: string;
		isSelection: boolean;
	}> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (activeView) {
			const editor = activeView.editor;
			const selection = editor.getSelection();
			if (selection) {
				return {
					text: selection,
					source: activeView.file?.basename ?? "Unknown",
					isSelection: true,
				};
			}
		}

		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			const content = await this.getFileContent(activeFile);
			return {
				text: content,
				source: activeFile.basename,
				isSelection: false,
			};
		}

		return { text: "", source: "", isSelection: false };
	}

	/**
	 * Read a file's content.
	 */
	private async getFileContent(file: TFile): Promise<string> {
		try {
			return await this.app.vault.cachedRead(file);
		} catch {
			return "";
		}
	}

	/**
	 * Get files linked from the given file (outgoing links, 1 level deep).
	 */
	private getLinkedFiles(file: TFile): TFile[] {
		const cache: CachedMetadata | null =
			this.app.metadataCache.getFileCache(file);
		if (!cache) return [];

		const linkedPaths = new Set<string>();

		// Wiki links [[...]]
		if (cache.links) {
			for (const link of cache.links) {
				const resolved = this.app.metadataCache.getFirstLinkpathDest(
					link.link,
					file.path
				);
				if (resolved) {
					linkedPaths.add(resolved.path);
				}
			}
		}

		// Embeds ![[...]]
		if (cache.embeds) {
			for (const embed of cache.embeds) {
				const resolved = this.app.metadataCache.getFirstLinkpathDest(
					embed.link,
					file.path
				);
				if (resolved && resolved.extension === "md") {
					linkedPaths.add(resolved.path);
				}
			}
		}

		// Frontmatter links
		if (cache.frontmatterLinks) {
			for (const link of cache.frontmatterLinks) {
				const resolved = this.app.metadataCache.getFirstLinkpathDest(
					link.link,
					file.path
				);
				if (resolved) {
					linkedPaths.add(resolved.path);
				}
			}
		}

		const files: TFile[] = [];
		for (const path of linkedPaths) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile && f.extension === "md") {
				files.push(f);
			}
		}

		return files;
	}

	/**
	 * Format a note's content for inclusion in the prompt context.
	 */
	private formatNoteContext(
		title: string,
		path: string,
		content: string,
		maxLength: number
	): string {
		const header = `Note: ${title} (${path})\n`;
		const available = maxLength - header.length - 10; // margin

		if (available <= 0) return "";

		const trimmedContent =
			content.length > available
				? content.slice(0, available) + "\n...(truncated)"
				: content;

		return header + trimmedContent + "\n";
	}
}
