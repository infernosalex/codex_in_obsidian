import { Modal, App, Notice } from "obsidian";
import { spawn, ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getShellEnv, resolveCodexBinary } from "./shell-env";

/**
 * Strip ANSI escape sequences from a string.
 * Handles color codes, cursor movement, and other terminal control sequences.
 */
function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Manages Codex CLI authentication state.
 * Uses the ChatGPT sign-in flow via `codex login --device-auth`.
 */
export class CodexAuth {
	private binaryPath: string;
	private loginProcess: ChildProcess | null = null;

	constructor(binaryPath: string) {
		this.binaryPath = resolveCodexBinary(binaryPath);
	}

	setBinaryPath(path: string) {
		this.binaryPath = resolveCodexBinary(path);
	}

	/**
	 * Check if the user has valid cached credentials.
	 * Reads ~/.codex/auth.json and checks for token expiry.
	 * Falls back to `codex auth status` if the file-based check is inconclusive.
	 */
	async isAuthenticated(): Promise<boolean> {
		const authFile = join(homedir(), ".codex", "auth.json");
		if (!existsSync(authFile)) {
			return false;
		}

		// Try to parse the auth file and check token expiry
		try {
			const raw = readFileSync(authFile, "utf-8");
			const data = JSON.parse(raw) as Record<string, unknown>;

			// Check common expiry fields
			const expiresAt = data["expires_at"] ?? data["expiry"];
			if (typeof expiresAt === "number") {
				// Treat as unix timestamp (seconds). Add 60s buffer.
				const nowSec = Math.floor(Date.now() / 1000);
				if (expiresAt <= nowSec + 60) {
					// Token expired — try refresh via CLI
					return this.checkAuthViaCli();
				}
			}

			// If we have an access_token or token field, consider authenticated
			if (data["access_token"] || data["token"]) {
				return true;
			}

			// File exists but structure is unknown — trust it
			return true;
		} catch {
			// File exists but is unparseable — try CLI fallback
			return this.checkAuthViaCli();
		}
	}

	/**
	 * Check authentication status via the CLI as a fallback.
	 */
	private checkAuthViaCli(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			try {
				const proc = spawn(this.binaryPath, ["auth", "status"], {
					timeout: 10000,
					stdio: ["ignore", "pipe", "pipe"],
					env: getShellEnv(),
				});

				let stdout = "";
				proc.stdout?.on("data", (chunk: Uint8Array) => {
					stdout += new TextDecoder().decode(chunk);
				});

				proc.on("close", (code) => {
					if (code === 0) {
						// CLI confirms auth is valid
						resolve(true);
					} else {
						// Check if stdout mentions "logged in" or similar
						const lower = stdout.toLowerCase();
						resolve(lower.includes("logged in") || lower.includes("authenticated"));
					}
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
	 * Trigger the device-code login flow.
	 * Spawns `codex login --device-auth`, parses the code/URL,
	 * and shows them in an Obsidian Modal.
	 */
	async triggerLogin(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const app = (globalThis as Record<string, unknown>).app as App | undefined;
			if (!app) {
				new Notice("Cannot access Obsidian app for login modal.");
				reject(new Error("No app reference"));
				return;
			}

			try {
				this.loginProcess = spawn(
					this.binaryPath,
					["login", "--device-auth"],
					{
						stdio: ["ignore", "pipe", "pipe"],
						env: getShellEnv(),
					}
				);
			} catch (err) {
				new Notice(
					"Failed to start codex login. Is the CLI installed?"
				);
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}

			const modal = new DeviceCodeModal(app);
			modal.open();

			let allOutput = "";

			const handleOutput = (data: Uint8Array) => {
				const text = stripAnsi(new TextDecoder().decode(data));
				allOutput += text;

				// Try to extract a URL and code from the output
				const urlMatch = allOutput.match(
					/https?:\/\/[^\s]+/
				);
				const codeMatch = allOutput.match(
					/code[:\s]+([A-Z0-9-]+)/i
				);

				if (urlMatch) {
					modal.setUrl(urlMatch[0]);
				}
				if (codeMatch?.[1]) {
					modal.setCode(codeMatch[1]);
				}

				// Update raw output display
				modal.setRawOutput(allOutput);
			};

			this.loginProcess.stdout?.on("data", handleOutput);
			this.loginProcess.stderr?.on("data", handleOutput);

			this.loginProcess.on("close", (code) => {
				this.loginProcess = null;
				modal.close();

				if (code === 0) {
					new Notice("Successfully signed in to codex!");
					resolve();
				} else {
					new Notice(
						`Codex login exited with code ${code}. Check the CLI output.`
					);
					reject(
						new Error(`Login exited with code ${code}`)
					);
				}
			});

			this.loginProcess.on("error", (err: Error) => {
				this.loginProcess = null;
				modal.close();
				new Notice(
					"Failed to run codex login. Is the CLI installed?"
				);
				reject(err);
			});
		});
	}

	/**
	 * Cancel an in-progress login.
	 */
	cancelLogin() {
		if (this.loginProcess) {
			this.loginProcess.kill();
			this.loginProcess = null;
		}
	}

	destroy() {
		this.cancelLogin();
	}
}

/**
 * Modal that displays the device-code login URL and code to the user.
 */
class DeviceCodeModal extends Modal {
	private urlEl: HTMLElement | null = null;
	private codeEl: HTMLElement | null = null;
	private rawEl: HTMLElement | null = null;

	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("codex-login-modal");

		contentEl.createEl("h2", { text: "Sign in to codex" });
		contentEl.createEl("p", {
			text: "Follow the instructions below to sign in with your account.",
		});

		const instructions = contentEl.createDiv({
			cls: "codex-login-instructions",
		});

		instructions.createEl("p", { text: "If a URL and code appear below, open the URL in your browser and enter the code:" });

		this.urlEl = instructions.createEl("div", {
			cls: "codex-login-url",
		});
		this.urlEl.setText("Waiting for login URL...");

		this.codeEl = instructions.createEl("div", {
			cls: "codex-login-code",
		});

		contentEl.createEl("h4", { text: "CLI output:" });
		this.rawEl = contentEl.createEl("pre", {
			cls: "codex-login-raw",
		});
		this.rawEl.setText("Starting codex login...");
	}

	setUrl(url: string) {
		if (this.urlEl) {
			this.urlEl.empty();
			const link = this.urlEl.createEl("a", {
				text: url,
				href: url,
			});
			link.setAttr("target", "_blank");
			link.setAttr("rel", "noopener");
		}
	}

	setCode(code: string) {
		if (this.codeEl) {
			this.codeEl.empty();
			this.codeEl.createEl("strong", { text: "Code: " });
			this.codeEl.createEl("code", { text: code, cls: "codex-device-code" });
		}
	}

	setRawOutput(text: string) {
		if (this.rawEl) {
			this.rawEl.setText(text.slice(-2000)); // Keep last 2000 chars
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
