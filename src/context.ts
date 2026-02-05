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
	 * Resolve @file mentions in user text.
	 * Returns an array of resolved TFiles and the cleaned text.
	 */
	resolveAtMentions(text: string): { cleanedText: string; files: TFile[] } {
		const files: TFile[] = [];
		const allFiles = this.app.vault.getFiles();

		// Match @filename (with or without extension, can include spaces if quoted)
		// Patterns: @filename, @"file name with spaces", @folder/filename
		const cleanedText = text.replace(
			/@"([^"]+)"|@([\w/.-]+)/g,
			(match, quoted: string | undefined, plain: string | undefined) => {
				const name = quoted ?? plain ?? "";
				const resolved = this.findFile(name, allFiles);
				if (resolved) {
					files.push(resolved);
					return `[${resolved.basename}]`;
				}
				return match; // Keep unresolved mentions as-is
			}
		);

		return { cleanedText, files };
	}

	/**
	 * Build context string for explicitly referenced files.
	 */
	async buildAtFileContext(files: TFile[], maxLength: number): Promise<string> {
		if (files.length === 0) return "";

		const parts: string[] = [];
		let totalLength = 0;

		for (const file of files) {
			if (totalLength >= maxLength) break;
			const content = await this.getFileContent(file);
			const remaining = maxLength - totalLength;
			const section = this.formatNoteContext(
				file.basename,
				file.path,
				content,
				remaining
			);
			parts.push(section);
			totalLength += section.length;
		}

		if (parts.length === 0) return "";

		return (
			"Referenced files:\n" +
			"─".repeat(40) +
			"\n" +
			parts.join("\n" + "─".repeat(40) + "\n") +
			"\n" +
			"─".repeat(40) +
			"\n\n"
		);
	}

	/**
	 * Get file suggestions matching a partial name for autocomplete.
	 */
	getFileSuggestions(partial: string, limit = 10): TFile[] {
		const lower = partial.toLowerCase();
		const allFiles = this.app.vault.getFiles().filter(
			(f) => f.extension === "md"
		);

		// Score files by how well they match the partial
		const scored = allFiles
			.map((f) => {
				const name = f.basename.toLowerCase();
				const path = f.path.toLowerCase();
				let score = 0;
				if (name === lower) score = 100;
				else if (name.startsWith(lower)) score = 80;
				else if (path.startsWith(lower)) score = 70;
				else if (name.includes(lower)) score = 50;
				else if (path.includes(lower)) score = 30;
				return { file: f, score };
			})
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score);

		return scored.slice(0, limit).map((s) => s.file);
	}

	/**
	 * Find a file by name or path (fuzzy).
	 */
	private findFile(name: string, allFiles: TFile[]): TFile | null {
		const lower = name.toLowerCase();

		// Exact match by path
		for (const f of allFiles) {
			if (f.path.toLowerCase() === lower || f.path.toLowerCase() === lower + ".md") {
				return f;
			}
		}

		// Exact match by basename
		for (const f of allFiles) {
			if (f.basename.toLowerCase() === lower) {
				return f;
			}
		}

		// Partial match
		for (const f of allFiles) {
			if (f.basename.toLowerCase().startsWith(lower)) {
				return f;
			}
		}

		return null;
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
