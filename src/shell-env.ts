/// <reference types="node" />
import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, delimiter } from "path";

/**
 * Resolves the full PATH that the user's login shell would have.
 *
 * Electron apps (like Obsidian) inherit a minimal PATH from the OS,
 * missing paths added by fish, zsh, bash config files (e.g. linuxbrew,
 * cargo, nvm, pyenv, etc.). This module queries the user's actual shell
 * to get the real PATH.
 */

// Cache the resolved env so we only shell out once per session
let cachedEnv: Record<string, string | undefined> | null = null;

/**
 * Common install locations for the codex binary on Linux/macOS.
 */
const COMMON_CODEX_PATHS = [
	"/home/linuxbrew/.linuxbrew/bin/codex",
	"/opt/homebrew/bin/codex",
	"/usr/local/bin/codex",
	join(homedir(), ".local", "bin", "codex"),
	join(homedir(), ".npm-global", "bin", "codex"),
	join(homedir(), ".nvm", "versions"), // marker — we search deeper below
];

/**
 * Detect the user's login shell.
 */
function detectShell(): string {
	// Prefer $SHELL, fallback to common shells
	const shell = process.env["SHELL"];
	if (shell) return shell;

	// Check common locations
	for (const candidate of ["/usr/bin/fish", "/usr/bin/zsh", "/bin/zsh", "/bin/bash", "/usr/bin/bash"]) {
		if (existsSync(candidate)) return candidate;
	}
	return "/bin/sh";
}

/**
 * Get the PATH from the user's login shell (fish, zsh, bash).
 * Falls back to process.env.PATH if shell query fails.
 */
function getShellPath(): string {
	const shell = detectShell();
	const shellName = shell.split("/").pop() ?? "sh";

	try {
		let cmd: string;
		if (shellName === "fish") {
			// fish uses a different syntax
			cmd = `${shell} -l -c 'echo $PATH'`;
		} else {
			// bash, zsh, sh — login shell, print PATH
			cmd = `${shell} -l -c 'echo "$PATH"'`;
		}

		const result = execSync(cmd, {
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();

		if (result) {
			// fish outputs PATH with spaces instead of colons
			if (shellName === "fish" && result.includes(" ") && !result.includes(":")) {
				return result.split(" ").join(delimiter);
			}
			return result;
		}
	} catch {
		// Shell query failed — fall through
	}

	return process.env["PATH"] ?? "/usr/bin:/bin";
}

/**
 * Get a full process environment with the user's shell PATH merged in.
 * Cached after first call.
 */
export function getShellEnv(): Record<string, string | undefined> {
	if (cachedEnv) return cachedEnv;

	const shellPath = getShellPath();
	cachedEnv = {
		...process.env,
		PATH: shellPath,
		TERM: "dumb", // suppress TUI in child processes
	};

	return cachedEnv;
}

/**
 * Try to find the codex binary by searching the shell PATH
 * and common installation locations.
 * Returns the absolute path if found, otherwise the input as-is.
 */
export function resolveCodexBinary(configured: string): string {
	// If it's an absolute path and it exists, use it directly
	if (configured.startsWith("/") && existsSync(configured)) {
		return configured;
	}

	// If configured as just "codex", try to find it
	if (configured === "codex") {
		// First: try `which codex` via the user's shell
		const shell = detectShell();
		const shellName = shell.split("/").pop() ?? "sh";

		try {
			let cmd: string;
			if (shellName === "fish") {
				cmd = `${shell} -l -c 'which codex'`;
			} else {
				cmd = `${shell} -l -c 'which codex'`;
			}

			const result = execSync(cmd, {
				timeout: 5000,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();

			if (result && existsSync(result)) {
				return result;
			}
		} catch {
			// Fall through to manual search
		}

		// Second: check common locations
		for (const candidate of COMMON_CODEX_PATHS) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}

		// Third: scan PATH directories from shell env
		const shellPath = getShellPath();
		const dirs = shellPath.split(delimiter);
		for (const dir of dirs) {
			const candidate = join(dir, "codex");
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	// Return as-is — spawn will use normal PATH lookup
	return configured;
}

/**
 * Invalidate the cached environment (e.g. after settings change).
 */
export function clearShellEnvCache() {
	cachedEnv = null;
}
