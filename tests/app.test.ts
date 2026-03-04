import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server";

type Running = Awaited<ReturnType<typeof createApp>>;

type Client = {
  request(path: string, init?: RequestInit): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<any>;
};

function createClient(baseUrl: string): Client {
  let cookie = "";
  return {
    async request(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers || {});
      if (cookie) headers.set("cookie", cookie);
      const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return response;
    },
    async json(path: string, init?: RequestInit): Promise<any> {
      const response = await this.request(path, init);
      return response.json();
    }
  };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error("timeout waiting for condition");
}

let app: Running;
let mockAiServer: Bun.Server;
let fixtureDir: string;

beforeEach(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "aiktivist-"));

  mockAiServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/chat/completions") return new Response("not found", { status: 404 });
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
          controller.enqueue('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
          controller.enqueue("data: [DONE]\n\n");
          controller.close();
        }
      });
      return new Response(body.pipeThrough(new TextEncoderStream()), {
        headers: { "content-type": "text/event-stream" }
      });
    }
  });

  app = await createApp({
    config: {
      port: 0,
      dbPath: join(fixtureDir, "test.db"),
      logsPath: join(fixtureDir, "events.jsonl"),
      openrouterBaseUrl: `http://127.0.0.1:${mockAiServer.port}`,
      openrouterApiKey: "test-key",
      defaultModel: "google/gemini-3-flash-preview",
      adminUsername: "admin",
      adminPassword: "secret"
    }
  });
});

afterEach(() => {
  app.stop();
  mockAiServer.stop(true);
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("aiktivist application", () => {
  test("auth and protected routes", async () => {
    const client = createClient(`http://127.0.0.1:${app.server.port}`);

    const meBefore = await client.request("/api/me");
    expect(meBefore.status).toBe(401);

    const bad = await client.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "wrong" })
    });
    expect(bad.status).toBe(401);

    const good = await client.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "secret" })
    });
    expect(good.status).toBe(200);

    const meAfter = await client.request("/api/me");
    expect(meAfter.status).toBe(200);

    const root = await client.request("/");
    expect(root.status).toBe(200);
  });

  test("conversation routing, persistence, streaming and event logs", async () => {
    const client = createClient(`http://127.0.0.1:${app.server.port}`);

    await client.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "secret" })
    });

    const created = await client.json("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "test conversation" })
    });

    expect(created.id).toBeNumber();

    const routeView = await client.request(`/c/${created.id}`);
    expect(routeView.status).toBe(200);

    const postMessage = await client.request(`/api/conversations/${created.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Say hello" })
    });
    expect(postMessage.status).toBe(202);

    await waitFor(async () => {
      const messages = await client.json(`/api/conversations/${created.id}/messages`);
      return messages.some((m: any) => m.role === "assistant" && m.status === "done" && m.content === "hello world");
    });

    const events = await client.json(`/api/conversations/${created.id}/events`);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e: any) => e.eventType === "assistant.message.chunk")).toBeTrue();

    const logs = readFileSync(join(fixtureDir, "events.jsonl"), "utf-8");
    expect(logs).toContain("openrouter.request");
    expect(logs).toContain("assistant.message.completed");

    const archived = await client.json(`/api/conversations/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true })
    });
    expect(archived.archived).toBeTrue();

    const allConversations = await client.json("/api/conversations");
    expect(allConversations[0].archived).toBe(1);
  });
});
