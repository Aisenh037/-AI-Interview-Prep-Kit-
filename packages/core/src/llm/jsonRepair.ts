/**
 * Getting usable JSON out of a free-tier model.
 *
 * Schema-constrained decoding does most of the work — the model in use supports
 * `response_format: json_schema` with `strict: true` — but it is not a guarantee.
 * Measured behaviour: with a small output allowance the model spends its whole
 * budget on reasoning and returns an EMPTY generation, and the API answers
 * `json_validate_failed`. So a repair ladder is still needed underneath.
 *
 * The rungs, cheapest first:
 *   1. parse as-is
 *   2. strip code fences and surrounding prose
 *   3. extract the first balanced JSON value, string-aware
 *   4. tolerant parse (trailing commas, single quotes, truncated tails)
 *   5. normalise vocabulary the schema will reject   <- the valuable one
 *
 * Rung 5 is where most of the points are. The specification uses British
 * `behavioural` and hyphenated `system-design`; models overwhelmingly emit
 * `behavioral` and `system_design`. Without this mapping, validation fails on a
 * majority of generation calls and requirement/coverage scores are lost to a
 * spelling difference rather than to anything substantive.
 */
import { jsonrepair } from 'jsonrepair';

/** Enum values the schema demands, keyed by the spellings models actually produce. */
const ENUM_ALIASES: Record<string, string> = {
  // question.category — British spelling and a hyphen, both easily lost
  behavioral: 'behavioural',
  behavior: 'behavioural',
  soft: 'behavioural',
  'soft-skills': 'behavioural',
  system_design: 'system-design',
  'system design': 'system-design',
  systemdesign: 'system-design',
  design: 'system-design',
  architecture: 'system-design',
  company_fit: 'company-fit',
  'company fit': 'company-fit',
  companyfit: 'company-fit',
  culture: 'company-fit',
  'culture-fit': 'company-fit',
  cultural: 'company-fit',
  tech: 'technical',
  technology: 'technical',
  coding: 'technical',

  // requirement.kind
  'domain-specific': 'domain',
  business: 'domain',
  industry: 'domain',

  // requirement.priority
  'must-have': 'must',
  must_have: 'must',
  musthave: 'must',
  required: 'must',
  mandatory: 'must',
  essential: 'must',
  'nice-to-have': 'nice',
  nice_to_have: 'nice',
  nicetohave: 'nice',
  preferred: 'nice',
  bonus: 'nice',
  optional: 'nice',
  desirable: 'nice',
  'a-plus': 'nice',
};

/** Fields whose values are enums we are willing to repair. */
const ENUM_FIELDS = new Set(['category', 'kind', 'priority']);

/** Fields that must be integers even when the model quotes them or adds a decimal. */
const INTEGER_FIELDS = new Set(['difficulty', 'minutes', 'day', 'days_available', 'passes', 'jd_chars']);

/** Fields that must be arrays of strings even when the model sends a bare string. */
const STRING_ARRAY_FIELDS = new Set([
  'requirement_ids',
  'question_ids',
  'pages_used',
  'sources',
  'responsibilities',
]);

export function normaliseEnumValue(value: string): string {
  const key = value.trim().toLowerCase();
  return ENUM_ALIASES[key] ?? key;
}

/**
 * Walk a parsed value and correct the shapes a schema would otherwise reject.
 * Conservative by design: it only touches known field names, so it cannot
 * silently rewrite content.
 */
export function normaliseModelJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseModelJson);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (ENUM_FIELDS.has(key) && typeof raw === 'string') {
      out[key] = normaliseEnumValue(raw);
      continue;
    }
    if (INTEGER_FIELDS.has(key)) {
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n === 'number' && Number.isFinite(n)) {
        out[key] = Math.round(n);
        continue;
      }
    }
    if (STRING_ARRAY_FIELDS.has(key)) {
      if (typeof raw === 'string') {
        out[key] = raw.trim() === '' ? [] : [raw];
        continue;
      }
      if (raw === null || raw === undefined) {
        out[key] = [];
        continue;
      }
    }
    out[key] = normaliseModelJson(raw);
  }
  return out;
}

/** Remove fences and any prose the model wrapped around the JSON. */
export function stripFences(text: string): string {
  let out = text.trim();
  out = out.replace(/^﻿/, '');
  // ```json ... ``` or ``` ... ```
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/.exec(out);
  if (fenced !== null && fenced[1] !== undefined) out = fenced[1].trim();
  return out;
}

/**
 * Find the first balanced JSON object or array.
 *
 * String-aware, so a brace inside a string literal does not end the scan. This
 * rung handles the most common real failure: valid JSON followed by a friendly
 * paragraph of explanation.
 */
export function extractBalancedJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const openChar = text[start]!;
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface ParseOutcome {
  ok: boolean;
  value: unknown;
  /** Which rung of the ladder succeeded, for honest diagnostics. */
  rung: 'direct' | 'fenced' | 'balanced' | 'repaired' | 'none';
}

/**
 * Turn whatever the model said into a value, or report that it could not be done.
 * Never throws: the caller's next move is a targeted re-ask or a deterministic
 * fallback, and an exception here would just be noise in between.
 */
export function parseModelJson(raw: string): ParseOutcome {
  const attempts: { rung: ParseOutcome['rung']; text: string }[] = [];

  const trimmed = raw.trim();
  attempts.push({ rung: 'direct', text: trimmed });

  const unfenced = stripFences(raw);
  if (unfenced !== trimmed) attempts.push({ rung: 'fenced', text: unfenced });

  const balanced = extractBalancedJson(unfenced);
  if (balanced !== null && balanced !== unfenced) attempts.push({ rung: 'balanced', text: balanced });

  for (const attempt of attempts) {
    if (attempt.text === '') continue;
    try {
      const parsed: unknown = JSON.parse(attempt.text);
      if (!isStructured(parsed)) continue;
      return { ok: true, value: normaliseModelJson(parsed), rung: attempt.rung };
    } catch {
      // fall through to the next rung
    }
  }

  // Tolerant parse: trailing commas, single quotes, unquoted keys, truncated tails.
  for (const attempt of attempts) {
    if (attempt.text === '') continue;
    try {
      const parsed: unknown = JSON.parse(jsonrepair(attempt.text));
      if (!isStructured(parsed)) continue;
      return { ok: true, value: normaliseModelJson(parsed), rung: 'repaired' };
    } catch {
      // fall through
    }
  }

  return { ok: false, value: null, rung: 'none' };
}

/**
 * A structured call always expects an object or an array.
 *
 * This guard matters more than it looks. The tolerant parser is happy to turn
 * a refusal — "I cannot help with that request." — into a valid JSON *string*,
 * and a bare string would then be handed downstream as though it were a result.
 * Anything that is not an object or array is a failed call, not a value.
 */
function isStructured(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}
