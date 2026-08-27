#!/usr/bin/env -S node
/**
 * Read a JSON Schema and emit TypeScript types plus a runtime validator.
 *
 *   node schema2ts.ts config.schema.json
 *   node schema2ts.ts --demo
 *
 * Types alone let bad data through at the boundary — a config loaded from a JSON
 * file has no compiler behind it. So this emits both halves from one schema: a
 * `type Config = ...` for compile-time checking of code that reads the config, and
 * a `validateConfig(data): Config` function that actually walks the value at
 * runtime and reports every problem it finds, not just the first one — a config
 * with three bad fields should tell you about all three in one run.
 */

import * as fs from "node:fs";

type JSONSchema = {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean | JSONSchema;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  default?: unknown;
  $ref?: string;
  definitions?: Record<string, JSONSchema>;
  title?: string;
};

function resolveRef(ref: string, root: JSONSchema): JSONSchema {
  const name = ref.replace("#/definitions/", "").replace("#/$defs/", "");
  const schema = root.definitions?.[name];
  if (!schema) throw new Error(`cannot resolve $ref ${ref}`);
  return schema;
}

function typeNameFor(schema: JSONSchema, root: JSONSchema, hint = "Value"): string {
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    return name[0].toUpperCase() + name.slice(1);
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map((s) => typeNameFor(s, root, hint)).join(" | ");
  if (schema.oneOf) return schema.oneOf.map((s) => typeNameFor(s, root, hint)).join(" | ");

  const type = Array.isArray(schema.type) ? schema.type : [schema.type];
  const parts = type.map((t) => {
    switch (t) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return `${schema.items ? typeNameFor(schema.items, root, hint) : "unknown"}[]`;
      case "object":
        return objectLiteral(schema, root);
      default:
        return "unknown";
    }
  });
  return parts.join(" | ");
}

function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : pad + line))
    .join("\n");
}

function objectLiteral(schema: JSONSchema, root: JSONSchema, depth = 1): string {
  if (!schema.properties) {
    if (!schema.additionalProperties) return "Record<string, never>";
    if (schema.additionalProperties === true) return "Record<string, unknown>";
    return `Record<string, ${typeNameFor(schema.additionalProperties, root)}>`;
  }
  const indent = "  ".repeat(depth);
  const closeIndent = "  ".repeat(depth - 1);
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties).map(([key, propSchema]) => {
    const optional = required.has(key) ? "" : "?";
    const comment = propSchema.description ? `${indent}/** ${propSchema.description} */\n` : "";
    const valueType = propSchema.type === "object" && propSchema.properties ? objectLiteral(propSchema, root, depth + 1) : typeNameFor(propSchema, root, key);
    return `${comment}${indent}${JSON.stringify(key)}${optional}: ${valueType};`;
  });
  return `{\n${fields.join("\n")}\n${closeIndent}}`;
}

function emitTypes(schema: JSONSchema, rootName = "Config"): string {
  const out: string[] = [];
  if (schema.definitions) {
    for (const [name, defSchema] of Object.entries(schema.definitions)) {
      const typeName = name[0].toUpperCase() + name.slice(1);
      out.push(`type ${typeName} = ${typeNameFor(defSchema, schema, name)};\n`);
    }
  }
  out.push(`type ${rootName} = ${typeNameFor(schema, schema, rootName)};`);
  return out.join("\n");
}

// ------------------------------------------------------------ validator

interface ValidationError {
  path: string;
  message: string;
}

function validateAgainst(schema: JSONSchema, value: unknown, root: JSONSchema, path: string, errors: ValidationError[]): void {
  if (schema.$ref) {
    validateAgainst(resolveRef(schema.$ref, root), value, root, path, errors);
    return;
  }
  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
    }
    return;
  }
  if (schema.enum) {
    if (!schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
      errors.push({ path, message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}` });
    }
    return;
  }
  if (schema.anyOf) {
    const subErrorSets = schema.anyOf.map((s) => {
      const sub: ValidationError[] = [];
      validateAgainst(s, value, root, path, sub);
      return sub;
    });
    if (subErrorSets.every((e) => e.length > 0)) {
      errors.push({ path, message: `matched none of ${schema.anyOf.length} allowed shapes` });
    }
    return;
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((t) => matchesType(value, t))) {
    errors.push({ path, message: `expected ${types.join(" | ")}, got ${describeType(value)}` });
    return;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `must be >= ${schema.minimum}, got ${value}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `must be <= ${schema.maximum}, got ${value}` });
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, message: `must match /${schema.pattern}/` });
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push({ path, message: "must be a valid email" });
    if (schema.format === "uri" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) errors.push({ path, message: "must be a valid URI" });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateAgainst(schema.items!, item, root, `${path}[${i}]`, errors));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push({ path: path ? `${path}.${key}` : key, message: "is required" });
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in (value as Record<string, unknown>)) {
        validateAgainst(propSchema, (value as Record<string, unknown>)[key], root, path ? `${path}.${key}` : key, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!(key in schema.properties)) errors.push({ path: path ? `${path}.${key}` : key, message: "is not a recognised property" });
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validate(schema: JSONSchema, value: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  validateAgainst(schema, value, schema, "", errors);
  return errors;
}

// ------------------------------------------------------------ demo

const SAMPLE_SCHEMA: JSONSchema = {
  title: "AppConfig",
  type: "object",
  required: ["port", "environment", "database"],
  properties: {
    port: { type: "integer", description: "TCP port to listen on", minimum: 1, maximum: 65535 },
    environment: { type: "string", enum: ["development", "staging", "production"] },
    logLevel: { type: "string", enum: ["debug", "info", "warn", "error"], default: "info" },
    database: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri", description: "connection string" },
        poolSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    admins: {
      type: "array",
      items: { type: "string", format: "email" },
    },
    featureFlags: {
      type: "object",
      additionalProperties: { type: "boolean" },
    },
  },
  additionalProperties: false,
};

function demo(): void {
  console.log("input JSON Schema:\n");
  console.log(JSON.stringify(SAMPLE_SCHEMA, null, 2).split("\n").slice(0, 8).join("\n") + "\n  ... (truncated)\n");

  console.log("=".repeat(70));
  console.log("generated TypeScript:");
  console.log("=".repeat(70) + "\n");
  console.log(emitTypes(SAMPLE_SCHEMA, "AppConfig"));

  console.log("\n" + "=".repeat(70));
  console.log("runtime validation");
  console.log("=".repeat(70) + "\n");

  const good = {
    port: 8080,
    environment: "production",
    logLevel: "warn",
    database: { url: "postgres://prod/app", poolSize: 20 },
    admins: ["ana@example.com", "bo@example.com"],
    featureFlags: { newCheckout: true },
  };
  console.log("valid config:");
  const errors1 = validate(SAMPLE_SCHEMA, good);
  console.log(`  ${errors1.length === 0 ? "valid — no errors" : errors1.length + " errors"}`);

  const bad = {
    port: 99999,
    environment: "prod", // not in the enum
    database: { poolSize: -5 }, // missing url, poolSize below minimum
    admins: ["not-an-email", "ok@example.com"],
    extraField: true, // additionalProperties: false
  };
  console.log("\ninvalid config (deliberately broken in several ways):");
  console.log("  " + JSON.stringify(bad));
  const errors2 = validate(SAMPLE_SCHEMA, bad);
  console.log(`\n  ${errors2.length} errors found, all at once:`);
  for (const err of errors2) {
    console.log(`    ${err.path || "(root)"}: ${err.message}`);
  }

  console.log("\nnote: every error is reported in one pass — a config with 5 problems");
  console.log("does not require 5 separate fix-and-rerun cycles to discover them all.");
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const schema = JSON.parse(fs.readFileSync(args[0], "utf8")) as JSONSchema;
  console.log(emitTypes(schema, schema.title ?? "Config"));
}

main();
