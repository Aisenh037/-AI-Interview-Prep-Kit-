/**
 * Persistence.
 *
 * The shape here is driven by the hardest requirement in the brief: "Regenerating
 * one section must not discard edits the user has made elsewhere, and a question
 * the user wrote or edited by hand must survive a regeneration of its category."
 *
 * Two decisions follow from that.
 *
 * ITEMS LIVE IN THEIR OWN COLLECTION, not embedded in the kit. A kit is small
 * enough to embed, but embedding makes every concurrent write contend on one
 * document: the ninety-second generation job and a user typing in a textarea
 * would fight over the same lock, and per-item optimistic concurrency would need
 * positional array filters against a document-level version. With one document
 * per item the guard is `{_id, version}` — exact, independent, and impossible to
 * get subtly wrong.
 *
 * PROVENANCE NEVER ENTERS THE KIT OBJECT. `Kit.kit` holds exactly the Appendix A
 * structure and nothing else, so it can be serialised straight into a graded
 * artefact with no filtering step. Everything about who wrote what lives beside
 * it.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: '' },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User: Model<UserDoc> =
  (mongoose.models['User'] as Model<UserDoc>) ?? mongoose.model('User', userSchema);

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------

export const SECTION_KEYS = [
  'brief',
  'role',
  'questions:technical',
  'questions:behavioural',
  'questions:system-design',
  'questions:company-fit',
  'flashcards',
  'schedule',
  'stories',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

const sectionStateSchema = new Schema(
  {
    version: { type: Number, default: 0 },
    /** Set while a regeneration is in flight; a second one is refused. */
    activeRunId: { type: String, default: null },
    lastGeneratedAt: { type: Date, default: null },
    lastRunSummary: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const kitSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, default: '' },
    status: {
      type: String,
      enum: ['queued', 'generating', 'partial', 'ready', 'failed'],
      default: 'queued',
    },

    input: {
      jd: { type: String, required: true },
      companyUrl: { type: String, required: true },
      days: { type: Number, required: true },
    },

    /**
     * Exactly the Appendix A structure. Nothing else may be stored in here, so
     * that exporting is a projection rather than a filter.
     */
    kit: { type: Schema.Types.Mixed, default: null },

    /** Field-level edit tracking for the singleton sections. */
    edited: {
      brief: { type: [String], default: [] },
      role: { type: [String], default: [] },
    },
    /** Days the user pinned, which a schedule regeneration leaves alone. */
    pinnedDays: { type: [Number], default: [] },

    sections: { type: Map, of: sectionStateSchema, default: () => new Map() },

    /** Honest record of what research could and could not find. */
    research: { type: Schema.Types.Mixed, default: null },
    warnings: { type: [String], default: [] },

    /**
     * Monotonic id counters. Ids are never reused: the schedule references q7,
     * and renumbering on regeneration would break every reference in the kit.
     */
    nextIds: {
      r: { type: Number, default: 1 },
      q: { type: Number, default: 1 },
      f: { type: Number, default: 1 },
      s: { type: Number, default: 1 },
    },

    /** sha256 of user + normalised jd + canonical url. See the dedupe module. */
    dedupeKey: { type: String, required: true, index: true },
    revision: { type: Number, default: 0 },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One kit per (user, posting, revision). The unique index is what settles the
// race between two simultaneous submissions of the same posting.
kitSchema.index({ userId: 1, dedupeKey: 1, revision: 1 }, { unique: true });
kitSchema.index({ userId: 1, createdAt: -1 });

/**
 * Explicit document interfaces rather than InferSchemaType.
 *
 * Mongoose 9's inference marks every nested object optional, which would force
 * a null check on `kit.input.days` at a few dozen call sites for a field the
 * schema declares required. Declaring the shape once here keeps the call sites
 * honest without scattering assertions.
 */
export interface KitInput {
  jd: string;
  companyUrl: string;
  days: number;
}

export interface KitDoc {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  title: string;
  status: 'queued' | 'generating' | 'partial' | 'ready' | 'failed';
  input: KitInput;
  kit: unknown;
  edited: { brief: string[]; role: string[] };
  pinnedDays: number[];
  sections: Map<string, unknown>;
  research: unknown;
  warnings: string[];
  nextIds: { r: number; q: number; f: number; s: number };
  dedupeKey: string;
  revision: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const KitModel: Model<KitDoc> =
  (mongoose.models['Kit'] as Model<KitDoc>) ?? mongoose.model<KitDoc>('Kit', kitSchema);

// ---------------------------------------------------------------------------
// Kit items — questions, flashcards, requirements and stories
// ---------------------------------------------------------------------------

const kitItemSchema = new Schema(
  {
    kitId: { type: Schema.Types.ObjectId, ref: 'Kit', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** 'q7'. Stable for the life of the kit and never reused. */
    publicId: { type: String, required: true },
    type: {
      type: String,
      enum: ['requirement', 'question', 'flashcard', 'story'],
      required: true,
    },
    /** Which list this belongs to, e.g. 'questions:technical'. */
    listKey: { type: String, required: true },

    /**
     * Fractional index, as a string. Not a float: repeated insertion into the
     * same gap exhausts float precision after about fifty operations and then
     * reorders SILENTLY WRONG. A string key only ever gets longer.
     */
    rank: { type: String, required: true },

    status: {
      type: String,
      enum: ['active', 'deleted', 'superseded'],
      default: 'active',
    },
    /** Optimistic concurrency. Every write is guarded on this. */
    version: { type: Number, default: 1 },

    // --- the three orthogonal axes of provenance ---------------------------
    // A single `origin` enum cannot express "AI wrote it, the user edited the
    // prompt but not the outline, and now AI is regenerating the category".
    createdBy: { type: String, enum: ['ai', 'user'], default: 'ai' },
    lastEditedBy: { type: String, enum: ['ai', 'user'], default: 'ai' },
    /** Which fields the user owns. Field-level, not item-level. */
    editedFields: { type: [String], default: [] },
    pinned: { type: Boolean, default: false },
    /** Reordering or re-categorising is an act of judgement, so it protects. */
    movedByUser: { type: Boolean, default: false },

    /** Distinguishes "opened the editor and typed nothing" from a real edit. */
    contentHash: { type: String, default: '' },
    introducedByRunId: { type: String, default: null },
    supersededByRunId: { type: String, default: null },

    // --- content, by type ---------------------------------------------------
    data: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

kitItemSchema.index({ kitId: 1, listKey: 1, status: 1, rank: 1 });
kitItemSchema.index({ kitId: 1, publicId: 1 }, { unique: true });

export interface KitItemDoc {
  _id: mongoose.Types.ObjectId;
  kitId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  publicId: string;
  type: 'requirement' | 'question' | 'flashcard' | 'story';
  listKey: string;
  rank: string;
  status: 'active' | 'deleted' | 'superseded';
  version: number;
  createdBy: 'ai' | 'user';
  lastEditedBy: 'ai' | 'user';
  editedFields: string[];
  pinned: boolean;
  movedByUser: boolean;
  contentHash: string;
  introducedByRunId: string | null;
  supersededByRunId: string | null;
  data: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export const KitItem: Model<KitItemDoc> =
  (mongoose.models['KitItem'] as Model<KitItemDoc>) ??
  mongoose.model<KitItemDoc>('KitItem', kitItemSchema);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const jobSchema = new Schema(
  {
    kitId: { type: Schema.Types.ObjectId, ref: 'Kit', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['generate', 'regenerate'], default: 'generate' },
    sectionKey: { type: String, default: null },

    status: {
      type: String,
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stalled'],
      default: 'queued',
    },
    /**
     * Present only while queued or running, so a partial unique index can
     * enforce one active job per kit. MongoDB's partialFilterExpression does
     * not support $in, which is why this is a boolean rather than a status test.
     */
    active: { type: Boolean, default: true },

    steps: { type: [Schema.Types.Mixed], default: [] },
    events: { type: [Schema.Types.Mixed], default: [] },
    lastSeq: { type: Number, default: 0 },
    progress: { type: Number, default: 0 },

    /** Lease, so a job orphaned by a restart can be recovered rather than hang. */
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },

    error: { type: Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

jobSchema.index({ kitId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
jobSchema.index({ status: 1, leaseExpiresAt: 1 });

export interface JobDoc {
  _id: mongoose.Types.ObjectId;
  kitId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  kind: 'generate' | 'regenerate';
  sectionKey: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stalled';
  active?: boolean;
  steps: unknown[];
  events: unknown[];
  lastSeq: number;
  progress: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  attempts: number;
  cancelRequested: boolean;
  error: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const Job: Model<JobDoc> =
  (mongoose.models['Job'] as Model<JobDoc>) ?? mongoose.model<JobDoc>('Job', jobSchema);

// ---------------------------------------------------------------------------
// Practice
// ---------------------------------------------------------------------------

const practiceCardSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kitId: { type: Schema.Types.ObjectId, ref: 'Kit', required: true },
    cardId: { type: String, required: true },

    seenCount: { type: Number, default: 0 },
    lastConfidence: { type: Number, default: null },
    streak: { type: Number, default: 0 },
    lapses: { type: Number, default: 0 },
    ease: { type: Number, default: 2.3 },
    dueAt: { type: Date, default: () => new Date() },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

practiceCardSchema.index({ userId: 1, kitId: 1, cardId: 1 }, { unique: true });
practiceCardSchema.index({ userId: 1, kitId: 1, dueAt: 1 });

export type PracticeCardDoc = InferSchemaType<typeof practiceCardSchema>;
export const PracticeCard: Model<PracticeCardDoc> =
  (mongoose.models['PracticeCard'] as Model<PracticeCardDoc>) ??
  mongoose.model('PracticeCard', practiceCardSchema);
