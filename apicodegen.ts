#!/usr/bin/env -S node
/**
 * Turn an OpenAPI spec into typed fetch functions with narrowed response types.
 *
 *   node apicodegen.ts openapi.json --out client.ts
 *   node apicodegen.ts --demo
 *
 * One function per operation, named from operationId (or synthesised from method
 * + path when it's missing), with a parameter object for path/query params and
 * body, and a return type built from the 2xx response schema — so calling code
 * gets real autocomplete instead of `any`. Path parameters are substituted with a
 * template literal at call time; nothing here reaches for a routing library.
 */

import * as fs from "node:fs";
import * as http from "node:http";

interface OpenAPISchema {
  type?: string;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  items?: OpenAPISchema;
  enum?: unknown[];
  $ref?: string;
  format?: string;
  nullable?: boolean;
}

interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema: OpenAPISchema;
}

interface Operation {
  operationId?: string;
  summary?: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema: OpenAPISchema }>; required?: boolean };
  responses?: Record<string, { content?: Record<string, { schema: OpenAPISchema }> }>;
}

interface OpenAPISpec {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, OpenAPISchema> };
}

function resolveSchemaRef(schema: OpenAPISchema, spec: OpenAPISpec): OpenAPISchema {
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    const resolved = spec.components?.schemas?.[name];
    if (!resolved) throw new Error(`cannot resolve $ref ${schema.$ref}`);
    return resolved;
  }
  return schema;
}

function tsType(schema: OpenAPISchema, spec: OpenAPISpec): string {
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    return name;
  }
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  const nullable = schema.nullable ? " | null" : "";
  switch (schema.type) {
    case "string":
      return "string" + nullable;
    case "integer":
    case "number":
      return "number" + nullable;
    case "boolean":
      return "boolean" + nullable;
    case "array":
      return `${schema.items ? tsType(schema.items, spec) : "unknown"}[]${nullable}`;
    case "object": {
      if (!schema.properties) return "Record<string, unknown>" + nullable;
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties)
        .map(([key, propSchema]) => `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${tsType(propSchema, spec)}`)
        .join("; ");
      return `{ ${fields} }${nullable}`;
    }
    default:
      return "unknown" + nullable;
  }
}

function operationName(method: string, urlPath: string, op: Operation): string {
  if (op.operationId) return op.operationId;
  // synthesise from the path: GET /users/{id}/posts -> getUsersByIdPosts
  const segments = urlPath
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") ? "By" + seg.slice(1, -1)[0].toUpperCase() + seg.slice(2, -1) : seg[0].toUpperCase() + seg.slice(1)));
  return method.toLowerCase() + segments.join("");
}

function successResponseSchema(op: Operation, spec: OpenAPISpec): OpenAPISchema | null {
  if (!op.responses) return null;
  const successCode = Object.keys(op.responses).find((code) => code.startsWith("2"));
  if (!successCode) return null;
  const content = op.responses[successCode].content;
  const json = content?.["application/json"];
  return json ? json.schema : null;
}

interface GeneratedOperation {
  name: string;
  method: string;
  path: string;
  code: string;
}

function generateClient(spec: OpenAPISpec, baseUrlExpr = "baseUrl"): { header: string; types: string; functions: GeneratedOperation[] } {
  const functions: GeneratedOperation[] = [];

  for (const [urlPath, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const name = operationName(method, urlPath, op);
      const pathParams = (op.parameters ?? []).filter((p) => p.in === "path");
      const queryParams = (op.parameters ?? []).filter((p) => p.in === "query");
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      const responseSchema = successResponseSchema(op, spec);
      const returnType = responseSchema ? tsType(responseSchema, spec) : "void";

      const argFields: string[] = [];
      for (const p of pathParams) argFields.push(`${p.name}: ${tsType(p.schema, spec)}`);
      for (const p of queryParams) argFields.push(`${p.name}${p.required ? "" : "?"}: ${tsType(p.schema, spec)}`);
      if (bodySchema) argFields.push(`body: ${tsType(bodySchema, spec)}`);
      const argsType = argFields.length ? `{ ${argFields.join("; ")} }` : null;

      let urlExpr = urlPath;
      for (const p of pathParams) urlExpr = urlExpr.replace(`{${p.name}}`, `\${encodeURIComponent(String(args.${p.name}))}`);

      const queryLines =
        queryParams.length > 0
          ? `  const query = new URLSearchParams();\n${queryParams
              .map((p) => `  if (args.${p.name} !== undefined) query.set(${JSON.stringify(p.name)}, String(args.${p.name}));`)
              .join("\n")}\n  const qs = query.toString();\n`
          : "";
      const urlLine = queryParams.length > 0 ? `\`${urlExpr}\${qs ? "?" + qs : ""}\`` : `\`${urlExpr}\``;

      const fetchOptions: string[] = [`method: ${JSON.stringify(method.toUpperCase())}`];
      if (bodySchema) {
        fetchOptions.push(`headers: { "Content-Type": "application/json" }`);
        fetchOptions.push(`body: JSON.stringify(args.body)`);
      }

      const summary = op.summary ? `/** ${op.summary} */\n` : "";
      const params = argsType ? `args: ${argsType}` : "";
      const finalUrl = queryParams.length > 0 ? `\`\${${baseUrlExpr}}${urlExpr}\${qs ? "?" + qs : ""}\`` : `\`\${${baseUrlExpr}}${urlExpr}\``;
      const finalCode = `${summary}export async function ${name}(${params}): Promise<${returnType}> {
${queryLines}  const response = await fetch(${finalUrl}, {
    ${fetchOptions.join(",\n    ")},
  });
  if (!response.ok) throw new Error(\`${name} failed: \${response.status} \${response.statusText}\`);
  ${returnType === "void" ? "return;" : `return (await response.json()) as ${returnType};`}
}`;

      functions.push({ name, method: method.toUpperCase(), path: urlPath, code: finalCode });
    }
  }

  const typeDefs = Object.entries(spec.components?.schemas ?? {}).map(([name, schema]) => `export type ${name} = ${tsType(schema, spec)};`);

  return {
    header: `// Generated from an OpenAPI spec. Do not edit by hand — regenerate instead.\n\nexport interface RequestOptions {\n  baseUrl: string;\n}\n`,
    types: typeDefs.join("\n"),
    functions,
  };
}

function renderClient(spec: OpenAPISpec): string {
  const { header, types, functions } = generateClient(spec);
  return [header, types, "", functions.map((f) => f.code).join("\n\n")].filter(Boolean).join("\n");
}

// ------------------------------------------------------------ demo

const SAMPLE_SPEC: OpenAPISpec = {
  components: {
    schemas: {
      User: {
        type: "object",
        required: ["id", "email"],
        properties: {
          id: { type: "string" },
          email: { type: "string", format: "email" },
          name: { type: "string" },
          role: { type: "string", enum: ["admin", "member"] },
        },
      },
    },
  },
  paths: {
    "/users": {
      get: {
        operationId: "listUsers",
        summary: "List all users, optionally filtered by role",
        parameters: [{ name: "role", in: "query", schema: { type: "string" } }],
        responses: { "200": { content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/User" } } } } } },
      },
      post: {
        operationId: "createUser",
        summary: "Create a new user",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
        responses: { "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
      },
    },
    "/users/{id}": {
      get: {
        operationId: "getUser",
        summary: "Get one user by id",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
      },
      delete: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": {} },
      },
    },
  },
};

function demo(): void {
  console.log("input: an OpenAPI spec with 4 operations across 2 paths\n");
  const client = renderClient(SAMPLE_SPEC);
  console.log(client);

  console.log("\n\n--- does the generated client actually run against a real fetch? ---\n");
  runtimeCheck();
}

async function runtimeCheck(): Promise<void> {
  const users = new Map<string, { id: string; email: string; name: string; role: string }>([
    ["1", { id: "1", email: "ana@example.com", name: "Ana", role: "admin" }],
  ]);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (req.method === "GET" && url.pathname === "/users") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([...users.values()]));
    } else if (req.method === "GET" && /^\/users\/\w+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[2];
      const user = users.get(id);
      if (user) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(user));
      } else {
        res.writeHead(404).end();
      }
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  // evaluate the generated code (minus type annotations, which are meaningless at runtime)
  const generated = generateClient(SAMPLE_SPEC);
  const runnable = generated.functions.map((f) => f.code).join("\n\n");
  const stripped = runnable
    .replace(/^export\s+/gm, "") // `new Function` bodies can't contain module-level `export`
    .replace(/: Promise<[^>]+>/g, "")
    .replace(/args: \{[^}]+\}/g, "args")
    .replace(/\bas [A-Za-z_][\w<>\[\], ]*;/g, ";");

  const module_ = { exports: {} as Record<string, (...args: unknown[]) => unknown> };
  const factory = new Function("module", "exports", "fetch", "baseUrl", `${stripped}\nmodule.exports = { ${generated.functions.map((f) => f.name).join(", ")} };`);
  factory(module_, module_.exports, fetch, baseUrl);

  const listUsers = module_.exports.listUsers as (args?: { role?: string }) => Promise<unknown[]>;
  const getUser = module_.exports.getUser as (args: { id: string }) => Promise<unknown>;

  const list = await listUsers({});
  console.log(`  listUsers() -> ${JSON.stringify(list)}`);
  const one = await getUser({ id: "1" });
  console.log(`  getUser({id: "1"}) -> ${JSON.stringify(one)}`);
  console.log("\n  the generated fetch call, path substitution, and JSON parsing all work end to end");

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const spec = JSON.parse(fs.readFileSync(args[0], "utf8")) as OpenAPISpec;
  const client = renderClient(spec);
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0) {
    fs.writeFileSync(args[outIdx + 1], client);
    console.log(`wrote ${args[outIdx + 1]}`);
  } else {
    console.log(client);
  }
}

main();
