import { describe, expect, it } from 'vitest';
import {
  describeBlastRadius,
  isProtected,
  planMerge,
  protectionReason,
  similarity,
  type MergeCandidate,
  type MergeableItem,
} from './mergePlan.js';

function item(publicId: string, overrides: Partial<MergeableItem> = {}): MergeableItem {
  return {
    publicId,
    version: 1,
    status: 'active',
    rank: 'a0',
    createdBy: 'ai',
    lastEditedBy: 'ai',
    editedFields: [],
    pinned: false,
    movedByUser: false,
    matchText: `Question ${publicId} about distributed systems and Kafka consumers`,
    ...overrides,
  };
}

function candidate(text: string): MergeCandidate {
  return { matchText: text, payload: { prompt: text } };
}

const actionsFor = (plan: ReturnType<typeof planMerge>, id: string) =>
  plan.actions.filter((a) => 'publicId' in a && a.publicId === id);

describe('anything a human touched is protected', () => {
  it.each([
    ['pinned', { pinned: true }, 'pinned'],
    ['user-authored', { createdBy: 'user' as const }, 'authored'],
    ['user-edited', { lastEditedBy: 'user' as const }, 'edited'],
    ['field-edited', { editedFields: ['prompt'] }, 'edited'],
    ['reordered by hand', { movedByUser: true }, 'moved'],
    ['deleted', { status: 'deleted' as const }, 'deleted'],
  ])('protects a %s item', (_label, overrides, reason) => {
    expect(protectionReason(item('q1', overrides))).toBe(reason);
    expect(isProtected(item('q1', overrides))).toBe(true);
  });

  it('leaves an untouched generated item replaceable', () => {
    expect(isProtected(item('q1'))).toBe(false);
  });
});

describe('a regeneration of a category', () => {
  it('keeps a question the user edited and replaces the rest', () => {
    // The requirement, almost verbatim: "a question the user wrote or edited by
    // hand must survive a regeneration of its category".
    const live = [
      item('q1', { lastEditedBy: 'user', editedFields: ['prompt'] }),
      item('q2'),
      item('q3'),
    ];
    const plan = planMerge(live, [candidate('A brand new question about sharding')]);

    expect(actionsFor(plan, 'q1')[0]!.action).toBe('keep');
    expect(plan.summary.kept).toBe(1);
    expect(plan.actions.some((a) => a.action === 'add')).toBe(true);
  });

  it('keeps a question the user wrote themselves', () => {
    const live = [item('q1', { createdBy: 'user' })];
    const plan = planMerge(live, [candidate('Something else entirely about Redis')]);
    expect(actionsFor(plan, 'q1')[0]!.action).toBe('keep');
  });

  it('keeps a question the user moved, because moving is a judgement', () => {
    const live = [item('q1', { movedByUser: true })];
    const plan = planMerge(live, [candidate('Unrelated new question about caching')]);
    expect(actionsFor(plan, 'q1')[0]!.action).toBe('keep');
  });

  it('rewrites a matching generated question in place, keeping its id', () => {
    // Ids must survive: the schedule references them, so renumbering on every
    // regeneration would break the plan the user is working from.
    const live = [item('q7', { matchText: 'How would you tune a Kafka consumer group?' })];
    const plan = planMerge(live, [
      candidate('How would you tune a Kafka consumer group for throughput?'),
    ]);
    const action = actionsFor(plan, 'q7')[0]!;
    expect(action.action).toBe('replace');
    if (action.action === 'replace') expect(action.expectedVersion).toBe(1);
    expect(plan.summary.added).toBe(0);
  });

  it('retires rather than deletes, so the whole run can be undone', () => {
    const live = [item('q1', { matchText: 'Something the model did not reproduce' })];
    const plan = planMerge(live, []);
    expect(actionsFor(plan, 'q1')[0]!.action).toBe('retire');
    expect(plan.summary.retired).toBe(1);
  });

  it('never resurrects something the user deleted', () => {
    const live = [item('q1', { status: 'deleted', matchText: 'Deleted question about Kafka' })];
    const plan = planMerge(live, [candidate('Deleted question about Kafka')]);
    // It stays kept-as-tombstone, and the near-identical candidate is not added.
    expect(actionsFor(plan, 'q1')[0]!.action).toBe('keep');
    expect(plan.summary.added).toBe(0);
  });

  it('does not clone a question the user already wrote', () => {
    const live = [
      item('q1', { createdBy: 'user', matchText: 'Tell me about a production incident you owned' }),
    ];
    const plan = planMerge(live, [candidate('Tell me about a production incident you owned.')]);
    expect(plan.summary.added).toBe(0);
    expect(plan.summary.kept).toBe(1);
  });

  it('carries protected text so the prompt can be told not to repeat it', () => {
    const live = [item('q1', { pinned: true, matchText: 'Pinned question about Kafka' })];
    const plan = planMerge(live, []);
    expect(plan.protectedTexts).toEqual(['Pinned question about Kafka']);
  });
});

describe('the race that matters', () => {
  it('guards every write with the version it planned against', () => {
    // If the user edits between planning and committing, the guarded write
    // fails to match and the job skips that item — the edit wins.
    const live = [item('q1', { version: 4, matchText: 'How do you tune Kafka?' })];
    const plan = planMerge(live, [candidate('How do you tune Kafka for throughput?')]);
    const action = plan.actions.find((a) => a.action === 'replace');
    expect(action).toBeDefined();
    if (action?.action === 'replace') expect(action.expectedVersion).toBe(4);
  });

  it('plans no write at all against a protected item', () => {
    const live = [item('q1', { pinned: true })];
    const plan = planMerge(live, [candidate('anything')]);
    const writes = plan.actions.filter((a) => a.action === 'replace' || a.action === 'retire');
    expect(writes).toHaveLength(0);
  });
});

describe('matching', () => {
  it('scores a rephrasing as similar and an unrelated question as not', () => {
    expect(similarity('Tune a Kafka consumer group', 'Tune a Kafka consumer group for throughput'))
      .toBeGreaterThan(0.6);
    expect(similarity('Tune a Kafka consumer group', 'Describe your mentoring style')).toBeLessThan(
      0.4,
    );
  });

  it('matches each candidate to at most one slot', () => {
    const live = [
      item('q1', { matchText: 'How would you tune a Kafka consumer group?' }),
      item('q2', { matchText: 'How would you tune a Kafka consumer group?' }),
    ];
    const plan = planMerge(live, [candidate('How would you tune a Kafka consumer group?')]);
    expect(plan.summary.replaced).toBe(1);
    expect(plan.summary.retired).toBe(1);
  });
});

describe('telling the user what is about to happen', () => {
  it('states how many survive and how many go', () => {
    const live = [item('q1', { pinned: true }), item('q2'), item('q3')];
    expect(describeBlastRadius(live)).toBe(
      '2 items will be replaced. 1 you edited or pinned will be kept.',
    );
  });

  it('says plainly when nothing is protected', () => {
    expect(describeBlastRadius([item('q1'), item('q2')])).toBe('All 2 items here will be replaced.');
  });

  it('says plainly when nothing will change', () => {
    expect(describeBlastRadius([item('q1', { pinned: true })])).toContain('Nothing will be replaced');
  });

  it('handles an empty section', () => {
    expect(describeBlastRadius([])).toContain('empty');
  });
});
