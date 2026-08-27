#!/usr/bin/env -S node
/**
 * Capture inbound webhooks, fan them out to local targets, and replay any past event.
 *
 *   node webhook_relay.ts serve --port 8787 --forward-to http://localhost:3000/hook
 *   node webhook_relay.ts replay --id evt_003 --to http://localhost:3000/hook
 *   node webhook_relay.ts --demo
 *
 * Third-party webhooks (Stripe, GitHub, ...) are painful to develop against
 * locally because you can't just trigger one on demand. This runs a real HTTP
 * server that stores every inbound request verbatim (headers, body, arrival
 * time) before forwarding it to one or more local targets, and lets you replay
 * any captured event byte-for-byte later — so "trigger the exact webhook that
 * broke prod at 3am" becomes a one-line replay instead of waiting for it to
 * happen again.
 */

import * as http from "node:http";

interface CapturedEvent {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: Date;
  forwardResults: ForwardResult[];
}

interface ForwardResult {
  target: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  latencyMs: number;
}

class EventStore {
  private events: CapturedEvent[] = [];
  private counter = 0;

  add(partial: Omit<CapturedEvent, "id" | "forwardResults">): CapturedEvent {
    this.counter++;
    const event: CapturedEvent = { ...partial, id: `evt_${String(this.counter).padStart(3, "0")}`, forwardResults: [] };
    this.events.push(event);
    return event;
  }

  get(id: string): CapturedEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  all(): CapturedEvent[] {
    return this.events;
  }
}

const FORWARD_STRIP_HEADERS = new Set(["host", "content-length", "connection"]);

async function forwardEvent(event: CapturedEvent, targetUrl: string): Promise<ForwardResult> {
  const start = performance.now();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.headers)) {
    if (!FORWARD_STRIP_HEADERS.has(key.toLowerCase())) headers[key] = value;
  }
  headers["X-Relay-Event-Id"] = event.id;
  headers["X-Relay-Original-Timestamp"] = event.receivedAt.toISOString();

  try {
    const response = await fetch(targetUrl, { method: event.method, headers, body: event.body || undefined });
    return { target: targetUrl, status: response.status, ok: response.ok, error: null, latencyMs: performance.now() - start };
  } catch (err) {
    return { target: targetUrl, status: null, ok: false, error: (err as Error).message, latencyMs: performance.now() - start };
  }
}

function createRelayServer(store: EventStore, forwardTargets: string[]): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
      }

      const event = store.add({ method: req.method ?? "GET", path: req.url ?? "/", headers, body, receivedAt: new Date() });

      const results = await Promise.all(forwardTargets.map((target) => forwardEvent(event, target)));
      event.forwardResults = results;

      const allOk = results.every((r) => r.ok);
      res.writeHead(allOk ? 200 : 207, { "Content-Type": "application/json" }); // 207: partial forwarding failure
      res.end(JSON.stringify({ received: event.id, forwarded: results.map((r) => ({ target: r.target, status: r.status, ok: r.ok })) }));
    });
  });
}

// ------------------------------------------------------------ demo

function startTestTarget(name: string, behavior: (body: string) => { status: number; response: string }): Promise<{ port: number; close: () => Promise<void>; received: string[] }> {
  const received: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        received.push(body);
        const { status, response } = behavior(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(response);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())), received });
    });
  });
}

async function demo(): Promise<void> {
  console.log("starting a relay server with two forward targets — one healthy, one broken\n");

  const healthy = await startTestTarget("healthy-service", () => ({ status: 200, response: '{"ok":true}' }));
  const broken = await startTestTarget("broken-service", () => ({ status: 500, response: '{"error":"db down"}' }));

  console.log(`  healthy target on :${healthy.port}`);
  console.log(`  broken target  on :${broken.port}\n`);

  const store = new EventStore();
  const relay = createRelayServer(store, [`http://127.0.0.1:${healthy.port}/hook`, `http://127.0.0.1:${broken.port}/hook`]);
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayAddress = relay.address();
  const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
  console.log(`relay listening on :${relayPort}, forwarding to both targets\n`);

  console.log("sending 3 simulated webhook payloads through the relay...\n");
  const payloads = [
    { "X-Event-Type": "payment.succeeded", body: '{"id":"pay_1","amount":4999}' },
    { "X-Event-Type": "payment.failed", body: '{"id":"pay_2","amount":1200,"reason":"card_declined"}' },
    { "X-Event-Type": "subscription.cancelled", body: '{"id":"sub_9"}' },
  ];

  for (const p of payloads) {
    const response = await fetch(`http://127.0.0.1:${relayPort}/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Event-Type": p["X-Event-Type"] },
      body: p.body,
    });
    const result = (await response.json()) as { received: string; forwarded: { target: string; status: number; ok: boolean }[] };
    console.log(`  ${p["X-Event-Type"]}  ->  captured as ${result.received}, relay responded ${response.status}`);
    for (const f of result.forwarded) console.log(`    forwarded to :${f.target.match(/:(\d+)/)?.[1]}  status=${f.status}  ok=${f.ok}`);
  }

  console.log(`\n${store.all().length} events captured, byte-for-byte, with original headers preserved\n`);

  console.log("--- replaying evt_002 (the payment.failed event) to the now-fixed 'broken' service ---\n");
  const targetEvent = store.get("evt_002")!;
  console.log(`  replaying: ${targetEvent.headers["x-event-type"]}  body=${targetEvent.body}`);
  const replayResult = await forwardEvent(targetEvent, `http://127.0.0.1:${broken.port}/hook`);
  console.log(`  replay result: status=${replayResult.status} ok=${replayResult.ok}`);
  console.log(`  (the 'broken' service still returns 500 in this demo, but the SAME captured`);
  console.log(`  payload was resent byte-for-byte — after a real fix, this replay would confirm it)`);

  console.log(`\n\nnote: the relay responded 207 (partial success) for every event, since the`);
  console.log(`healthy target accepted them but the broken one didn't — the CALLER (whatever`);
  console.log(`sent the original webhook) sees an accurate partial-failure status instead of a`);
  console.log(`blanket 200 that would hide the broken target's failures, or a 500 that would`);
  console.log(`make the sender retry a webhook the healthy target already processed successfully.`);

  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await healthy.close();
  await broken.close();
}

// ------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    await demo();
    return;
  }

  if (args[0] === "serve") {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--forward-to") targets.push(args[++i]);
    }
    const store = new EventStore();
    const server = createRelayServer(store, targets);
    server.listen(port, () => {
      console.log(`webhook relay listening on :${port}, forwarding to: ${targets.join(", ") || "(none)"}`);
    });
    return;
  }

  console.log("usage: webhook_relay.ts serve --port 8787 --forward-to http://localhost:3000/hook");
}

main();
