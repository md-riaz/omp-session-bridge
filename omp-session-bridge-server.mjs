#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI_HOME = process.env.PI_HOME || path.join(os.homedir(), ".pi", "agent");
const HARNESS_DIR = path.join(PI_HOME, "omp-session-bridge");
const CONFIG_PATH = path.join(HARNESS_DIR, "config.json");
const PID_PATH = path.join(HARNESS_DIR, "server.pid");

const DEFAULT_CONFIG = {
  enabled: true,
  host: "127.0.0.1",
  port: 17979,
  token: "",
  historyLimit: 200,
  autoStartServer: true,
  pollIntervalMs: 1000
};

function randomToken() {
  return `${cryptoRandom()}${cryptoRandom().slice(0, 16)}`;
}

function cryptoRandom() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
}

function ensureConfig() {
  fs.mkdirSync(HARNESS_DIR, { recursive: true });
  let config = { ...DEFAULT_CONFIG };
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {}
  if (!config.token) config.token = randomToken();
  config.port = Number(config.port) || DEFAULT_CONFIG.port;
  config.historyLimit = Math.max(20, Number(config.historyLimit) || DEFAULT_CONFIG.historyLimit);
  config.pollIntervalMs = Math.max(250, Number(config.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

const config = ensureConfig();
const sessions = new Map();
const queues = new Map();
const watchers = new Set();
const startedAt = Date.now();
let seq = 0;

function nowIso() {
  return new Date().toISOString();
}

function getToken(req, url) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return url.searchParams.get("token") || "";
}

function authorized(req, url) {
  return config.token && getToken(req, url) === config.token;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function snapshot() {
  return {
    ok: true,
    name: "omp-session-bridge",
    startedAt,
    now: Date.now(),
    sessions: Array.from(sessions.values()).map(session => ({ ...session, history: session.history.slice(-config.historyLimit) }))
  };
}

function broadcast(event) {
  const payload = `event: update\ndata: ${JSON.stringify({ seq: ++seq, event, snapshot: snapshot() })}\n\n`;
  for (const res of watchers) {
    try { res.write(payload); } catch { watchers.delete(res); }
  }
}

function touchSession(id, patch = {}) {
  const current = sessions.get(id) || {
    id,
    name: id,
    cwd: "",
    model: "unknown",
    status: "idle",
    registeredAt: Date.now(),
    updatedAt: Date.now(),
    history: []
  };
  const next = { ...current, ...patch, updatedAt: Date.now() };
  sessions.set(id, next);
  if (!queues.has(id)) queues.set(id, []);
  return next;
}

function pushHistory(session, item) {
  session.history.push({ id: item.id || `${Date.now()}-${session.history.length}`, timestamp: Date.now(), ...item });
  if (session.history.length > config.historyLimit) session.history.splice(0, session.history.length - config.historyLimit);
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (url.pathname === "/") return sendJson(res, 200, { ok: true, name: "omp-session-bridge", health: `/api/health?token=${config.token}` });
    if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "omp-session-bridge", startedAt, config: { host: config.host, port: config.port }, addresses: localAddresses() });
    }

    if (req.method === "GET" && url.pathname === "/api/snapshot") return sendJson(res, 200, snapshot());

    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "access-control-allow-origin": "*"
      });
      watchers.add(res);
      res.write(`event: update\ndata: ${JSON.stringify({ seq, event: { type: "hello" }, snapshot: snapshot() })}\n\n`);
      req.on("close", () => watchers.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const body = await readBody(req);
      const session = body.session || {};
      if (!session.id) return sendJson(res, 400, { ok: false, error: "session.id required" });
      touchSession(session.id, { ...session, online: true, registeredAt: Date.now() });
      broadcast({ type: "register", sessionId: session.id });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/unregister") {
      const body = await readBody(req);
      if (!body.sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
      touchSession(body.sessionId, { online: false, status: "offline" });
      broadcast({ type: "unregister", sessionId: body.sessionId });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/presence") {
      const body = await readBody(req);
      if (!body.sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
      touchSession(body.sessionId, body);
      broadcast({ type: "presence", sessionId: body.sessionId });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/event") {
      const body = await readBody(req);
      if (!body.sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
      const session = touchSession(body.sessionId);
      pushHistory(session, body.event || {});
      touchSession(body.sessionId, session);
      broadcast({ type: "event", sessionId: body.sessionId, event: body.event || {} });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await readBody(req);
      if (!body.sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
      const queue = queues.get(body.sessionId) || [];
      const command = { id: `${Date.now()}-${queue.length}`, type: body.type || "user_message", text: String(body.text || ""), timestamp: Date.now() };
      queue.push(command);
      queues.set(body.sessionId, queue);
      broadcast({ type: "command_queued", sessionId: body.sessionId, command });
      return sendJson(res, 200, { ok: true, command });
    }

    if (req.method === "GET" && url.pathname === "/api/poll") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
      const commands = queues.get(sessionId) || [];
      queues.set(sessionId, []);
      return sendJson(res, 200, { ok: true, commands });
    }

    return sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("error", error => {
  console.error(`[omp-session-bridge] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", () => {
  try { fs.unlinkSync(PID_PATH); } catch {}
});

function shutdown() {
  try { fs.unlinkSync(PID_PATH); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

server.listen(Number(config.port), config.host, () => {
  fs.mkdirSync(HARNESS_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid));
  console.log(`[omp-session-bridge] listening on http://${config.host}:${config.port}`);
});
