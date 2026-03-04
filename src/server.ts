import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { getConfig, type AppConfig } from "./config";
import { openDatabase } from "./db";
import { runMigrations } from "./migrate";

type User = { id: number; username: string };
type AuthResult = { user: User; token: string };
type AppDeps = {
  config: AppConfig;
  db?: Database;
};

type AppEvent = {
  id: number;
  conversationId: number | null;
  eventType: string;
  payload: unknown;
  createdAt: string;
};

class EventHub {
  #channels = new Map<number, Set<ReadableStreamDefaultController<string>>>();

  subscribe(conversationId: number, controller: ReadableStreamDefaultController<string>) {
    const bucket = this.#channels.get(conversationId) ?? new Set<ReadableStreamDefaultController<string>>();
    bucket.add(controller);
    this.#channels.set(conversationId, bucket);
  }

  unsubscribe(conversationId: number, controller: ReadableStreamDefaultController<string>) {
    const bucket = this.#channels.get(conversationId);
    if (!bucket) return;
    bucket.delete(controller);
    if (bucket.size === 0) this.#channels.delete(conversationId);
  }

  publish(event: AppEvent) {
    if (event.conversationId == null) return;
    const bucket = this.#channels.get(event.conversationId);
    if (!bucket) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const controller of bucket) {
      controller.enqueue(data);
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.get("cookie") ?? "";
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [k, ...rest] = part.split("=");
        return [k, decodeURIComponent(rest.join("="))];
      })
  );
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

function notFound(): Response {
  return json({ error: "Not found" }, 404);
}

function writeEventLog(path: string, entry: object) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

async function ensureAdminUser(db: Database, config: AppConfig) {
  const row = db.query("SELECT id FROM users WHERE username = ?1").get(config.adminUsername) as { id: number } | null;
  if (row) return;
  const passwordHash = await Bun.password.hash(config.adminPassword);
  db.query("INSERT INTO users(username, password_hash) VALUES (?1, ?2)").run(config.adminUsername, passwordHash);
}

function sanitizeText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, 10000);
}

export async function createApp(deps?: Partial<AppDeps>) {
  const config = deps?.config ?? getConfig();
  runMigrations(config.dbPath);
  const db = deps?.db ?? openDatabase(config.dbPath);
  await ensureAdminUser(db, config);

  const hub = new EventHub();

  const sessionByToken = db.query(
    `SELECT sessions.token, sessions.user_id, users.username
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?1 AND sessions.expires_at > datetime('now')`
  );

  const userByUsername = db.query("SELECT id, username, password_hash FROM users WHERE username = ?1");

  function authFromRequest(req: Request): AuthResult | null {
    const token = parseCookies(req).sid;
    if (!token) return null;
    const row = sessionByToken.get(token) as { token: string; user_id: number; username: string } | null;
    if (!row) return null;
    return { user: { id: row.user_id, username: row.username }, token: row.token };
  }

  function recordEvent(conversationId: number | null, eventType: string, payload: unknown): AppEvent {
    const payloadJson = JSON.stringify(payload ?? {});
    const info = db
      .query(
        `INSERT INTO events(conversation_id, event_type, payload_json)
         VALUES (?1, ?2, ?3)
         RETURNING id, created_at`
      )
      .get(conversationId, eventType, payloadJson) as { id: number; created_at: string };

    const event: AppEvent = {
      id: info.id,
      conversationId,
      eventType,
      payload,
      createdAt: info.created_at
    };

    writeEventLog(config.logsPath, event);
    hub.publish(event);
    return event;
  }

  async function streamAssistantReply(conversationId: number, assistantMessageId: number, userId: number) {
    const messageRows = db
      .query("SELECT role, content FROM messages WHERE conversation_id = ?1 ORDER BY id ASC")
      .all(conversationId) as Array<{ role: string; content: string }>;

    const safeMessages = messageRows
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const requestPayload = {
      model: config.defaultModel,
      stream: true,
      messages: safeMessages
    };

    recordEvent(conversationId, "openrouter.request", {
      userId,
      endpoint: `${config.openrouterBaseUrl}/chat/completions`,
      model: config.defaultModel,
      messageCount: safeMessages.length
    });

    if (!config.openrouterApiKey) {
      const fallback = "OPENROUTER_API_KEY is not configured.";
      db.query("UPDATE messages SET content = ?1, status = 'error' WHERE id = ?2").run(fallback, assistantMessageId);
      recordEvent(conversationId, "assistant.message.error", { messageId: assistantMessageId, error: fallback });
      return;
    }

    const response = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.openrouterApiKey}`
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      db.query("UPDATE messages SET content = ?1, status = 'error' WHERE id = ?2").run(text || "OpenRouter error", assistantMessageId);
      recordEvent(conversationId, "openrouter.error", {
        status: response.status,
        body: text
      });
      return;
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let accumulated = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const chunk = parsed.choices?.[0]?.delta?.content;
            if (!chunk) continue;
            accumulated += chunk;
            db.query("UPDATE messages SET content = ?1, status = 'streaming' WHERE id = ?2").run(accumulated, assistantMessageId);
            recordEvent(conversationId, "assistant.message.chunk", { messageId: assistantMessageId, chunk });
            recordEvent(conversationId, "openrouter.chunk", { messageId: assistantMessageId, chunkLength: chunk.length });
          } catch {
            recordEvent(conversationId, "openrouter.parse_error", { data });
          }
        }
      }

      db.query("UPDATE messages SET content = ?1, status = 'done' WHERE id = ?2").run(accumulated, assistantMessageId);
      db.query("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1").run(conversationId);
      recordEvent(conversationId, "assistant.message.completed", {
        messageId: assistantMessageId,
        length: accumulated.length
      });
      recordEvent(conversationId, "openrouter.response.completed", { messageId: assistantMessageId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown streaming error";
      db.query("UPDATE messages SET status = 'error' WHERE id = ?1").run(assistantMessageId);
      recordEvent(conversationId, "assistant.message.error", { messageId: assistantMessageId, error: message });
    }
  }

  function isApi(url: URL): boolean {
    return url.pathname.startsWith("/api/");
  }

  function htmlPage() {
    return new Response(readFileSync(join(process.cwd(), "public", "index.html"), "utf-8"), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  function staticFile(urlPath: string): Response | null {
    if (!urlPath.startsWith("/public/")) return null;
    const path = join(process.cwd(), urlPath);
    if (!existsSync(path)) return null;
    const ext = extname(path);
    const type =
      ext === ".js"
        ? "application/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
    return new Response(Bun.file(path), { headers: { "content-type": type } });
  }

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 120,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return json({ ok: true });
      }

      const staticResponse = staticFile(url.pathname);
      if (staticResponse) return staticResponse;

      const auth = authFromRequest(req);
      if (!auth && isApi(url) && url.pathname !== "/api/login") {
        return unauthorized();
      }

      if (!auth && (url.pathname === "/" || url.pathname.startsWith("/c/"))) {
        return Response.redirect(new URL("/login", url), 302);
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login" || url.pathname.startsWith("/c/"))) {
        return htmlPage();
      }

      if (url.pathname === "/api/login" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const username = sanitizeText(body?.username);
        const password = sanitizeText(body?.password);
        const row = userByUsername.get(username) as { id: number; username: string; password_hash: string } | null;
        if (!row) return unauthorized();

        const isValid = await Bun.password.verify(password, row.password_hash);
        if (!isValid) return unauthorized();

        const token = randomUUID();
        db.query("INSERT INTO sessions(token, user_id, expires_at) VALUES (?1, ?2, datetime('now', '+7 days'))").run(token, row.id);
        const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
        headers.append("set-cookie", `sid=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
        recordEvent(null, "auth.login", { userId: row.id, username: row.username });
        return new Response(JSON.stringify({ ok: true, username: row.username }), { headers });
      }

      if (url.pathname === "/api/logout" && req.method === "POST") {
        if (auth) {
          db.query("DELETE FROM sessions WHERE token = ?1").run(auth.token);
          recordEvent(null, "auth.logout", { userId: auth.user.id });
        }
        const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
        headers.append("set-cookie", "sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (url.pathname === "/api/me" && req.method === "GET") {
        if (!auth) return unauthorized();
        return json({ id: auth.user.id, username: auth.user.username });
      }

      if (!auth) {
        return unauthorized();
      }

      if (url.pathname === "/api/conversations" && req.method === "GET") {
        const rows = db
          .query(
            `SELECT c.id, c.title, c.archived, c.updated_at,
                    (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_message
             FROM conversations c
             WHERE c.user_id = ?1
             ORDER BY c.updated_at DESC`
          )
          .all(auth.user.id);
        return json(rows);
      }

      if (url.pathname === "/api/conversations" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const title = sanitizeText(body?.title) || "Nouvelle conversation";
        const created = db
          .query(
            `INSERT INTO conversations(user_id, title) VALUES (?1, ?2)
             RETURNING id, user_id, title, archived, created_at, updated_at`
          )
          .get(auth.user.id, title);
        const conv = created as { id: number; user_id: number; title: string; archived: number };
        recordEvent(conv.id, "conversation.created", { userId: auth.user.id, title: conv.title });
        return json(created, 201);
      }

      const convMatch = url.pathname.match(/^\/api\/conversations\/(\d+)$/);
      if (convMatch) {
        const conversationId = Number(convMatch[1]);
        const owned = db
          .query("SELECT id, archived FROM conversations WHERE id = ?1 AND user_id = ?2")
          .get(conversationId, auth.user.id) as { id: number; archived: number } | null;
        if (!owned) return notFound();

        if (req.method === "DELETE") {
          db.query("DELETE FROM conversations WHERE id = ?1").run(conversationId);
          recordEvent(conversationId, "conversation.deleted", { userId: auth.user.id });
          return json({ ok: true });
        }

        if (req.method === "PATCH") {
          const body = await req.json().catch(() => ({}));
          const archived = body?.archived ? 1 : 0;
          db.query("UPDATE conversations SET archived = ?1, updated_at = datetime('now') WHERE id = ?2").run(archived, conversationId);
          recordEvent(conversationId, archived ? "conversation.archived" : "conversation.unarchived", {
            userId: auth.user.id
          });
          return json({ ok: true, archived: !!archived });
        }
      }

      const messagesMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/messages$/);
      if (messagesMatch && req.method === "GET") {
        const conversationId = Number(messagesMatch[1]);
        const owned = db
          .query("SELECT id FROM conversations WHERE id = ?1 AND user_id = ?2")
          .get(conversationId, auth.user.id);
        if (!owned) return notFound();
        const rows = db
          .query("SELECT id, role, content, status, created_at FROM messages WHERE conversation_id = ?1 ORDER BY id ASC")
          .all(conversationId);
        return json(rows);
      }

      if (messagesMatch && req.method === "POST") {
        const conversationId = Number(messagesMatch[1]);
        const conversation = db
          .query("SELECT id, archived FROM conversations WHERE id = ?1 AND user_id = ?2")
          .get(conversationId, auth.user.id) as { id: number; archived: number } | null;
        if (!conversation) return notFound();
        if (conversation.archived) return json({ error: "Conversation archived" }, 400);

        const body = await req.json().catch(() => ({}));
        const content = sanitizeText(body?.content);
        if (!content) return json({ error: "Message content is required" }, 400);

        const userMessage = db
          .query(
            `INSERT INTO messages(conversation_id, role, content, status)
             VALUES (?1, 'user', ?2, 'done')
             RETURNING id, created_at`
          )
          .get(conversationId, content) as { id: number; created_at: string };

        db.query("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1").run(conversationId);
        recordEvent(conversationId, "user.message.created", { messageId: userMessage.id, content });

        const assistantMessage = db
          .query(
            `INSERT INTO messages(conversation_id, role, content, status)
             VALUES (?1, 'assistant', '', 'streaming')
             RETURNING id`
          )
          .get(conversationId) as { id: number };
        recordEvent(conversationId, "assistant.message.started", { messageId: assistantMessage.id });

        queueMicrotask(() => {
          streamAssistantReply(conversationId, assistantMessage.id, auth.user.id).catch((error) => {
            const message = error instanceof Error ? error.message : "Unknown error";
            db.query("UPDATE messages SET status = 'error' WHERE id = ?1").run(assistantMessage.id);
            recordEvent(conversationId, "assistant.message.error", { messageId: assistantMessage.id, error: message });
          });
        });

        return json({ ok: true, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id }, 202);
      }

      const eventsMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/events$/);
      if (eventsMatch && req.method === "GET") {
        const conversationId = Number(eventsMatch[1]);
        const owned = db
          .query("SELECT id FROM conversations WHERE id = ?1 AND user_id = ?2")
          .get(conversationId, auth.user.id);
        if (!owned) return notFound();
        const afterId = Number(url.searchParams.get("afterId") ?? "0") || 0;
        const rows = db
          .query(
            `SELECT id, conversation_id, event_type, payload_json, created_at
             FROM events
             WHERE conversation_id = ?1 AND id > ?2
             ORDER BY id ASC`
          )
          .all(conversationId, afterId) as Array<{
            id: number;
            conversation_id: number | null;
            event_type: string;
            payload_json: string;
            created_at: string;
          }>;
        return json(
          rows.map((row) => ({
            id: row.id,
            conversationId: row.conversation_id,
            eventType: row.event_type,
            payload: JSON.parse(row.payload_json),
            createdAt: row.created_at
          }))
        );
      }

      const streamMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/stream$/);
      if (streamMatch && req.method === "GET") {
        const conversationId = Number(streamMatch[1]);
        const owned = db
          .query("SELECT id FROM conversations WHERE id = ?1 AND user_id = ?2")
          .get(conversationId, auth.user.id);
        if (!owned) return notFound();

        let streamController: ReadableStreamDefaultController<string> | null = null;
        const stream = new ReadableStream<string>({
          start(controller) {
            streamController = controller;
            controller.enqueue(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
            hub.subscribe(conversationId, controller);
          },
          cancel(_reason) {
            if (streamController) {
              hub.unsubscribe(conversationId, streamController);
              streamController = null;
            }
          }
        });

        return new Response(stream.pipeThrough(new TextEncoderStream()), {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
          }
        });
      }

      return notFound();
    }
  });

  return {
    server,
    db,
    stop() {
      server.stop(true);
      db.close();
    }
  };
}

if (import.meta.main) {
  const config = getConfig();
  const app = await createApp({ config });
  console.log(`aiktivist listening on http://localhost:${app.server.port}`);
}
