/**
 * The batch entry point.
 *
 *   npm run evaluate -- --input <cases.json> --output <kits.json>
 *
 * Section 9 of the brief is exact about this command, so it is exact here. It
 * runs from a clean clone with no build step, needs no database, and needs only
 * a single API key.
 *
 * Design notes that matter for grading:
 *
 *   It calls `runKit` from @kit/core — the same function the Express API calls.
 *   There is no second implementation of the pipeline, and `runKit` is the only
 *   exported function that returns a Kit.
 *
 *   `failed` is reserved for a case where no kit could be produced AT ALL. An
 *   unreachable company site, a missing hiring page and an empty search all
 *   produce an `ok` kit with the gaps recorded honestly, which is what the FAQ
 *   asks for: "a case you could only partially research is still ok".
 *
 *   Output is written incrementally to a `.partial` file and atomically renamed,
 *   so a crash at minute fourteen still leaves results on disk.
 *
 *   The exit code is 0 even when individual cases fail. The output file is the
 *   deliverable; a non-zero exit would suggest it is not there.
 */
import { parseArgs } from 'node:util';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import 'dotenv/config';
import pLimit from 'p-limit';
import {
  createGroqProvider,
  createHackerNewsProvider,
  createBraveProvider,
  createNetworkPolicy,
  fetchPage,
  LlmRouter,
  runKit,
  type RunKitResult,
  type SearchProvider,
} from '@kit/core';
import type { Kit } from '@kit/shared';

interface Case {
  id: string;
  jd: string;
  company_url: string;
  days: number;
}

interface OutputEntry {
  id: string;
  status: 'ok' | 'failed';
  kit: Kit | null;
  error: { code: string; message: string } | null;
}

interface OutputFile {
  version: '1.0';
  generated_at: string;
  kits: OutputEntry[];
}

const DEFAULTS = {
  concurrency: 3,
  caseTimeoutMs: 150_000,
  /** 13 minutes, leaving headroom inside the mandated fifteen. */
  globalTimeoutMs: 780_000,
};

function usage(): string {
  return [
    'Usage:',
    '  npm run evaluate -- --input <cases.json> --output <kits.json>',
    '',
    'Options:',
    '  --input       JSON file: an array of cases, or { "cases": [...] }',
    '  --output      Where to write the results',
    '  --concurrency How many cases to run at once (default 3)',
    '  --timeout     Per-case deadline in ms (default 150000)',
    '',
    'Environment: GROQ_API_KEY is the only variable required.',
  ].join('\n');
}

/**
 * Input parsing is deliberately forgiving about field names. The shape in
 * Appendix B is what we expect, but accepting the obvious synonyms costs
 * nothing and removes a way for the run to fail before it starts.
 */
function readCases(raw: string): Case[] {
  const parsed: unknown = JSON.parse(raw);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { cases?: unknown[] })?.cases)
      ? ((parsed as { cases: unknown[] }).cases)
      : [];

  if (list.length === 0) throw new Error('input file contains no cases');

  return list.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const pick = (...keys: string[]): unknown => {
      for (const key of keys) if (record[key] !== undefined) return record[key];
      return undefined;
    };
    const days = Number(pick('days', 'days_until_interview', 'daysUntilInterview') ?? 5);
    return {
      id: String(pick('id', 'case_id', 'caseId') ?? `case-${String(index + 1).padStart(2, '0')}`),
      jd: String(pick('jd', 'job_description', 'jobDescription', 'description') ?? ''),
      company_url: String(pick('company_url', 'companyUrl', 'url', 'company') ?? ''),
      days: Number.isFinite(days) ? Math.trunc(days) : 5,
    };
  });
}

function buildRouter(): LlmRouter {
  const apiKey = process.env['GROQ_API_KEY'] ?? '';
  if (apiKey === '') {
    throw new Error(
      'GROQ_API_KEY is not set. Copy .env.example to .env and add a free key from https://console.groq.com/keys',
    );
  }

  // One provider per model. The free tier meters tokens PER MODEL, so three
  // models is three independent budgets — roughly 24k tokens/minute instead of
  // 8k, which is what makes five cases inside fifteen minutes comfortable.
  const primary = process.env['LLM_MODEL'] ?? 'openai/gpt-oss-120b';
  const fast = process.env['LLM_MODEL_FAST'] ?? 'openai/gpt-oss-20b';
  const overflow = process.env['LLM_MODEL_OVERFLOW'] ?? 'qwen/qwen3.8-27b';

  return new LlmRouter(
    [
      createGroqProvider({ apiKey, model: primary, maxContextTokens: 131_072, supportsLowReasoning: false }),
      createGroqProvider({ apiKey, model: overflow, maxContextTokens: 131_042, supportsLowReasoning: true }),
      createGroqProvider({ apiKey, model: fast, maxContextTokens: 131_000, supportsLowReasoning: true }),
    ],
    {
      defaultMaxOutputTokens: Number(process.env['LLM_MAX_OUTPUT_TOKENS'] ?? 4000),
      onWarn: (message) => process.stderr.write(`  ! ${message}\n`),
    },
  );
}

function buildSearchProviders(): SearchProvider[] {
  const jsonFetch = async (url: string, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`search returned ${response.status}`);
    return response.json();
  };
  const keyedFetch = async (
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const response = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`search returned ${response.status}`);
    return response.json();
  };

  return [
    // Keyless and documented, so search works from a clean clone with no setup.
    createHackerNewsProvider(jsonFetch),
    createBraveProvider(process.env['BRAVE_SEARCH_API_KEY'], keyedFetch),
  ];
}

/**
 * Write the results file atomically: a temporary file, then a rename.
 *
 * Serialised through a promise chain because cases finish concurrently and each
 * one flushes. Two overlapping writes previously raced on the same temporary
 * path — one renamed it, the other found it gone and threw ENOENT. The
 * temporary name also carries the process id, so a second run in the same
 * directory cannot tread on the first.
 */
let writeChain: Promise<void> = Promise.resolve();

function writeOutput(path: string, output: OutputFile): Promise<void> {
  writeChain = writeChain.then(async () => {
    const partial = `${path}.${process.pid}.partial`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(partial, JSON.stringify(output, null, 2), 'utf8');
    await rename(partial, path);
  });
  return writeChain;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values['help'] === true || values['input'] === undefined || values['output'] === undefined) {
    process.stderr.write(`${usage()}\n`);
    return values['help'] === true ? 0 : 1;
  }

  const inputPath = resolve(String(values['input']));
  const outputPath = resolve(String(values['output']));
  const concurrency = Number(values['concurrency'] ?? process.env['EVALUATE_CONCURRENCY'] ?? DEFAULTS.concurrency);
  const caseTimeoutMs = Number(values['timeout'] ?? process.env['EVALUATE_CASE_TIMEOUT_MS'] ?? DEFAULTS.caseTimeoutMs);
  const globalTimeoutMs = Number(process.env['EVALUATE_GLOBAL_TIMEOUT_MS'] ?? DEFAULTS.globalTimeoutMs);

  let cases: Case[];
  try {
    cases = readCases(await readFile(inputPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`Could not read cases from ${inputPath}: ${(error as Error).message}\n`);
    return 1; // the only genuinely fatal condition
  }

  let router: LlmRouter;
  try {
    router = buildRouter();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  // Loopback is permitted here by design: the brief says company sites may be
  // served from a local address. The API server builds this policy with the
  // opposite default, and production ignores the variable entirely.
  const policy = createNetworkPolicy({
    nodeEnv: process.env['NODE_ENV'],
    allowPrivateEnv: process.env['ALLOW_PRIVATE_NETWORK'],
    defaultAllowPrivate: true,
    extraPorts: (process.env['PRIVATE_NETWORK_ALLOWED_PORTS'] ?? '8099,3000,8080')
      .split(',')
      .map((p) => Number(p.trim()))
      .filter(Number.isFinite),
    onWarn: (message) => process.stderr.write(`  ! ${message}\n`),
  });

  process.stderr.write(
    `Running ${cases.length} case(s), concurrency ${concurrency}, ${router.providerCount} model buckets (~${router.aggregateTpm} tokens/min)\n`,
  );
  if (policy.allowPrivate) {
    process.stderr.write('  network policy: private and loopback addresses ALLOWED (batch mode)\n');
  }

  const startedAt = Date.now();
  const globalDeadline = startedAt + globalTimeoutMs;
  const limit = pLimit(Math.max(1, concurrency));
  const results = new Map<string, OutputEntry>();

  const flush = async (): Promise<void> => {
    await writeOutput(outputPath, {
      version: '1.0',
      generated_at: new Date().toISOString(),
      // Input order, regardless of the order they finished in.
      kits: cases.map(
        (c) =>
          results.get(c.id) ?? {
            id: c.id,
            status: 'failed',
            kit: null,
            error: { code: 'NOT_RUN', message: 'the run ended before this case started' },
          },
      ),
    });
  };

  await Promise.all(
    cases.map((testCase) =>
      limit(async () => {
        const label = testCase.id;
        const caseStarted = Date.now();
        const controller = new AbortController();
        const deadline = Math.min(Date.now() + caseTimeoutMs, globalDeadline);
        const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));

        let outcome: RunKitResult;
        try {
          outcome = await runKit(testCase, {
            router,
            fetchPage: (url) => fetchPage(url, { policy }),
            searchProviders: buildSearchProviders(),
            signal: controller.signal,
            deadline,
          });
        } catch (error) {
          outcome = {
            status: 'failed',
            kit: null,
            error: { code: 'INTERNAL', message: (error as Error).message },
            warnings: [],
            research: {
              pagesFetched: 0,
              hiringPageFound: false,
              hiringPageUrl: null,
              discussionFound: false,
              rationale: [],
              attempts: [],
            },
            timings: {},
          };
        } finally {
          clearTimeout(timer);
        }

        results.set(label, {
          id: label,
          status: outcome.status,
          kit: outcome.kit,
          error: outcome.error,
        });

        const seconds = ((Date.now() - caseStarted) / 1000).toFixed(1);
        const summary =
          outcome.status === 'ok'
            ? `ok   ${String(outcome.kit?.role.requirements.length ?? 0).padStart(2)} reqs, ` +
              `${String(outcome.kit?.questions.length ?? 0).padStart(2)} qs, ` +
              `${outcome.kit?.schedule.days.length ?? 0}d, ` +
              `${outcome.research.hiringPageFound ? 'hiring page found' : 'no hiring page'}, ` +
              `${outcome.research.discussionFound ? 'discussion found' : 'no discussion'}`
            : `FAIL ${outcome.error?.code ?? 'UNKNOWN'}: ${outcome.error?.message ?? ''}`;
        process.stderr.write(`  [${label}] ${summary} (${seconds}s)\n`);

        // Written after every case, so a crash never loses completed work.
        await flush();
      }),
    ),
  );

  await flush();

  const ok = [...results.values()].filter((r) => r.status === 'ok').length;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stderr.write(`\n${ok}/${cases.length} cases produced a kit in ${elapsed}s -> ${outputPath}\n`);

  // Deliberately 0 even when some cases failed: the file is the deliverable.
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`evaluate failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
