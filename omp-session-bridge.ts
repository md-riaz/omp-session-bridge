import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";

interface HarnessConfig {
	enabled: boolean;
	host: string;
	port: number;
	token: string;
	historyLimit: number;
	autoStartServer: boolean;
	pollIntervalMs: number;
}

const DEFAULT_CONFIG: HarnessConfig = {
	enabled: true,
	host: "127.0.0.1",
	port: 17979,
	token: "",
	historyLimit: 200,
	autoStartServer: true,
	pollIntervalMs: 1000,
};

const __dirname = dirname(fileURLToPath(import.meta.url));

function agentDir(): string {
	return process.env.PI_HOME || join(homedir(), ".pi", "agent");
}

function bridgeDir(): string {
	return join(agentDir(), "omp-session-bridge");
}

function configPath(): string {
	return join(bridgeDir(), "config.json");
}

function pidPath(): string {
	return join(bridgeDir(), "server.pid");
}

function loadConfig(): HarnessConfig {
	mkdirSync(bridgeDir(), { recursive: true });
	let config = { ...DEFAULT_CONFIG };
	try {
		config = { ...config, ...JSON.parse(readFileSync(configPath(), "utf8")) };
	} catch {}
	if (!config.token) config.token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 16);
	config.port = Number(config.port) || DEFAULT_CONFIG.port;
	config.historyLimit = Math.max(20, Number(config.historyLimit) || DEFAULT_CONFIG.historyLimit);
	config.pollIntervalMs = Math.max(250, Number(config.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs);
	writeFileSync(configPath(), JSON.stringify(config, null, 2));
	return config;
}

function baseUrl(config: HarnessConfig): string {
	return `http://${config.host}:${config.port}`;
}

function serverScript(): string {
	return join(__dirname, "omp-session-bridge-server.mjs");
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPid(): number | null {
	try {
		const pid = Number(readFileSync(pidPath(), "utf8").trim());
		return Number.isFinite(pid) ? pid : null;
	} catch {
		return null;
	}
}

function windowsLauncherPath(): string {
	return join(bridgeDir(), "server-launch.vbs");
}

function quoteWindowsArg(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function spawnServer(): ChildProcess {
	mkdirSync(bridgeDir(), { recursive: true });
	const script = serverScript();
	if (process.platform === "win32") {
		const commandLine = [quoteWindowsArg(process.execPath), quoteWindowsArg(script)].join(" ");
		const launcher = windowsLauncherPath();
		writeFileSync(launcher, [
			'Set WshShell = CreateObject("WScript.Shell")',
			`WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
			'Set WshShell = Nothing',
			"",
		].join("\r\n"));
		return spawn("wscript.exe", [launcher], { detached: true, stdio: "ignore" });
	}
	return spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
}

async function waitForServer(config: HarnessConfig, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl(config)}/api/health?token=${encodeURIComponent(config.token)}`);
			if (response.ok) return;
			lastError = new Error(`HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function ensureServer(config: HarnessConfig): Promise<void> {
	const pid = readPid();
	if (pid && isProcessRunning(pid)) {
		try {
			await waitForServer(config, 1500);
			return;
		} catch {}
	}
	if (!config.autoStartServer) throw new Error("Session bridge server is not running and autoStartServer is false");
	const child = spawnServer();
	child.unref();
	await waitForServer(config);
}

async function post(config: HarnessConfig, path: string, body: unknown): Promise<void> {
	const response = await fetch(`${baseUrl(config)}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
}

async function getJson(config: HarnessConfig, path: string): Promise<any> {
	const response = await fetch(`${baseUrl(config)}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(config.token)}`);
	if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
	return response.json();
}

function currentSession(ctx: ExtensionContext, status: string) {
	return {
		id: ctx.sessionManager.getSessionId(),
		name: ctx.sessionManager.getSessionName(),
		cwd: ctx.cwd,
		model: ctx.model?.id || "unknown",
		status,
		contextUsage: ctx.getContextUsage?.(),
		pid: process.pid,
	};
}

function networkHint(config: HarnessConfig): string {
	return [
		`Local: ${baseUrl(config)}`,
		`Config: ${configPath()}`,
		`Token: ${config.token}`,
	].join("\n");
}

export default function ompSessionBridge(pi: ExtensionAPI) {
	const config = loadConfig();
	let ctxRef: ExtensionContext | null = null;
	let sessionId: string | null = null;
	let status = "idle";
	let serverOk = false;
	let presenceTimer: ReturnType<typeof setInterval> | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	const toolNames = new Map<string, string>();

	function liveCtx(): ExtensionContext | null {
		if (!ctxRef || !sessionId) return null;
		try {
			if (ctxRef.sessionManager.getSessionId() !== sessionId) return null;
			return ctxRef;
		} catch {
			return null;
		}
	}

	function setUiStatus(text: string | undefined) {
		const ctx = liveCtx();
		if (!ctx?.hasUI) return;
		try { ctx.ui.setStatus("omp-bridge", text); } catch {}
	}

	function currentStatus(): string {
		const runningTool = toolNames.values().next().value;
		return runningTool ? `tool:${runningTool}` : status;
	}

	async function sendEvent(event: Record<string, unknown>): Promise<void> {
		if (!config.enabled || !sessionId || !serverOk) return;
		try {
			await post(config, "/api/event", { sessionId, event });
		} catch {
			serverOk = false;
			setUiStatus("Bridge ✗");
		}
	}

	async function sendPresence(): Promise<void> {
		const ctx = liveCtx();
		if (!ctx || !serverOk) return;
		try {
			await post(config, "/api/presence", { sessionId: ctx.sessionManager.getSessionId(), ...currentSession(ctx, currentStatus()) });
		} catch {
			serverOk = false;
			setUiStatus("Bridge ✗");
		}
	}

	async function register(ctx: ExtensionContext): Promise<void> {
		if (!config.enabled) return;
		try {
			await ensureServer(config);
			serverOk = true;
			await post(config, "/api/register", { session: currentSession(ctx, currentStatus()) });
			setUiStatus("Bridge ✓");
		} catch (error) {
			serverOk = false;
			setUiStatus("Bridge ✗");
			if (ctx.hasUI) ctx.ui.notify(`OMP session bridge unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async function pollCommands(): Promise<void> {
		const ctx = liveCtx();
		if (!ctx || !serverOk || !sessionId) return;
		try {
			const data = await getJson(config, `/api/poll?sessionId=${encodeURIComponent(sessionId)}`);
			const commands = Array.isArray(data?.commands) ? data.commands : [];
			for (const command of commands) {
				if (command?.type === "user_message" && typeof command.text === "string" && command.text.trim()) {
					pi.sendUserMessage(command.text);
					await sendEvent({ type: "command_received", command });
				}
			}
		} catch {
			serverOk = false;
			setUiStatus("Bridge ✗");
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!config.enabled) return;
		ctxRef = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		status = "idle";
		toolNames.clear();
		void register(ctx);
		presenceTimer = setInterval(() => void sendPresence(), 5_000);
		pollTimer = setInterval(() => void pollCommands(), config.pollIntervalMs);
	});

	pi.on("session_shutdown", async () => {
		if (presenceTimer) clearInterval(presenceTimer);
		if (pollTimer) clearInterval(pollTimer);
		if (config.enabled && sessionId && serverOk) {
			try { await post(config, "/api/unregister", { sessionId }); } catch {}
		}
		ctxRef = null;
		sessionId = null;
		serverOk = false;
		toolNames.clear();
	});

	pi.on("input", (event) => void sendEvent({ type: "input", text: event.text, source: event.source, timestamp: Date.now() }));
	pi.on("agent_start", () => { status = "thinking"; void sendEvent({ type: "agent_start", timestamp: Date.now() }); });
	pi.on("agent_end", () => { status = "idle"; toolNames.clear(); void sendEvent({ type: "agent_end", timestamp: Date.now() }); void sendPresence(); });
	pi.on("message_update", (event) => void sendEvent({ type: "message_update", message: (event as any).message, timestamp: Date.now() }));
	pi.on("message_end", (event) => void sendEvent({ type: "message_end", message: (event as any).message, timestamp: Date.now() }));
	pi.on("tool_execution_start", (event) => { toolNames.set(event.toolCallId, event.toolName); void sendEvent({ type: "tool_start", tool: event, timestamp: Date.now() }); });
	pi.on("tool_execution_update", (event) => void sendEvent({ type: "tool_update", tool: event, timestamp: Date.now() }));
	pi.on("tool_execution_end", (event) => { toolNames.delete(event.toolCallId); void sendEvent({ type: "tool_end", tool: event, timestamp: Date.now() }); });
	pi.on("model_select", (event) => { void sendEvent({ type: "model_select", model: (event as any).model?.id, timestamp: Date.now() }); void sendPresence(); });

	pi.registerCommand("bridge", {
		description: "OMP session bridge: /bridge [status|info|start]",
		getArgumentCompletions(prefix: string) {
			return ["status", "info", "start"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		async handler(args, ctx) {
			const sub = args.trim().toLowerCase();
			if (sub === "start") {
				try {
					await ensureServer(config);
					serverOk = true;
					await register(ctx);
					ctx.ui.notify(`OMP session bridge started.\n\n${networkHint(config)}`, "info");
				} catch (error) {
					ctx.ui.notify(`OMP session bridge start failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (sub === "info" || sub === "status" || !sub) {
				ctx.ui.notify([
					"═══ OMP Session Bridge ═══",
					`Status: ${serverOk ? "connected" : "not connected"}`,
					`PID: ${readPid() ?? "unknown"}`,
					"",
					networkHint(config),
				].join("\n"), serverOk ? "info" : "warning");
				return;
			}
			ctx.ui.notify("Unknown /bridge command. Use /bridge, /bridge info, or /bridge start.", "warning");
		},
	});
}
