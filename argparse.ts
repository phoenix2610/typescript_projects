#!/usr/bin/env -S node
/**
 * A CLI argument parser: subcommands, typed flags, generated help, useful errors on typos.
 *
 *   node argparse.ts --demo
 *
 * The design choice that makes this pleasant to use: flags are declared with a
 * type (string | number | boolean | array) and parsing coerces to that type or
 * fails loudly — a caller never gets a string where they expected a number.
 * Unknown flags suggest the nearest known one (edit distance), because "did you
 * mean --output?" is worth more than a generic "unknown flag: --outptu".
 */

type FlagType = "string" | "number" | "boolean" | "array";

interface FlagSpec {
  name: string;
  alias?: string;
  type: FlagType;
  description: string;
  default?: unknown;
  required?: boolean;
  choices?: string[];
}

interface PositionalSpec {
  name: string;
  description: string;
  variadic?: boolean;
  required?: boolean;
}

interface CommandSpec {
  name: string;
  description: string;
  flags: FlagSpec[];
  positionals: PositionalSpec[];
  action: (args: ParsedArgs) => void;
}

interface ParsedArgs {
  [key: string]: unknown;
  _: string[];
}

class ArgError extends Error {}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function coerce(type: FlagType, raw: string, flagName: string): unknown {
  if (type === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new ArgError(`--${flagName} expects a number, got ${JSON.stringify(raw)}`);
    return n;
  }
  if (type === "boolean") {
    if (raw === "true" || raw === "1" || raw === "") return true;
    if (raw === "false" || raw === "0") return false;
    throw new ArgError(`--${flagName} expects true/false, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

class CLI {
  private commands = new Map<string, CommandSpec>();
  private globalFlags: FlagSpec[] = [
    { name: "help", alias: "h", type: "boolean", description: "show help" },
  ];
  private programName: string;
  private description: string;

  constructor(programName: string, description: string) {
    this.programName = programName;
    this.description = description;
  }

  command(spec: CommandSpec): this {
    this.commands.set(spec.name, spec);
    return this;
  }

  private findFlag(flags: FlagSpec[], token: string): FlagSpec | undefined {
    return flags.find((f) => f.name === token || f.alias === token);
  }

  private suggest(flags: FlagSpec[], token: string): string | null {
    let best: { name: string; dist: number } | null = null;
    for (const f of flags) {
      const dist = levenshtein(token, f.name);
      if (dist <= 2 && (!best || dist < best.dist)) best = { name: f.name, dist };
    }
    return best?.name ?? null;
  }

  parse(argv: string[]): { command: CommandSpec | null; args: ParsedArgs } {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      this.printHelp();
      return { command: null, args: { _: [] } };
    }

    const commandName = argv[0];
    const spec = this.commands.get(commandName);
    if (!spec) {
      const known = [...this.commands.keys()];
      let best: { name: string; dist: number } | null = null;
      for (const name of known) {
        const dist = levenshtein(commandName, name);
        if (dist <= 2 && (!best || dist < best.dist)) best = { name, dist };
      }
      throw new ArgError(
        `unknown command ${JSON.stringify(commandName)}` + (best ? ` — did you mean "${best.name}"?` : ""),
      );
    }

    const allFlags = [...spec.flags, ...this.globalFlags];
    const args: ParsedArgs = { _: [] };
    for (const f of spec.flags) if (f.default !== undefined) args[f.name] = f.default;

    const rest = argv.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === "--help" || token === "-h") {
        this.printCommandHelp(spec);
        return { command: null, args: { _: [] } };
      }
      if (token.startsWith("--") || (token.startsWith("-") && token.length === 2 && Number.isNaN(Number(token)))) {
        let name = token.replace(/^--?/, "");
        let inlineValue: string | undefined;
        const eq = name.indexOf("=");
        if (eq >= 0) {
          inlineValue = name.slice(eq + 1);
          name = name.slice(0, eq);
        }
        const flag = this.findFlag(allFlags, name);
        if (!flag) {
          const suggestion = this.suggest(allFlags, name);
          throw new ArgError(
            `unknown flag --${name}` + (suggestion ? ` — did you mean --${suggestion}?` : ""),
          );
        }
        if (flag.type === "boolean") {
          args[flag.name] = coerce("boolean", inlineValue ?? "true", flag.name);
          continue;
        }
        const raw = inlineValue ?? rest[++i];
        if (raw === undefined) throw new ArgError(`--${flag.name} requires a value`);
        if (flag.choices && !flag.choices.includes(raw)) {
          throw new ArgError(`--${flag.name} must be one of: ${flag.choices.join(", ")} (got ${JSON.stringify(raw)})`);
        }
        if (flag.type === "array") {
          const list = (args[flag.name] as string[]) ?? [];
          list.push(raw);
          args[flag.name] = list;
        } else {
          args[flag.name] = coerce(flag.type, raw, flag.name);
        }
      } else {
        args._.push(token);
      }
    }

    for (const flag of spec.flags) {
      if (flag.required && !(flag.name in args)) {
        throw new ArgError(`missing required flag --${flag.name}`);
      }
    }
    const requiredPositionals = spec.positionals.filter((p) => p.required);
    if (args._.length < requiredPositionals.length) {
      const missing = spec.positionals[args._.length];
      throw new ArgError(`missing required argument <${missing.name}>`);
    }

    return { command: spec, args };
  }

  run(argv: string[]): number {
    try {
      const { command, args } = this.parse(argv);
      if (command) command.action(args);
      return 0;
    } catch (err) {
      if (err instanceof ArgError) {
        console.error(`error: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  printHelp(): void {
    console.log(`${this.programName} — ${this.description}\n`);
    console.log("commands:");
    const width = Math.max(...[...this.commands.values()].map((c) => c.name.length));
    for (const cmd of this.commands.values()) {
      console.log(`  ${cmd.name.padEnd(width)}  ${cmd.description}`);
    }
    console.log(`\nrun "${this.programName} <command> --help" for command-specific help`);
  }

  printCommandHelp(spec: CommandSpec): void {
    const positionalUsage = spec.positionals
      .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`) + (p.variadic ? "..." : ""))
      .join(" ");
    console.log(`${this.programName} ${spec.name} ${positionalUsage} [flags]\n`);
    console.log(spec.description + "\n");
    if (spec.positionals.length) {
      console.log("arguments:");
      for (const p of spec.positionals) console.log(`  ${p.name.padEnd(14)}  ${p.description}`);
      console.log();
    }
    console.log("flags:");
    for (const f of [...spec.flags, ...this.globalFlags]) {
      const alias = f.alias ? `, -${f.alias}` : "";
      const def = f.default !== undefined ? `  (default: ${JSON.stringify(f.default)})` : "";
      const req = f.required ? "  (required)" : "";
      console.log(`  --${f.name}${alias}  <${f.type}>  ${f.description}${def}${req}`);
    }
  }
}

// ------------------------------------------------------------ demo

function demo(): void {
  const cli = new CLI("deploy", "a toy deploy tool used to exercise the parser");
  const calls: string[] = [];

  cli.command({
    name: "push",
    description: "push a build to an environment",
    positionals: [{ name: "target", description: "environment name", required: true }],
    flags: [
      { name: "env", alias: "e", type: "string", description: "environment", default: "staging", choices: ["staging", "production"] },
      { name: "replicas", alias: "r", type: "number", description: "replica count", default: 1 },
      { name: "dry-run", type: "boolean", description: "print without doing anything", default: false },
      { name: "tag", type: "array", description: "an image tag (repeatable)" },
    ],
    action: (args) => calls.push(`push ${args._[0]} env=${args.env} replicas=${args.replicas} dry=${args["dry-run"]} tags=${JSON.stringify(args.tag ?? [])}`),
  });

  cli.command({
    name: "rollback",
    description: "roll back the last deploy",
    positionals: [{ name: "steps", description: "how many releases to go back", required: false }],
    flags: [{ name: "force", alias: "f", type: "boolean", description: "skip confirmation", default: false }],
    action: (args) => calls.push(`rollback steps=${args._[0] ?? "1"} force=${args.force}`),
  });

  console.log("1. a normal invocation\n");
  console.log("$ deploy push prod --env production --replicas 3 --tag v1 --tag v2");
  cli.run(["push", "prod", "--env", "production", "--replicas", "3", "--tag", "v1", "--tag", "v2"]);
  console.log(`   -> ${calls.at(-1)}\n`);

  console.log("2. defaults fill in what was not passed\n");
  console.log("$ deploy push staging");
  cli.run(["push", "staging"]);
  console.log(`   -> ${calls.at(-1)}\n`);

  console.log("3. --flag=value form and boolean shorthand\n");
  console.log("$ deploy push edge --env=staging --dry-run");
  cli.run(["push", "edge", "--env=staging", "--dry-run"]);
  console.log(`   -> ${calls.at(-1)}\n`);

  console.log("4. type coercion failures are caught, not silently wrong\n");
  console.log("$ deploy push prod --replicas nope");
  console.log(`   exit code: ${cli.run(["push", "prod", "--replicas", "nope"])}\n`);

  console.log("5. an invalid choice is rejected with the allowed list\n");
  console.log("$ deploy push prod --env qa");
  console.log(`   exit code: ${cli.run(["push", "prod", "--env", "qa"])}\n`);

  console.log("6. a missing required argument is caught\n");
  console.log("$ deploy push");
  console.log(`   exit code: ${cli.run(["push"])}\n`);

  console.log("7. typo suggestions — for both commands and flags\n");
  console.log("$ deploy psh prod");
  console.log(`   exit code: ${cli.run(["psh", "prod"])}`);
  console.log("$ deploy push prod --envrionment production");
  console.log(`   exit code: ${cli.run(["push", "prod", "--envrionment", "production"])}\n`);

  console.log("8. generated help\n");
  cli.printCommandHelp((cli as unknown as { commands: Map<string, CommandSpec> }).commands.get("push")!);

  console.log(`\n${calls.length} successful invocations recorded`);
}

if (process.argv.includes("--demo") || process.argv.length <= 2) {
  demo();
}
