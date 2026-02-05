import type CodexChatPlugin from "./main";
import type { ChatMessage } from "./codex-service";

/**
 * Represents a named conversation session.
 */
export interface ChatSession {
	id: string;
	name: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
}

const MAX_PERSISTED_MESSAGES = 50;

/**
 * Manages multiple named conversation sessions with persistence.
 */
export class SessionManager {
	private plugin: CodexChatPlugin;
	private sessions: ChatSession[] = [];
	private activeSessionId: string | null = null;

	constructor(plugin: CodexChatPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Load sessions from plugin data (migrating old format if needed).
	 */
	async load(): Promise<void> {
		const data = ((await this.plugin.loadData()) ?? {}) as Record<string, unknown>;

		if (data.chatSessions && Array.isArray(data.chatSessions)) {
			this.sessions = data.chatSessions as ChatSession[];
		} else if (data.chatMessages && Array.isArray(data.chatMessages)) {
			// Migrate old single-conversation format
			const session = this.createSessionObject("Chat 1");
			session.messages = data.chatMessages as ChatMessage[];
			this.sessions = [session];
		}

		this.activeSessionId =
			(data.activeSessionId as string) ?? this.sessions[0]?.id ?? null;

		if (this.sessions.length === 0) {
			const session = this.createSessionObject("Chat 1");
			this.sessions = [session];
			this.activeSessionId = session.id;
		}
	}

	/**
	 * Save all sessions to plugin data.
	 */
	async save(): Promise<void> {
		const data = ((await this.plugin.loadData()) ?? {}) as Record<string, unknown>;
		data.chatSessions = this.sessions.map((s) => ({
			...s,
			messages: s.messages.slice(-MAX_PERSISTED_MESSAGES),
		}));
		data.activeSessionId = this.activeSessionId;
		delete data.chatMessages; // Remove old format
		await this.plugin.saveData(data);
	}

	getActiveSession(): ChatSession | null {
		return (
			this.sessions.find((s) => s.id === this.activeSessionId) ??
			this.sessions[0] ??
			null
		);
	}

	getActiveSessionId(): string | null {
		return this.activeSessionId;
	}

	getSessions(): ChatSession[] {
		return [...this.sessions];
	}

	createSession(name?: string): ChatSession {
		const session = this.createSessionObject(
			name ?? `Chat ${this.sessions.length + 1}`
		);
		this.sessions.push(session);
		this.activeSessionId = session.id;
		void this.save();
		return session;
	}

	switchTo(id: string): ChatSession | null {
		const session = this.sessions.find((s) => s.id === id);
		if (session) {
			this.activeSessionId = id;
			void this.save();
		}
		return session ?? null;
	}

	rename(id: string, newName: string): void {
		const session = this.sessions.find((s) => s.id === id);
		if (session) {
			session.name = newName;
			void this.save();
		}
	}

	deleteSession(id: string): void {
		this.sessions = this.sessions.filter((s) => s.id !== id);
		if (this.activeSessionId === id) {
			this.activeSessionId = this.sessions[0]?.id ?? null;
		}
		if (this.sessions.length === 0) {
			const session = this.createSessionObject("Chat 1");
			this.sessions = [session];
			this.activeSessionId = session.id;
		}
		void this.save();
	}

	updateMessages(messages: ChatMessage[]): void {
		const session = this.getActiveSession();
		if (session) {
			session.messages = messages;
			session.updatedAt = Date.now();
			void this.save();
		}
	}

	private createSessionObject(name: string): ChatSession {
		return {
			id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			name,
			messages: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
	}
}
