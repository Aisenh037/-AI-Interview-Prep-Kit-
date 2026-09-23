/**
 * Check a batch output file against Appendix A and Appendix B.
 *
 *   npm run validate:kits -- out/kits.json
 *
 * This exists so the claim "kits match the expected structure" can be
 * demonstrated rather than asserted. It validates the envelope, every kit
 * against the strict export schema, and the cross-field rules the brief states
 * in prose.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { validateKitForExport, KIT_TOP_LEVEL_KEYS, type Kit } from '@kit/shared';

interface Entry {
  id?: unknown;
  status?: unknown;
  kit?: unknown;
  error?: unknown;
}

const problems: string[] = [];
const notes: string[] = [];

function problem(where: string, message: string): void {
  problems.push(`${where}: ${message}`);
}

async function main(): Promise<number> {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write('Usage: npm run validate:kits -- <kits.json>\n');
    return 1;
  }

  const raw = await readFile(resolve(path), 'utf8');
  const doc = JSON.parse(raw) as { version?: unknown; generated_at?: unknown; kits?: unknown };

  // --- Appendix B: the envelope --------------------------------------------
  if (doc.version !== '1.0') problem('envelope', `version should be "1.0", got ${String(doc.version)}`);
  if (typeof doc.generated_at !== 'string' || Number.isNaN(Date.parse(doc.generated_at))) {
    problem('envelope', 'generated_at should be an ISO 8601 timestamp');
  }
  if (!Array.isArray(doc.kits)) {
    problem('envelope', 'kits should be an array');
    report();
    return problems.length === 0 ? 0 : 1;
  }

  const entries = doc.kits as Entry[];
  const ids = new Set<string>();

  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id : '(missing id)';
    if (ids.has(id)) problem(id, 'duplicate case id');
    ids.add(id);

    if (entry.status !== 'ok' && entry.status !== 'failed') {
      problem(id, `status should be "ok" or "failed", got ${String(entry.status)}`);
      continue;
    }

    if (entry.status === 'failed') {
      if (entry.kit !== null) problem(id, 'a failed case must have kit: null');
      const error = entry.error as { code?: unknown; message?: unknown } | null;
      if (error === null || typeof error.code !== 'string' || typeof error.message !== 'string') {
        problem(id, 'a failed case must carry an error with a code and a message');
      }
      notes.push(`${id}: failed — ${(entry.error as { code?: string } | null)?.code ?? '?'}`);
      continue;
    }

    if (entry.error !== null) problem(id, 'an ok case must have error: null');

    // --- Appendix A: the kit ------------------------------------------------
    const result = validateKitForExport(entry.kit);
    if (!result.ok) {
      for (const issue of result.issues.slice(0, 5)) {
        problem(id, `${issue.path} ${issue.message}`);
      }
      continue;
    }

    const kit = result.kit;
    const actualKeys = Object.keys(entry.kit as object);
    const expected = [...KIT_TOP_LEVEL_KEYS];
    const extra = actualKeys.filter((k) => !expected.includes(k as never));
    if (extra.length > 0) problem(id, `unexpected top-level keys: ${extra.join(', ')}`);

    checkKitRules(id, kit);
    notes.push(summarise(id, kit));
  }

  report();
  return problems.length === 0 ? 0 : 1;
}

/** Rules the brief states in prose, checked here as well as in the schema. */
function checkKitRules(id: string, kit: Kit): void {
  const mustIds = kit.role.requirements.filter((r) => r.priority === 'must').map((r) => r.id);
  const scheduled = new Set(kit.schedule.days.flatMap((d) => d.question_ids));
  const scheduledQuestions = kit.questions.filter((q) => scheduled.has(q.id));

  // "A kit that ships with uncovered must-have requirements has failed."
  for (const requirementId of mustIds) {
    if (kit.coverage.uncovered_requirement_ids.includes(requirementId)) {
      problem(id, `must-have ${requirementId} is reported uncovered`);
    }
    const covered = kit.questions.some((q) => q.requirement_ids.includes(requirementId));
    if (!covered) problem(id, `must-have ${requirementId} has no question`);
    // "Every must-have requirement appears somewhere in the schedule."
    const inSchedule = scheduledQuestions.some((q) => q.requirement_ids.includes(requirementId));
    if (covered && !inSchedule) problem(id, `must-have ${requirementId} never appears in the schedule`);
  }

  for (const day of kit.schedule.days) {
    if (!Number.isInteger(day.minutes)) problem(id, `day ${day.day} has non-integer minutes`);
    if (day.focus.trim() === '') problem(id, `day ${day.day} has an empty focus`);
  }

  for (const question of kit.questions) {
    if (!Number.isInteger(question.difficulty) || question.difficulty < 1 || question.difficulty > 3) {
      problem(id, `question ${question.id} has difficulty ${question.difficulty}`);
    }
  }

  // Honesty: a kit citing sources it never fetched would be laundering them.
  const fetched = new Set(kit.source.pages_used);
  for (const source of kit.company_brief.sources) {
    if (!fetched.has(source)) problem(id, `brief cites ${source}, which is not in pages_used`);
  }
}

function summarise(id: string, kit: Kit): string {
  const musts = kit.role.requirements.filter((r) => r.priority === 'must').length;
  const nices = kit.role.requirements.length - musts;
  return (
    `${id.padEnd(26)} ${String(kit.source.pages_used.length).padStart(2)} pages  ` +
    `${String(musts).padStart(2)} must / ${String(nices)} nice  ` +
    `${String(kit.questions.length).padStart(2)} questions  ` +
    `${String(kit.flashcards.length).padStart(2)} cards  ` +
    `${String(kit.schedule.days.length).padStart(2)} days  ` +
    `passes ${kit.coverage.passes}`
  );
}

function report(): void {
  for (const note of notes) process.stdout.write(`  ${note}\n`);
  process.stdout.write('\n');
  if (problems.length === 0) {
    process.stdout.write('All kits conform to Appendix A and the envelope matches Appendix B.\n');
    return;
  }
  process.stdout.write(`${problems.length} problem(s):\n`);
  for (const p of problems) process.stdout.write(`  - ${p}\n`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`validate failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
