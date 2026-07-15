#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");

function usage() {
  console.error("Usage: node bin/tasclang.js compile <file.tasc>");
  process.exit(1);
}

function tokenize(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (source.startsWith("->", i)) {
      tokens.push({ type: "arrow", value: "->" });
      i += 2;
      continue;
    }

    if ("{}()".includes(ch)) {
      tokens.push({ type: ch, value: ch });
      i += 1;
      continue;
    }

    if (ch === '"') {
      let value = "";
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) {
          value += source[i + 1];
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (source[i] !== '"') {
        throw new Error("Unterminated string literal");
      }
      i += 1;
      tokens.push({ type: "string", value });
      continue;
    }

    const match = source.slice(i).match(/^[A-Za-z0-9_.:-]+/);
    if (!match) {
      throw new Error(`Unexpected character '${ch}' at offset ${i}`);
    }
    tokens.push({ type: "word", value: match[0] });
    i += match[0].length;
  }

  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  take(expectedValue) {
    const token = this.tokens[this.pos];
    if (!token) {
      throw new Error(`Expected ${expectedValue}, reached end of input`);
    }
    if (expectedValue && token.value !== expectedValue) {
      throw new Error(`Expected ${expectedValue}, got ${token.value}`);
    }
    this.pos += 1;
    return token;
  }

  takeWord(label) {
    const token = this.take();
    if (token.type !== "word" && token.type !== "string") {
      throw new Error(`Expected ${label || "word"}, got ${token.value}`);
    }
    return token.value;
  }

  parseTask() {
    this.take("tasc");
    const name = this.takeWord("task name");
    this.take("{");

    const task = {
      kind: "tasc.task",
      version: "0.1",
      name,
      reward: null,
      deadline: null,
      inputs: [],
      outputs: [],
      verify: [],
      payout: [],
    };

    while (this.peek() && this.peek().value !== "}") {
      const key = this.takeWord("section");
      if (key === "version") {
        task.version = this.takeWord("version");
      } else if (key === "reward") {
        task.reward = this.parseReward();
      } else if (key === "deadline") {
        task.deadline = this.parseDeadline();
      } else if (key === "input") {
        task.inputs.push(this.parseField());
      } else if (key === "output") {
        task.outputs.push(this.parseField());
      } else if (key === "verify") {
        task.verify = this.parseVerifyBlock();
      } else if (key === "payout") {
        task.payout = this.parsePayoutBlock();
      } else {
        throw new Error(`Unknown task section '${key}'`);
      }
    }

    this.take("}");
    this.assertComplete();
    this.validateTask(task);
    return task;
  }

  parseReward() {
    const amount = this.takeWord("reward amount");
    const currency = this.takeWord("reward currency");
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      throw new Error(`Invalid reward amount '${amount}'`);
    }
    return { amount, currency };
  }

  parseDeadline() {
    const raw = this.takeWord("deadline");
    const match = raw.match(/^(\d+)(ms|s|m|h)$/);
    if (!match) {
      throw new Error(`Invalid deadline '${raw}'. Use units: ms, s, m, h`);
    }
    const value = Number(match[1]);
    const unit = match[2];
    const multipliers = { ms: 0.001, s: 1, m: 60, h: 3600 };
    return { raw, seconds: value * multipliers[unit] };
  }

  parseField() {
    const name = this.takeWord("field name");
    const type = this.takeWord("field type");
    return { name, type };
  }

  parseVerifyBlock() {
    this.take("{");
    const rules = [];
    while (this.peek() && this.peek().value !== "}") {
      const op = this.takeWord("verify operation");
      const args = [];
      while (this.peek() && !["}", "pass", "timeout", "dispute"].includes(this.peek().value)) {
        const maybeNext = this.peek();
        if (maybeNext.value === "->") break;
        args.push(this.takeWord("verify argument"));
        if (this.peek() && this.looksLikeVerifyOp(this.peek().value)) break;
      }
      rules.push({ op, args });
    }
    this.take("}");
    return rules;
  }

  looksLikeVerifyOp(value) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  }

  parsePayoutBlock() {
    this.take("{");
    const rules = [];
    while (this.peek() && this.peek().value !== "}") {
      const event = this.takeWord("payout event");
      this.take("->");
      const destination = this.takeWord("payout destination");
      let count = null;
      if (this.peek() && this.peek().value === "(") {
        this.take("(");
        count = Number(this.takeWord("destination count"));
        this.take(")");
      }
      const rule = { event, destination };
      if (count !== null) rule.count = count;
      rules.push(rule);
    }
    this.take("}");
    return rules;
  }

  validateTask(task) {
    if (!task.reward) throw new Error("Missing reward");
    if (!task.deadline) throw new Error("Missing deadline");
    if (task.inputs.length === 0) throw new Error("At least one input is required");
    if (task.outputs.length === 0) throw new Error("At least one output is required");
    if (task.verify.length === 0) throw new Error("At least one verify rule is required");
    if (task.payout.length === 0) throw new Error("At least one payout rule is required");
  }

  assertComplete() {
    if (this.pos !== this.tokens.length) {
      throw new Error(`Unexpected trailing token '${this.tokens[this.pos].value}'`);
    }
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compile(source) {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  const task = parser.parseTask();
  const canonical = canonicalize(task);
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return {
    task,
    canonical,
    task_hash: `sha256:${hash}`,
  };
}

function main() {
  const [command, file] = process.argv.slice(2);
  if (command !== "compile" || !file) usage();

  const source = fs.readFileSync(file, "utf8");
  const result = compile(source);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tasclang: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { tokenize, compile, canonicalize };
