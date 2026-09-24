import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "http";
import net from "net";
import { WebSocket } from "ws";
import express from "express";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { setupWsProxy } from "../src/services/wsProxy.js";

let httpServer: Server | null = null;
let serverPort: number;

async function startServer() {
  const app = express();
  httpServer = createServer(app);
  setupWsProxy(httpServer);

  await new Promise<void>((resolve) => {
    httpServer!.listen(0, () => {
      serverPort = (httpServer!.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

async function stopServer() {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("Wisp Proxy", () => {
  afterEach(async () => {
    await stopServer();
  });

  it("should accept WebSocket connections on /wisp/ path", async () => {
    await startServer();

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/wisp/`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  it("should reject connections on non-wisp paths", async () => {
    await startServer();

    const ws = new WebSocket(
      `ws://127.0.0.1:${serverPort}/proxy?host=buy.itunes.apple.com&port=443`,
    );

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("close", () => resolve(true));
      ws.on("open", () => {
        ws.close();
        resolve(false);
      });
    });

    expect(rejected).toBe(true);
  });

  it("should reject connections on random paths", async () => {
    await startServer();

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/other`);

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("close", () => resolve(true));
      ws.on("open", () => {
        ws.close();
        resolve(false);
      });
    });

    expect(rejected).toBe(true);
  });

  it("should allow only the Apple hosts the client protocol needs", () => {
    const whitelist = wisp.options.hostname_whitelist as RegExp[];
    const allowed = (host: string) => whitelist.some((re) => re.test(host));

    expect(allowed("p18-buy.itunes.apple.com")).toBe(true);
    expect(allowed("downloaddispatch.itunes.apple.com")).toBe(true);
    expect(allowed("uclient-api.itunes.apple.com")).toBe(true);
    expect(allowed("evil-uclient-api.itunes.apple.com")).toBe(false);
    expect(allowed("uclient-api.itunes.apple.com.example.com")).toBe(false);
    expect(allowed("apps.apple.com")).toBe(false);
  });
});
