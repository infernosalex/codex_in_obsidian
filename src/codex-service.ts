import { spawn, ChildProcess } from "child_process";
import type { CodexChatSettings } from "./settings";
import { getShellEnv, resolveCodexBinary } from "./shell-env";

// ─── Types mirroring Codex JSONL event stream ───

export interface CodexUsage {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
}

export interface CodexThreadEvent {
	type: string;
	thread_id?: string;
	usage?: CodexUsage;
	error?: { message: string };
	item?: CodexItem;
}

export interface CodexItem {
	id: string;
	type: string; // "agent_message" | "reasoning" | "command_execution" | "file_change" | "error" etc.
	text?: string;
	status?: string;
	command?: string;
	output?: string;
	exit_code?: number;
}

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	items?: CodexItem[];
}

// ─── Callback types ───

export type OnEvent = (event: CodexThreadEvent) => void;
export type OnTextChunk = (text: string) => void;
export type OnComplete = (fullText: string, usage?: CodexUsage) => void;
export type OnError = (error: string) => void;

// ─── Service ───

/**
 * Wraps the Codex CLI in non-interactive JSON mode.
 * Spawns `codex exec --json "<prompt>"` and streams JSONL events.
 */
export class CodexService {
	private settings: CodexChatSettings;
	private currentProcess: ChildProcess | null = null;
	private abortController: AbortController | null = null;

	private resolvedBinary: string;
	private vaultBasePath: string | null = null;

	constructor(settings: CodexChatSettings) {
		this.settings = settings;
		this.resolvedBinary = resolveCodexBinary(settings.codexBinaryPath);
	}

	updateSettings(settings: CodexChatSettings) {
		this.settings = settings;
		this.resolvedBinary = resolveCodexBinary(settings.codexBinaryPath);
	}

	/**
	 * Set the vault base path so codex runs with the vault as cwd.
	 */
	setVaultBasePath(path: string) {
		this.vaultBasePath = path;
	}

	/**
	 * Test if the codex binary is reachable.
	 */
	async testConnection(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			try {
				const proc = spawn(this.resolvedBinary, ["--version"], {
					timeout: 10000,
					stdio: ["ignore", "pipe", "pipe"],
					env: getShellEnv(),
				});

				proc.on("close", (code) => {
					resolve(code === 0);
				});
				proc.on("error", () => {
					resolve(false);
				});
			} catch {
				resolve(false);
			}
		});
	}

	/**
	 * Send a message to Codex and stream back events.
	 */
	async sendMessage(
		prompt: string,
		callbacks: {
			onEvent?: OnEvent;
			onTextChunk?: OnTextChunk;
			onComplete?: OnComplete;
			onError?: OnError;
		}
	): Promise<void> {
		// Cancel any existing request
		this.cancel();

		this.abortController = new AbortController();

		const args = this.buildArgs(prompt);

		return new Promise<void>((resolve, reject) => {
			try {
				this.currentProcess = spawn(this.resolvedBinary, args, {
					stdio: ["ignore", "pipe", "pipe"],
					env: getShellEnv(),
					...(this.vaultBasePath ? { cwd: this.vaultBasePath } : {}),
				});
			} catch (err) {
				callbacks.onError?.("Failed to start Codex CLI. Is it installed?");
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}

			let fullText = "";
			let lastUsage: CodexUsage | undefined;
			let stderrBuffer = "";
			let stdoutBuffer = "";

			// Handle abort
			const onAbort = () => {
				this.currentProcess?.kill("SIGTERM");
			};
			if (this.abortController) {
				this.abortController.signal.addEventListener("abort", onAbort);
			}

			this.currentProcess.stdout?.on("data", (data: Uint8Array) => {
				stdoutBuffer += new TextDecoder().decode(data);

				// Process complete JSONL lines
				const lines = stdoutBuffer.split("\n");
				// Keep the last incomplete line in the buffer
				stdoutBuffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let event: CodexThreadEvent;
					try {
						event = JSON.parse(trimmed) as CodexThreadEvent;
					} catch {
						// Not JSON — could be plain text output in non-JSON mode
						// Treat as text chunk
						fullText += trimmed + "\n";
						callbacks.onTextChunk?.(trimmed + "\n");
						continue;
					}

					callbacks.onEvent?.(event);

					// Extract text from agent messages
					if (event.item?.type === "agent_message" && event.item.text) {
						if (event.type === "item.completed") {
							fullText = event.item.text;
							callbacks.onTextChunk?.(event.item.text);
						}
					}

					// Track usage
					if (event.type === "turn.completed" && event.usage) {
						lastUsage = event.usage;
					}

					// Handle errors
					if (event.type === "turn.failed" || event.type === "error") {
						const msg = event.error?.message ?? event.item?.text ?? "Unknown error";
						callbacks.onError?.(msg);
					}
				}
			});

			this.currentProcess.stderr?.on("data", (data: Uint8Array) => {
				stderrBuffer += new TextDecoder().decode(data);
			});

			this.currentProcess.on("close", (code) => {
				this.currentProcess = null;
				this.abortController?.signal.removeEventListener("abort", onAbort);
				this.abortController = null;

				// Process any remaining stdout buffer
				if (stdoutBuffer.trim()) {
					try {
						const event = JSON.parse(stdoutBuffer.trim()) as CodexThreadEvent;
						callbacks.onEvent?.(event);
						if (event.item?.type === "agent_message" && event.item.text) {
							fullText = event.item.text;
						}
					} catch {
						fullText += stdoutBuffer.trim();
						callbacks.onTextChunk?.(stdoutBuffer.trim());
					}
				}

				if (code === 0 || fullText) {
					callbacks.onComplete?.(fullText, lastUsage);
					resolve();
				} else if (code !== null && code !== 0) {
					// Non-JSON fallback: stderr might have the actual response
					if (stderrBuffer.trim() && !fullText) {
						// Some codex versions output to stderr
						callbacks.onError?.(
							`Codex exited with code ${code}. ${stderrBuffer.slice(0, 500)}`
						);
					} else {
						callbacks.onError?.(`Codex exited with code ${code}`);
					}
					reject(new Error(`Codex exited with code ${code}`));
				} else {
					// code is null — killed
					callbacks.onComplete?.(fullText, lastUsage);
					resolve();
				}
			});

			this.currentProcess.on("error", (err) => {
				this.currentProcess = null;
				callbacks.onError?.(`Failed to run Codex: ${err.message}`);
				reject(err);
			});
		});
	}

	/**
	 * Send a simple prompt and get back the full text response (no streaming).
	 */
	async query(prompt: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let result = "";
			this.sendMessage(prompt, {
				onTextChunk: (chunk) => {
					result += chunk;
				},
				onComplete: (fullText) => {
					resolve(fullText || result);
				},
				onError: (err) => {
					reject(new Error(err));
				},
			}).catch(reject);
		});
	}

	/**
	 * Cancel the current in-flight request.
	 */
	cancel() {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		if (this.currentProcess) {
			this.currentProcess.kill("SIGTERM");
			this.currentProcess = null;
		}
	}

	/**
	 * Check if a request is currently in progress.
	 */
	isRunning(): boolean {
		return this.currentProcess !== null;
	}

	/**
	 * Build CLI args for codex exec.
	 */
	private buildArgs(prompt: string): string[] {
		const args = ["exec", "--json"];

		// Sandbox mode
		if (this.settings.sandboxMode === "danger-full-access") {
			args.push("--sandbox", "danger-full-access");
		} else if (this.settings.sandboxMode === "workspace-write") {
			args.push("--full-auto");
		}
		// read-only is the default

		// Model override
		if (this.settings.modelOverride) {
			args.push("--model", this.settings.modelOverride);
		}

		// Reasoning effort
		if (this.settings.reasoningEffort !== "medium") {
			args.push("--reasoning-effort", this.settings.reasoningEffort);
		}

		// Skip git repo check (vaults are rarely git repos)
		args.push("--skip-git-repo-check");

		// The prompt itself
		args.push(prompt);

		return args;
	}

	destroy() {
		this.cancel();
	}
}
