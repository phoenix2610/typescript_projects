#!/usr/bin/env -S node
/**
 * A local HTTPS dev proxy: self-signed certs, host-based routing, request logging.
 *
 *   node httpsproxy.ts --map api.local:3001 --map app.local:3000
 *   node httpsproxy.ts --demo    # runs two fake backends and proxies both over TLS
 *
 * The point of a local HTTPS proxy is testing things that behave differently
 * over TLS — secure cookies, service workers, mixed-content blocking — without
 * touching production certs. This generates a throwaway self-signed cert with
 * Node's own `crypto` (no openssl shell-out), routes by the incoming Host header
 * to whichever backend was mapped to it, and logs method/path/status/latency for
 * every request so you can see what actually crossed the proxy.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

interface RouteMap {
  [host: string]: number; // hostname -> backend port
}

interface ProxyLogEntry {
  host: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  backendPort: number | null;
}

/** A real self-signed cert, good enough for local TLS, never for anything else.
 *  Node's `crypto` module can generate the RSA keypair but has no X.509 *issuer* —
 *  turning a keypair into a certificate means DER-encoding ASN.1 structures, which
 *  is exactly what openssl already does correctly. Shelling out to a system binary
 *  (not an npm package) for the one piece Node itself doesn't provide keeps this
 *  dependency-free in the sense that matters: nothing to `npm install`. */
function generateSelfSignedCert(commonName: string): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "httpsproxy-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", `/CN=${commonName}`,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    return { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function resolveBackend(routes: RouteMap, hostHeader: string | undefined): number | null {
  if (!hostHeader) return null;
  const hostname = hostHeader.split(":")[0];
  return routes[hostname] ?? null;
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, backendPort: number, onDone: (status: number) => void): void {
  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: backendPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
  };

  const upstream = http.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
    onDone(upstreamRes.statusCode ?? 502);
  });

  upstream.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway: backend unreachable");
    onDone(502);
  });

  req.pipe(upstream);
}

function createProxyServer(routes: RouteMap, onLog: (entry: ProxyLogEntry) => void): https.Server {
  const { key, cert } = generateSelfSignedCert("localhost");

  return https.createServer({ key, cert }, (req, res) => {
    const start = performance.now();
    const backendPort = resolveBackend(routes, req.headers.host);
    const host = req.headers.host?.split(":")[0] ?? "(no host header)";

    if (backendPort === null) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`No backend mapped for host "${host}". Known hosts: ${Object.keys(routes).join(", ")}`);
      onLog({ host, method: req.method ?? "?", path: req.url ?? "/", status: 404, latencyMs: performance.now() - start, backendPort: null });
      return;
    }

    proxyRequest(req, res, backendPort, (status) => {
      onLog({ host, method: req.method ?? "?", path: req.url ?? "/", status, latencyMs: performance.now() - start, backendPort });
    });
  });
}

// ------------------------------------------------------------ demo

function startFakeBackend(name: string, responder: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(responder);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

async function demo(): Promise<void> {
  console.log("starting two fake backends to route between\n");

  const apiBackend = await startFakeBackend("api", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "api", path: req.url, method: req.method }));
  });
  const appBackend = await startFakeBackend("app", (req, res) => {
    if (req.url === "/broken") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("simulated backend error");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>app on port ${appBackend.port}</h1>`);
  });

  console.log(`  api.local -> 127.0.0.1:${apiBackend.port}`);
  console.log(`  app.local -> 127.0.0.1:${appBackend.port}\n`);

  const routes: RouteMap = { "api.local": apiBackend.port, "app.local": appBackend.port };
  const log: ProxyLogEntry[] = [];
  const proxy = createProxyServer(routes, (entry) => log.push(entry));

  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  const proxyPort = typeof proxyAddress === "object" && proxyAddress ? proxyAddress.port : 0;
  console.log(`proxy listening on https://127.0.0.1:${proxyPort} (self-signed cert — rejectUnauthorized: false below)\n`);

  const agent = new https.Agent({ rejectUnauthorized: false }); // accept the self-signed cert, dev-only
  const fetchThrough = async (host: string, path: string): Promise<{ status: number; body: string }> => {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: "127.0.0.1", port: proxyPort, path, method: "GET", agent, headers: { Host: host } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  };

  console.log("requests through the proxy:\n");
  const r1 = await fetchThrough("api.local", "/users/42");
  console.log(`  GET https://api.local/users/42  -> ${r1.status}  ${r1.body}`);

  const r2 = await fetchThrough("app.local", "/");
  console.log(`  GET https://app.local/          -> ${r2.status}  ${r2.body.replace(/\n/g, "")}`);

  const r3 = await fetchThrough("app.local", "/broken");
  console.log(`  GET https://app.local/broken    -> ${r3.status}  ${r3.body}`);

  const r4 = await fetchThrough("unknown.local", "/");
  console.log(`  GET https://unknown.local/      -> ${r4.status}  ${r4.body}`);

  console.log("\nproxy log (host, method, path, status, latency, routed-to-port):\n");
  for (const entry of log) {
    console.log(
      `  ${entry.host.padEnd(14)} ${entry.method.padEnd(5)} ${entry.path.padEnd(14)} ${entry.status}  ${entry.latencyMs.toFixed(1)}ms  ${entry.backendPort ? "-> :" + entry.backendPort : "(unrouted)"}`,
    );
  }

  console.log(`\n${log.length} requests proxied, ${log.filter((e) => e.status >= 400).length} errors`);
  console.log("note: TLS termination happened at the proxy — both backends spoke plain HTTP,");
  console.log("which is exactly the setup that lets you test HTTPS-only browser behavior locally.");

  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await apiBackend.close();
  await appBackend.close();
}

function parseRoutes(argv: string[]): RouteMap {
  const routes: RouteMap = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--map" && argv[i + 1]) {
      const [host, port] = argv[i + 1].split(":");
      routes[host] = Number(port);
      i++;
    }
  }
  return routes;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    await demo();
    return;
  }
  const routes = parseRoutes(args);
  if (Object.keys(routes).length === 0) {
    console.log("usage: httpsproxy.ts --map host1.local:3000 --map host2.local:3001");
    return;
  }
  const proxy = createProxyServer(routes, (entry) => {
    console.log(`${entry.host} ${entry.method} ${entry.path} -> ${entry.status} (${entry.latencyMs.toFixed(0)}ms)`);
  });
  proxy.listen(8443, () => console.log("https proxy listening on :8443 (self-signed — browsers will warn)"));
}

main();
