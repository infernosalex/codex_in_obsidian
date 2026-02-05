import { Modal, App, Notice } from "obsidian";
import { spawn, ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getShellEnv, resolveCodexBinary } from "./shell-env";

/**
 * Strip ANSI escape sequences and terminal control characters from a string.
 * Handles CSI sequences (colors, cursor), OSC sequences, and carriage returns.
 */
function stripAnsi(text: string): string {
	return text
		// CSI sequences: ESC [ ... letter  (e.g. \x1b[90m, \x1b[0m, \x1b[2J)
		// eslint-disable-next-line no-control-regex
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		// OSC sequences: ESC ] ... BEL
		// eslint-disable-next-line no-control-regex
		.replace(/\x1b\][^\x07]*\x07/g, "")
		// Other ESC sequences (e.g. ESC(B)
		// eslint-disable-next-line no-control-regex
		.replace(/\x1b[^[\]].?/g, "")
		// Carriage returns (common in PTY / script output)
		.replace(/\r/g, "");
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
	 * Reads ~/.codex/auth.json and checks for token presence.
	 * Falls back to `codex login status` if the file-based check is inconclusive.
	 */
	async isAuthenticated(): Promise<boolean> {
		const authFile = join(homedir(), ".codex", "auth.json");
		if (!existsSync(authFile)) {
			return false;
		}

		// Try to parse the auth file and check token presence
		try {
			const raw = readFileSync(authFile, "utf-8");
			const data = JSON.parse(raw) as Record<string, unknown>;

			// Codex stores tokens nested under a "tokens" key
			const tokens = data["tokens"] as Record<string, unknown> | undefined;

			if (tokens) {
				// Check for access_token or refresh_token in the tokens object
				if (tokens["access_token"] || tokens["refresh_token"]) {
					return true;
				}
			}

			// Also check top-level fields (for alternative auth file formats)
			if (data["access_token"] || data["token"] || data["OPENAI_API_KEY"]) {
				// OPENAI_API_KEY can be null — check it's truthy
				const apiKey = data["OPENAI_API_KEY"];
				if (apiKey && typeof apiKey === "string") {
					return true;
				}
				if (data["access_token"] || data["token"]) {
					return true;
				}
			}

			// Check auth_mode — if chatgpt mode is set and tokens exist, we're good
			if (data["auth_mode"] === "chatgpt" && tokens) {
				return true;
			}

			// File exists but structure is unrecognized — fall back to CLI
			return this.checkAuthViaCli();
		} catch {
			// File exists but is unparseable — try CLI fallback
			return this.checkAuthViaCli();
		}
	}

	/**
	 * Check authentication status via `codex login status` CLI command.
	 */
	private checkAuthViaCli(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			try {
				const proc = spawn(this.binaryPath, ["login", "status"], {
					timeout: 10000,
					stdio: ["ignore", "pipe", "pipe"],
					env: getShellEnv(),
				});

				let stdout = "";
				proc.stdout?.on("data", (chunk: Uint8Array) => {
					stdout += new TextDecoder().decode(chunk);
				});
				let stderr = "";
				proc.stderr?.on("data", (chunk: Uint8Array) => {
					stderr += new TextDecoder().decode(chunk);
				});

				proc.on("close", (code) => {
					const combined = (stdout + stderr).toLowerCase();
					if (code === 0) {
						resolve(true);
					} else {
						resolve(
							combined.includes("logged in") ||
							combined.includes("authenticated")
						);
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
	 * Trigger the login flow.
	 * Spawns `codex login` which starts a local callback server and
	 * opens the browser for OAuth sign-in.
	 */
	async triggerLogin(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const app = (globalThis as Record<string, unknown>).app as App | undefined;
			if (!app) {
				new Notice("Cannot access Obsidian app for login modal.");
				reject(new Error("No app reference"));
				return;
			}

			// Use TERM=xterm so the CLI produces readable output.
			const loginEnv = { ...getShellEnv(), TERM: "xterm" };

			try {
				this.loginProcess = spawn(
					this.binaryPath,
					["login"],
					{
						stdio: ["ignore", "pipe", "pipe"],
						env: loginEnv,
					}
				);
			} catch (err) {
				new Notice(
					"Failed to start codex login. Is the CLI installed?"
				);
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}

			const modal = new LoginModal(app);
			modal.open();

			let allOutput = "";

			const handleOutput = (data: Uint8Array) => {
				const text = stripAnsi(new TextDecoder().decode(data));
				allOutput += text;

				// Extract the login URL
				const urlMatch = allOutput.match(
					/(https?:\/\/[^\s\r\n]+)/
				);

				if (urlMatch) {
					modal.setUrl(urlMatch[0]);
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
 * Modal that displays the login URL and CLI output to the user.
 */
class LoginModal extends Modal {
	private urlEl: HTMLElement | null = null;
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
			text: "A browser window should open automatically. If it doesn't, click the link below.",
		});

		this.urlEl = contentEl.createDiv({
			cls: "codex-login-url",
		});
		this.urlEl.setText("Starting login...");

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

	setRawOutput(text: string) {
		if (this.rawEl) {
			this.rawEl.setText(text.slice(-2000));
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
