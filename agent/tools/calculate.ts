import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";

/**
 * An exact fraction. Money sums, shares, and percentages stay exact until the
 * answer is printed; only `sqrt` and a fractional power go through floating
 * point, and they mark the value as approximate.
 */
interface Rational {
  readonly approximate: boolean;
  readonly d: bigint;
  readonly n: bigint;
}

class CalculationError extends Error {}

/** Larger numerators or denominators are refused instead of computed. */
const maximumBits = 4096;
const maximumDepth = 64;
const maximumTokens = 400;
/** Places printed for a fraction that does not end, such as 100 / 3. */
const printedPlaces = 10;

function bitLength(value: bigint) {
  return (value < 0n ? -value : value).toString(2).length;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function rational(n: bigint, d = 1n, approximate = false): Rational {
  if (d === 0n) throw new CalculationError("Division by zero.");
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d) || 1n;
  const result = {
    approximate,
    d: (sign * d) / divisor,
    n: (sign * n) / divisor,
  };
  if (bitLength(result.n) > maximumBits || bitLength(result.d) > maximumBits) {
    throw new CalculationError("The number is too large to compute exactly.");
  }
  return result;
}

const one = rational(1n);
const hundred = rational(100n);

function add(a: Rational, b: Rational) {
  return rational(
    a.n * b.d + b.n * a.d,
    a.d * b.d,
    a.approximate || b.approximate
  );
}

function negate(a: Rational) {
  return rational(-a.n, a.d, a.approximate);
}

function multiply(a: Rational, b: Rational) {
  return rational(a.n * b.n, a.d * b.d, a.approximate || b.approximate);
}

function divide(a: Rational, b: Rational) {
  if (b.n === 0n) throw new CalculationError("Division by zero.");
  return rational(a.n * b.d, a.d * b.n, a.approximate || b.approximate);
}

/** Parses a plain decimal such as `12`, `0.5`, or `1.2e3` exactly. */
function parseDecimal(text: string, approximate = false) {
  const match = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/iu.exec(text);
  if (!match) throw new CalculationError(`Not a number: ${text}.`);
  const [, sign = "", whole = "", fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText) - fraction.length;
  if (Math.abs(exponent) > 400) {
    throw new CalculationError("The number is too large to compute exactly.");
  }
  const digits = BigInt(`${sign}${whole || "0"}${fraction}`);
  const scale = 10n ** BigInt(Math.abs(exponent));
  return exponent >= 0
    ? rational(digits * scale, 1n, approximate)
    : rational(digits, scale, approximate);
}

function toNumber(a: Rational) {
  const value = Number(a.n) / Number(a.d);
  if (!Number.isFinite(value)) {
    throw new CalculationError("The number is too large for this function.");
  }
  return value;
}

function fromNumber(value: number) {
  if (!Number.isFinite(value)) {
    throw new CalculationError("The result is not a finite number.");
  }
  return parseDecimal(value.toPrecision(15), true);
}

function isInteger(a: Rational) {
  return a.d === 1n;
}

type Rounding = "floor" | "ceil" | "half-up";

/**
 * The value times 10^places as a whole number, rounded by `mode`; half-up
 * rounds halves away from zero.
 */
function scaledInteger(a: Rational, places: number, mode: Rounding) {
  const scale = 10n ** BigInt(Math.abs(places));
  const numerator = places >= 0 ? a.n * scale : a.n;
  const denominator = places >= 0 ? a.d : a.d * scale;
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder !== 0n) {
    const negative = numerator < 0n;
    if (mode === "floor" && negative) quotient -= 1n;
    if (mode === "ceil" && !negative) quotient += 1n;
    if (mode === "half-up") {
      const twice = 2n * (remainder < 0n ? -remainder : remainder);
      if (twice >= denominator) quotient += negative ? -1n : 1n;
    }
  }
  return quotient;
}

/** Rounds to `places` decimal places; negative places round to tens and up. */
function roundTo(a: Rational, places: number, mode: Rounding) {
  const quotient = scaledInteger(a, places, mode);
  const scale = 10n ** BigInt(Math.abs(places));
  return places >= 0
    ? rational(quotient, scale, a.approximate)
    : rational(quotient * scale, 1n, a.approximate);
}

function power(base: Rational, exponent: Rational) {
  if (!isInteger(exponent)) {
    if (base.n < 0n) {
      throw new CalculationError(
        "A negative number has no real fractional power."
      );
    }
    return fromNumber(toNumber(base) ** toNumber(exponent));
  }
  const times = exponent.n < 0n ? -exponent.n : exponent.n;
  const bits = Math.max(bitLength(base.n), bitLength(base.d));
  if (times > 10_000n || BigInt(bits) * times > BigInt(maximumBits)) {
    throw new CalculationError("The number is too large to compute exactly.");
  }
  const raised = rational(base.n ** times, base.d ** times, base.approximate);
  return exponent.n < 0n ? divide(one, raised) : raised;
}

function wholeNumber(a: Rational, what: string) {
  if (!isInteger(a) || a.n < -12n || a.n > 12n) {
    throw new CalculationError(
      `${what} must be a whole number from -12 to 12.`
    );
  }
  return Number(a.n);
}

function rounding(mode: Rounding) {
  return (args: Rational[]) => {
    const [value, places] = args;
    if (!value || args.length > 2) {
      throw new CalculationError("Rounding takes a value and decimal places.");
    }
    return roundTo(
      value,
      places ? wholeNumber(places, "Decimal places") : 0,
      mode
    );
  };
}

function atLeastOne(name: string, args: Rational[]) {
  const [first, ...rest] = args;
  if (!first) throw new CalculationError(`${name} needs at least one value.`);
  return { first, rest };
}

function exactly(name: string, count: number, args: Rational[]) {
  if (args.length !== count) {
    throw new CalculationError(
      `${name} takes ${String(count)} value${count === 1 ? "" : "s"}.`
    );
  }
  return args;
}

function compare(a: Rational, b: Rational) {
  const difference = a.n * b.d - b.n * a.d;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

const functions = new Map<string, (args: Rational[]) => Rational>([
  [
    "abs",
    (args) => {
      const [value = one] = exactly("abs", 1, args);
      return value.n < 0n ? negate(value) : value;
    },
  ],
  ["ceil", rounding("ceil")],
  ["floor", rounding("floor")],
  [
    "max",
    (args) => {
      const { first, rest } = atLeastOne("max", args);
      return rest.reduce((a, b) => (compare(b, a) > 0 ? b : a), first);
    },
  ],
  [
    "min",
    (args) => {
      const { first, rest } = atLeastOne("min", args);
      return rest.reduce((a, b) => (compare(b, a) < 0 ? b : a), first);
    },
  ],
  [
    "pow",
    (args) => {
      const [base = one, exponent = one] = exactly("pow", 2, args);
      return power(base, exponent);
    },
  ],
  ["round", rounding("half-up")],
  [
    "sqrt",
    (args) => {
      const [value = one] = exactly("sqrt", 1, args);
      if (value.n < 0n) {
        throw new CalculationError("A negative number has no real root.");
      }
      return power(value, rational(1n, 2n));
    },
  ],
  [
    "sum",
    (args) => {
      const { first, rest } = atLeastOne("sum", args);
      return rest.reduce(add, first);
    },
  ],
]);

type Token =
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "symbol"; readonly text: string };

const symbolAliases = new Map([
  ["×", "*"],
  ["·", "*"],
  ["÷", "/"],
  ["−", "-"],
  ["**", "^"],
]);

/**
 * Splits one expression into tokens. A space followed by exactly three
 * digits continues the number, so «4 500» reads as 4500: two numbers side by
 * side are never a valid expression anyway.
 */
function tokenize(expression: string) {
  const tokens: Token[] = [];
  const pattern =
    /\s+|(\d+(?:[ \u00a0\u202f]\d{3}(?!\d))*(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?|[\p{L}_][\p{L}\p{N}_]*|\*\*|[-+*/^%(),×·÷−=]/giuy;
  while (pattern.lastIndex < expression.length) {
    const start = pattern.lastIndex;
    const match = pattern.exec(expression);
    if (!match) {
      throw new CalculationError(
        `Unexpected character «${expression.charAt(start)}» at position ${String(start + 1)}.`
      );
    }
    const [text] = match;
    if (/^\s+$/u.test(text)) continue;
    if (/^[\d.]/u.test(text)) {
      tokens.push({
        kind: "number",
        text: text.replace(/[ \u00a0\u202f]/gu, ""),
      });
    } else if (/^[\p{L}_]/u.test(text)) {
      tokens.push({ kind: "name", text });
    } else {
      tokens.push({ kind: "symbol", text: symbolAliases.get(text) ?? text });
    }
    if (tokens.length > maximumTokens) {
      throw new CalculationError("The expression is too long.");
    }
  }
  return tokens;
}

type Node =
  | { readonly kind: "value"; readonly value: Rational }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "percent"; readonly of: Node }
  | { readonly kind: "negate"; readonly of: Node }
  | {
      readonly kind: "binary";
      readonly left: Node;
      readonly operator: string;
      readonly right: Node;
    }
  | { readonly args: Node[]; readonly kind: "call"; readonly name: string };

/** A recursive-descent parser over the tokens; nothing is ever evaluated as code. */
function parse(tokens: Token[]) {
  let position = 0;
  let depth = 0;

  const peek = () => tokens[position];
  const isSymbol = (text: string) => {
    const token = peek();
    return token?.kind === "symbol" && token.text === text;
  };
  const expect = (text: string) => {
    if (!isSymbol(text)) {
      throw new CalculationError(`Expected «${text}».`);
    }
    position += 1;
  };
  const nested = <T>(parseInner: () => T) => {
    depth += 1;
    if (depth > maximumDepth) {
      throw new CalculationError("The expression is nested too deeply.");
    }
    const result = parseInner();
    depth -= 1;
    return result;
  };

  function additive(): Node {
    let left = multiplicative();
    while (isSymbol("+") || isSymbol("-")) {
      const operator = peek()?.text ?? "+";
      position += 1;
      left = { kind: "binary", left, operator, right: multiplicative() };
    }
    return left;
  }

  function multiplicative(): Node {
    let left = unary();
    while (isSymbol("*") || isSymbol("/")) {
      const operator = peek()?.text ?? "*";
      position += 1;
      left = { kind: "binary", left, operator, right: unary() };
    }
    return left;
  }

  function unary(): Node {
    return nested(() => {
      if (isSymbol("-")) {
        position += 1;
        return { kind: "negate", of: unary() };
      }
      if (isSymbol("+")) {
        position += 1;
        return unary();
      }
      const base = postfix();
      if (!isSymbol("^")) return base;
      position += 1;
      return { kind: "binary", left: base, operator: "^", right: unary() };
    });
  }

  function postfix(): Node {
    const node = primary();
    if (!isSymbol("%")) return node;
    position += 1;
    return { kind: "percent", of: node };
  }

  function primary(): Node {
    const token = peek();
    if (!token) throw new CalculationError("The expression ends too early.");
    position += 1;
    if (token.kind === "number") {
      return { kind: "value", value: parseDecimal(token.text) };
    }
    if (token.kind === "name") {
      if (!isSymbol("(")) return { kind: "variable", name: token.text };
      position += 1;
      const args: Node[] = [];
      if (!isSymbol(")")) {
        args.push(nested(additive));
        while (isSymbol(",")) {
          position += 1;
          args.push(nested(additive));
        }
      }
      expect(")");
      return { args, kind: "call", name: token.text.toLowerCase() };
    }
    if (token.text === "(") {
      const inner = nested(additive);
      expect(")");
      return inner;
    }
    throw new CalculationError(`Unexpected «${token.text}».`);
  }

  const node = additive();
  const rest = peek();
  if (rest) throw new CalculationError(`Unexpected «${rest.text}».`);
  return node;
}

function evaluate(
  node: Node,
  variables: ReadonlyMap<string, Rational>
): Rational {
  switch (node.kind) {
    case "value":
      return node.value;
    case "variable": {
      const value = variables.get(node.name.toLowerCase());
      if (!value) throw new CalculationError(`Unknown name «${node.name}».`);
      return value;
    }
    case "percent":
      return divide(evaluate(node.of, variables), hundred);
    case "negate":
      return negate(evaluate(node.of, variables));
    case "call": {
      const apply = functions.get(node.name);
      if (!apply)
        throw new CalculationError(`Unknown function «${node.name}».`);
      return apply(node.args.map((arg) => evaluate(arg, variables)));
    }
    case "binary": {
      const left = evaluate(node.left, variables);
      // «1200 + 15%» adds 15 % of 1200, as a calculator does.
      if (
        (node.operator === "+" || node.operator === "-") &&
        node.right.kind === "percent"
      ) {
        const share = evaluate(node.right, variables);
        return multiply(
          left,
          node.operator === "+" ? add(one, share) : add(one, negate(share))
        );
      }
      const right = evaluate(node.right, variables);
      if (node.operator === "+") return add(left, right);
      if (node.operator === "-") return add(left, negate(right));
      if (node.operator === "*") return multiply(left, right);
      if (node.operator === "/") return divide(left, right);
      return power(left, right);
    }
    default:
      throw new CalculationError("Unknown expression.");
  }
}

/**
 * Decimal places the fraction needs to be written exactly, or undefined when
 * it never ends: its denominator has a factor other than 2 and 5.
 */
function exactPlaces(a: Rational) {
  let d = a.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos += 1;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives += 1;
  }
  return d === 1n ? Math.max(twos, fives) : undefined;
}

function formatDecimal(a: Rational, places: number) {
  const scaled = scaledInteger(a, places, "half-up");
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled)
    .toString()
    .padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function describe(a: Rational) {
  const places = a.approximate ? undefined : exactPlaces(a);
  return places === undefined || places > 20
    ? { exact: false, value: formatDecimal(a, printedPlaces) }
    : { exact: true, value: formatDecimal(a, places) };
}

const lineSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("One expression, or `name = expression` to reuse its value below.");

/** Evaluates lines in order; a named line's value is visible to later lines. */
function calculateLines(lines: readonly string[]) {
  const variables = new Map<string, Rational>();
  return lines.map((line) => {
    const assignment = /^([\p{L}_][\p{L}\p{N}_]*)\s*=(?!=)\s*(.+)$/su.exec(
      line
    );
    const [, name, expression = line] = assignment ?? [];
    try {
      if (name && functions.has(name.toLowerCase())) {
        throw new CalculationError(`«${name}» is a function name.`);
      }
      const value = evaluate(parse(tokenize(expression)), variables);
      if (name) variables.set(name.toLowerCase(), value);
      return { expression: line, ...describe(value) };
    } catch (error) {
      if (!(error instanceof CalculationError)) throw error;
      return { error: error.message, expression: line };
    }
  });
}

export const calculate = defineTool({
  description:
    "Compute numbers exactly: totals, bill splits and tips, shares, discounts, taxes and deductions, interest, unit prices, currency conversion with a rate you looked up. Pass one or more lines in order. A line is an expression, or `name = expression` whose value later lines use by name. Operators + - * / ^ and parentheses; `15%` is 0.15, and `x + 15%` or `x - 15%` adds or takes off 15 % of x. Functions: round(x, places), floor(x, places), ceil(x, places), abs, min, max, sum, sqrt, pow. Arithmetic is exact; `exact: false` marks a value rounded to 10 places or computed by sqrt or a fractional power. Use a dot for decimals. A line that fails returns `error` and the others still compute.",
  inputSchema: z.object({
    lines: z.array(lineSchema).min(1).max(30),
  }),
  execute(input) {
    return { results: calculateLines(input.lines) };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { calculate },
        "scheduled-worker": { calculate },
      }),
  },
});
