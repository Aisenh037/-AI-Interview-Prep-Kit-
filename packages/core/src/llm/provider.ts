/**
 * The provider boundary.
 *
 * Everything shared — rate limiting, retry, failover, JSON repair — lives ABOVE
 * this interface, so an adapter stays thin: build a request body, map an HTTP
 * status onto an error code, read the rate-limit headers. Adding a second
 * provider should not require re-implementing any of the hard parts.
 */

export type LlmErrorCode =
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'BAD_REQUEST'
  | 'AUTH'
  | 'CONTENT_FILTER'
  | 'INVALID_OUTPUT';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly provider: string;
  readonly model: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    code: LlmErrorCode;
    message: string;
    provider: string;
    model: string;
    status?: number | undefined;
    retryAfterMs?: number | undefined;
  }) {
    super(args.message);
    this.name = 'LlmError';
    this.code = args.code;
    this.provider = args.provider;
    this.model = args.model;
    this.status = args.status;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** Worth trying again; anything else should fail over or fall back immediately. */
  get retryable(): boolean {
    return (
      this.code === 'RATE_LIMIT' ||
      this.code === 'SERVER' ||
      this.code === 'NETWORK' ||
      this.code === 'TIMEOUT'
    );
  }
}

export interface JsonSchemaSpec {
  /** A name for the schema; some providers require one. */
  name: string;
  /** A JSON Schema object. Must satisfy the provider's strict-mode rules. */
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** When present, the provider is asked to constrain decoding to this schema. */
  jsonSchema?: JsonSchemaSpec | undefined;
  maxOutputTokens: number;
  temperature?: number | undefined;
  /**
   * Reasoning budget hint.
   *
   * Measured caveat, and the reason this is not just passed through: on the
   * larger model `low` produces an EMPTY generation under strict schema mode and
   * the request fails outright. It is only safe on the smaller model, so the
   * router decides this rather than callers.
   */
  reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
  signal?: AbortSignal | undefined;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  get totalTokens(): number;
}

export interface LlmResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  rateLimit: {
    remainingRequests?: number | undefined;
    remainingTokens?: number | undefined;
  };
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly limits: {
    /** Requests per minute. */
    rpm: number;
    /** Tokens per minute — enforced PER MODEL, which the router exploits. */
    tpm: number;
    maxContextTokens: number;
    supportsJsonSchema: boolean;
    /** False where `reasoningEffort: 'low'` breaks structured output. */
    supportsLowReasoning: boolean;
  };
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/**
 * Providers reject a JSON Schema carrying `$schema`, and strict mode additionally
 * requires every property to be listed in `required` with `additionalProperties`
 * false. zod's emitter gets the latter right but includes the former.
 */
export function toStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema) as Record<string, unknown>;
  delete clone['$schema'];
  return harden(clone) as Record<string, unknown>;
}

function harden(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(harden);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$schema') continue;
    out[key] = harden(value);
  }

  if (out['type'] === 'object') {
    out['additionalProperties'] = false;
    const properties = out['properties'];
    if (properties !== undefined && typeof properties === 'object' && properties !== null) {
      // Strict mode requires EVERY property to be required. Optionality is
      // expressed by allowing null, not by omission.
      out['required'] = Object.keys(properties as Record<string, unknown>);
    }
  }
  return out;
}
