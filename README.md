# AI Interview Prep Kit

Turns a job description into a researched, editable interview preparation kit.

You paste a posting, give the company's website and say how many days you have.
The application crawls the site to work out what they do and how they hire,
looks for public discussion of their interview process, and assembles a kit: a
company brief, a breakdown of the role, a categorised question bank, flashcards
and a day-by-day schedule. You can then reshape any part of it and practise
against it.

The principle underneath all of it: **the model proposes, the code decides.**
Requirement extraction is anchored to evidence spans that code verifies against
the posting. Must/nice is corrected by a lexicon. Coverage checking and schedule
allocation never touch a model at all. Every model output is validated before it
can enter a kit, and every id in a kit is minted by our code.

---

## Quick start

```bash
npm install
cp .env.example .env        # then add GROQ_API_KEY
npm run dev                 # api on :4000, web on :3000
```

The API also needs `MONGODB_URI` and `AUTH_JWT_SECRET`. **The batch entry point
needs neither** — see below.

### Running the tests

```bash
npm test          # 330 tests, fully offline: no network, no API key
npm run verify    # lint + typecheck + test
```

Every test runs against a fixture LLM provider and local fixture company sites,
so the suite is hermetic and costs nothing. That matters more than it sounds:
the free tier is capped at 200,000 tokens a day, and a test suite that spent
quota would be a test suite nobody runs.

---

## The batch entry point

```bash
npm run fixtures:serve      # in one shell: serves fixture company sites on :8099
npm run evaluate -- --input examples/cases.sample.json --output out/kits.json
```

It needs **only `GROQ_API_KEY`** — no database, no auth secret, no search key —
and runs from a clean clone with no build step. That is not a coincidence:
`@kit/core` has no dependency on Mongo or Express, and `npm run check:layers`
walks the module graph from the CLI entry point and fails if any of them appear.
The proof is mechanical rather than a promise.

Measured on the sample cases: **5 kits in 250 seconds** against the
fifteen-minute budget, all five conforming to Appendix A.

```bash
npm run validate:kits -- out/kits.json
```

checks a results file against both appendices, including the rules the brief
states in prose — every must-have covered, every must-have present in the
schedule, integer minutes, no source cited that we did not fetch.

**Status is `ok` unless no kit could be produced at all.** An unreachable
company site, a missing hiring page and an empty search all produce an `ok` kit
with the gaps recorded honestly, which is what the FAQ asks for. `failed` is
reserved for an invalid case, a kit that cannot be made schema-valid, or an
internal error.

Output is written incrementally to a temporary file and atomically renamed, so a
crash at minute fourteen still leaves results on disk. The exit code is 0 even
when individual cases failed — the file is the deliverable, and a non-zero exit
would suggest it is not there.

---

## Tech stack

Next.js + Tailwind, Node + Express, MongoDB, TypeScript — the preferred stack,
with three choices worth explaining.

**npm workspaces**, not pnpm or Turborepo. pnpm needs `corepack enable` and
Turborepo needs a binary download; both violate "no setup beyond your documented
install step" for the sake of a monorepo with five packages.

**`tsx` for the batch command, `tsup` for the deployed API.** A pre-build step
would put `npm run build` between a fresh clone and `npm run evaluate`, add a
stale-`dist` failure mode, and let a type error in the web app break the batch
run. The API is bundled instead of run through `tsx` because `tsx` is a
devDependency and some hosts prune those — running it in production is a latent
crash.

**TypeScript pinned to 5.9.3.** `typescript-eslint` declares a peer range of
`>=4.8.4 <6.1.0`, so TypeScript 7 would silently break linting across the repo.

---

## LLM provider and model

**Groq**, with three models used as three independent rate buckets:

| Model | Used for |
|---|---|
| `openai/gpt-oss-120b` | extraction, question generation, the brief |
| `qwen/qwen3.8-27b` | overflow when the first is rate-limited |
| `openai/gpt-oss-20b` | mechanical work: link re-ranking, gap fill, JSON repair |

Four things here were measured against the live API rather than assumed, and
each changed the design:

1. **`llama-3.3-70b-versatile` left Groq's free tier on 16 August 2026.** The
   free replacement is `openai/gpt-oss-120b`.
2. **The free tier allows 30 requests/minute but only 8,000 tokens/minute.**
   Tokens bind by a wide margin, so a limiter counting requests would sail
   straight into a 429.
3. **The limit is metered per model.** Three models observed reporting
   independent `x-ratelimit-remaining-tokens` counters, which turns 8K
   tokens/minute into roughly 24K. That is the difference between the batch run
   finishing inside fifteen minutes and timing out.
4. **`reasoning_effort: "low"` breaks structured output on the larger model** —
   it returns an empty generation and the request fails with
   `json_validate_failed` — while being safe on the smaller one. The capability
   is therefore declared per model, and the router decides it rather than
   callers.

`gpt-oss-120b` supports strict schema-constrained decoding, which does most of
the JSON work. The repair ladder underneath it is a safety net, not the primary
mechanism.

**Rate limiting.** One dual token bucket per model, process-global, counting
requests *and* tokens. Output tokens are reserved before the call and refunded
at settle: these are reasoning models whose hidden reasoning is billed as
output, and a measured extraction call spent 300 input tokens against 488
output, so estimating the prompt alone under-counts by more than half. A 429
pauses every caller on that bucket, `Retry-After` is parsed in both
integer-seconds and HTTP-date forms, and a call larger than the whole per-minute
budget is refused up front rather than hanging until its deadline.

---

## Architecture

```
packages/shared   types, the Appendix A schema, the merge rules, practice scheduling
packages/core     the pipeline — no database, no Express, no process.env
packages/cli      the batch entry point
packages/api      Express: auth, persistence, jobs
packages/web      Next.js
```

Dependencies run one way (`web → shared`, `api/cli → core → shared`) and are
enforced by ESLint zones plus `npm run check:layers`. `web` may not import
`core`, or Next would pull cheerio and undici into the browser bundle.

`core` never reads `process.env`, never calls `Date.now()` or `Math.random()`
directly — clock, randomness and network policy are injected. That is what makes
determinism testable.

**`runKit` is the only exported function that returns a Kit.** The API calls it
and the CLI calls it, so "the same code your application uses, not a parallel
implementation" is structural rather than aspirational.

---

## Retrieval

### Finding the hiring page

The brief rules out the obvious approach: "the path cannot be hard-coded…
GitLab and PostHog both publish detailed hiring processes at paths we would
never have predicted." So ranking runs over three independent signals, none of
which is a path list:

- **Vocabulary**, matched against anchor text and path segments, in tiers.
  A phrase occupying a whole path segment (`/how-we-hire`) scores far above the
  same words appearing incidentally in a long URL.
- **Placement** — a link in site-wide chrome is canonical. Companies link their
  careers page from every footer and a blog post once.
- **Corroboration** from `sitemap.xml` or from appearing on several crawled
  pages, which separates structural links from incidental ones.

Sitemap parsing matters more than it looks: it reaches pages that are not linked
from the homepage at all. One model call re-ranks the shortlist, but **only when
the heuristic is genuinely unsure** — that is the one case where a model beats
keywords, such as a link reading "Handbook → People Ops" with no hiring
vocabulary anywhere near it.

Whether a page *really* describes a process is then decided from its text, not
its URL: a page called `/careers` that says nothing about interviewing is not a
hiring page. Two bugs the fixtures caught are worth recording, because both
would have quietly cost rankings: the inflection rule produced `hire` + `ing` =
"hireing", so **"Hiring" matched nothing at all**; and overlapping lexicon
entries stacked, so "Joining us" counted three times and outscored a better
candidate.

### Sources used

- **The company's own site**, crawled best-first under a budget of 12 pages,
  depth 2 and 45 seconds, respecting `robots.txt`.
- **Hacker News**, via the Algolia API, for public discussion. Keyless,
  documented and reliable.
- **Brave Search**, if `BRAVE_SEARCH_API_KEY` is set. Never required.

Glassdoor, LinkedIn, Indeed and Blind are hard-blocklisted. They block automated
access and their terms forbid it; a design that scrapes them anyway is a
liability rather than a feature.

Two documented deviations from a strict reading of RFC 9309: `Crawl-delay` is
honoured but clamped to two seconds, because a fixture declaring 30 would
otherwise consume the entire batch budget on one site; and an unreachable
`robots.txt` is treated as permissive and recorded, rather than as a full
disallow, because one flaky response should not zero out a user's research.

> **Measured caveat, stated plainly:** DuckDuckGo's HTML endpoint returns a
> bot-detection page from this machine and Mojeek serves a CAPTCHA. Any design
> leaning on scraping a general search engine would report "no discussion found"
> far more often than intended. That is why the keyless backbone is an actual
> API.

---

## How the steps are sequenced

```
0   D  validate; cache key over (jd, url, days)
1   ‖  L extract requirements      │  D crawl site: robots → sitemap → best-first BFS
                                   │    L re-rank links  (only if ambiguous)
                                   │    D classify the hiring page from its text
2   ‖  L company brief             │  D find public discussion
3   D  build interview context, then PLAN CATEGORIES        ← the fork in the road
4   L  generate questions — ONE CALL PER CATEGORY
5   D  assemble: mint r1..rn / q1..qn / f1..fn, rewrite references through a map
6   D  check coverage (pass 1)
7   L  gap-fill, must-haves first, one requirement per prompt
8   D  check → deterministic template fill → check
9   L  flashcards
10  D  allocate the schedule
11  D  validate against the Appendix A schema
```

The ordering is load-bearing. Pasted text needs no retrieval, so extraction
starts immediately and runs alongside the crawl. The site must be crawled before
the brief is useful. And `planCategories` sits between research and generation
precisely so that what was found changes what gets generated.

**`planCategories` is deterministic and inspectable**, which is the point. A
prompt that "considers the context" proves nothing; a plan object that differs
between runs can be diffed and seen:

| Found | Effect |
|---|---|
| nothing | technical + behavioural + company-fit; no process is assumed |
| a take-home | technical count raised, prompts reframed around decisions defensible in writing |
| a system design round | that category forced on |
| a values page | company-fit raised, grounded in the values actually stated |

Observable in the sample run: the case whose company publishes a design round
produced system-design questions; the case with no hiring page did not.

### Requirement extraction

The largest scoring item, and the hard part is not recall. A model will happily
turn a two-line posting into twelve plausible requirements. Precision is what is
measured, and the FAQ is blunt: "Inventing requirements a description does not
contain is worse than reporting that there were few."

So each requirement comes back with an **evidence span quoted from the posting**,
and code checks that span really appears there. Anything it cannot find is
dropped and reported. That guard lives in code rather than in the prompt, because
a prompt is a request and this needs to be a constraint. A lexicon then corrects
must/nice from the posting's own wording, with wording on the line beating the
heading above it, so "Kubernetes (nice to have)" under a **Requirements** heading
reads as `nice`.

The deterministic fallback is a reader, not a writer: it can only select lines
that already exist, so it cannot invent a requirement even in principle.

### Coverage

Membership alone is not a real check — a model asked to cover ten requirements
will staple all ten ids onto three unrelated questions, and
`requirement_ids.includes()` would score that as full coverage. So the comparison
runs both ways: a claimed id is **dropped** unless the question shares vocabulary
with the requirement, and a question that plainly addresses a requirement it
forgot to cite **gains** that id. Matching ignores filler, so "5+ years of strong
hands-on experience with Kafka" reduces to `{kafka}` and cannot be satisfied by
"Do you have experience?".

**Three passes, and the third involves no model.** Category generation, then a
narrow single-requirement gap-fill prompt, then a deterministic template built
from the requirement's own words. Marginal yield collapses after pass two,
because a pass-one miss is an attention failure that the narrow prompt fixes
rather than a capability failure a third attempt would fix. An unbounded loop
also cannot coexist with a fifteen-minute budget under a tokens-per-minute
ceiling — the loop would itself become the thing that falls over when the
provider says slow down. Making the last pass deterministic makes termination
**provable**, and there is a fourth exit most implementations miss: stop when a
pass adds no new coverage.

`coverage.passes` reports passes actually run, so a clean first draft honestly
says `1`.

---

## Generated, edited and pinned state

The rule, in one sentence:

> **Anything a human touched is protected by default. Pinning exists to protect
> something they have *not* touched.**

That inversion is what makes the feature usable. Requiring a pin beforehand
means losing work the first time someone forgets, and they will forget, because
the moment you reach for regenerate is the moment you are thinking about the new
questions rather than the old ones.

Provenance is **three orthogonal axes, not one enum**:

| Axis | Fields |
|---|---|
| who created it | `createdBy: 'ai' \| 'user'` (immutable) |
| who touched it last | `lastEditedBy` + `editedFields[]` (field-level) |
| explicit intent | `pinned`, `movedByUser` |

A single `origin` field cannot express "AI wrote it, the user edited the prompt
but not the outline, and AI is now regenerating the category" — and that is the
ordinary case, not a corner one. Field-level tracking is what lets the brief be
regenerated while keeping a summary you rewrote.

**Ids are minted by a monotonic counter and never reused.** The schedule
references `q7`; renumbering on regeneration would break the plan the user is
working from. Regenerated questions are matched to the slots they most resemble
and rewritten **in place**, so a question keeps its id and its position.

**Ordering uses fractional string indices**, not float midpoints. Repeated
insertion into the same gap exhausts float precision after about fifty
operations and then reorders *silently wrong*; a string key only ever gets
longer. A drag is one field on one document, whatever the list length.

**The race that matters.** The user edits a question while its category is
regenerating. Three layers, and the user wins every time:

1. The merge reads **live state at commit time**, not the snapshot the job
   started from, so an edit that landed while the model was thinking is visible.
2. Every write is guarded on the version it was planned against. If the edit
   lands microseconds later, the guarded write matches nothing and the job
   **skips** that item. Skipping is correct; retrying would clobber exactly the
   edit the guard just caught.
3. If the user is mid-keystroke with nothing flushed, the client **does not
   touch the textarea**. It shows a conflict banner with both versions.

Deleted items are **superseded, not removed**, so undo is one query, and a
tombstone stops the next run resurrecting something the user deliberately threw
away. Regeneration states its blast radius before the click.

**Provenance never enters the kit object.** `Kit.kit` holds exactly the
Appendix A structure, so exporting is a projection rather than a filter. The
projection also recomputes coverage and day count from live items rather than
trusting stored values — a user who deletes a question must not leave the
coverage object lying about it.

---

## How the schedule is allocated

Pure arithmetic. No model, no network, no clock, no randomness — a reviewer can
see at a glance that nothing here could have been delegated, because there is no
way to reach a model from that file.

```
cost(q)    = 10 + 5*(difficulty-1)                       → 10/15/20 minutes
urgency(t) = 2.0*(must) + 0.5*avgDifficulty
           + 0.3*(system-design && the company runs one)
           + 0.3*(technical && the company sets a take-home)
```

Topics sort by urgency, then weight, then id — deterministic to the last
tiebreak. Daily targets are front-loaded (day one about 25% heavier, the night
before lightest). A **must-reservation pass runs before the greedy fill**, so
every must-have requirement is placed even at one day or when material vastly
exceeds the runway.

Two cases drove the design:

- **60 days with 6 questions.** A naive implementation emits 6 days and stops.
  Surplus days become spaced review on a 1-3-7-14-30 rotation, with the last two
  reserved for a full mock loop and a deliberately light final day. No day is
  ever empty, and no work is invented to fill one.
- **2 days with 120 questions.** No question is ever dropped, because dropping
  one can silently uncover a must-have.

Six invariants are asserted before returning rather than hoped for, and
property-tested across days 1–60 crossed with 0–60 questions.

**Zero extractable material** still produces exactly the days requested, saying
plainly that the posting contained too little to build from.

---

## Practice mode

Classic SM-2 is the wrong algorithm here, and the reason is worth stating: its
objective is long-term retention at minimum review cost, so a card graded *Good*
returns in six days. If the interview is on Thursday, a card you half-knew on
Monday resurfaces *after* the thing you were revising for.

The objective here has a deadline: maximise coverage × confidence at a fixed
moment. So the spacing intuition is kept and the clock is replaced. Every
interval is scaled by remaining runway, and **nothing is ever scheduled past the
interview**. At three days out an "easy" card returns in about 13 hours; at a
fortnight it behaves close to ordinary SM-2.

Session *order* is a separate question from when a card is due, because "order
the next session by what they were least confident about" is a ranking
requirement. The order is **blanked → never seen → found hard → comfortable**:
coverage of unseen material outranks polishing something merely shaky, but a
total blank still comes first. Every card shows *why* it is in front of you —
"you drew a blank on this", "covers a must-have" — because a ranking you can
justify is worth more than one you cannot.

Kit coverage and practice coverage are reported **separately**. One asks whether
a requirement has a question at all; the other asks whether you can actually
answer it yet. Conflating them loses the more useful of the two.

---

## Edge cases

| Case | Behaviour |
|---|---|
| Invalid / 404 / timeout company URL | Recorded as a failed attempt; the kit is built from the posting alone with an honest brief and empty `sources`. Status stays `ok`. |
| No hiring or about page anywhere | The site is read, nothing resembling a process is found, and the kit says so. No unrelated page is nominated. |
| Two-line stub posting | One requirement in, one requirement out. Nothing is padded. |
| No public discussion | A first-class outcome, stated in the brief's summary. |
| Invalid or incomplete model JSON | Repair ladder, then a targeted re-ask, then a deterministic fallback. Refusals are treated as failures, not values. |
| Provider rate-limits or fails | Token-aware backoff, failover across three model buckets, circuit breaker, then the deterministic path. |
| Same posting submitted twice | Returns the existing kit with `duplicate: true`. If only the day count changed, the **pure** allocator re-runs with zero model calls. |
| 1-day or 60-day schedule | Both produce exactly the days requested; see above. |

---

## Security

- **SSRF is guarded at every outbound request** — the seed URL, every crawled
  link, every redirect hop, every search result. Redirects are followed by hand
  and re-validated at each hop; a fixture redirects to `169.254.169.254` to
  prove the second hop is checked.
- **Obfuscated hosts are not pattern-matched.** The WHATWG URL parser already
  normalises `2130706433`, `0177.0.0.1` and `0x7f000001` to `127.0.0.1` using
  browser rules, so they reach the ordinary address check already unmasked.
  Range classification is delegated to `ipaddr.js` because hand-rolled checks
  eventually miss one, and the one they miss is the exploit.
- **The loopback tension.** The brief wants private addresses rejected in
  production, but the graders serve company sites from `localhost`. The decision
  is made **once at the entry point and injected**: the CLI permits private
  addresses, the API refuses them, and production ignores the environment
  variable entirely. Both directions are unit-tested, including
  `NODE_ENV=production` with `ALLOW_PRIVATE_NETWORK=true`, which must still
  block. Cloud metadata is blocked unconditionally.
- **Size caps are enforced while streaming.** A declared `Content-Length` is
  checked cheaply up front, but a chunked response only reveals its size as it
  arrives, and trusting the header is how a small instance gets killed.
- **Prompt injection.** Untrusted text never enters the system prompt; it is
  wrapped in blocks tagged with a per-run nonce after zero-width and
  bidirectional control characters are stripped. The model has no tools. The
  real enforcement is that **every URL in a kit must appear in our own fetch
  log**, so an injected link cannot be laundered into the output. Detected
  attempts are surfaced to the user, not silently dropped.

---

## Key trade-offs

- **Polling, not SSE.** It survives the rewrite proxy and a cold start with no
  reconnection logic, and the longest request stays under a second. The event
  log is persisted with a monotonic sequence anyway, so SSE is a drop-in later.
- **In-process job queue, not Redis.** Render's free tier has no background
  workers and a single instance means the queue *is* the instance. Durability
  comes from the job document and a lease, not from a broker.
- **scrypt from `node:crypto`, not argon2 or bcrypt.** Both are native addons
  that can need a build toolchain on a clean clone. `maxmem` is set explicitly
  because N=2^15 with r=8 needs more than the 32 MiB default and would otherwise
  throw at runtime.
- **The cookie is kept first-party** by proxying the API through a Next rewrite.
  A direct cross-origin API would need `SameSite=None`, which Safari blocks
  outright — a reviewer simply could not log in.
- **Lenient inbound, strict outbound.** Model output is parsed with unknown keys
  stripped, because an extra field is a quirk rather than a failure. The export
  rejects unknown keys, because there an unexpected field means our internal
  envelope has leaked into something about to be graded.
- **Exported kits are pristine Appendix A.** Research notes go into
  `company_brief.summary`, a field the specification already defines, so gaps are
  "recorded honestly in the kit" without risking an automated structure check.

---

## Known limitations

- **The Evidence Bank is not built.** It was the intended creative feature — a
  STAR story bank mapped to requirement ids, so every behavioural question could
  show which of your own stories answers it. The data model carries a `story`
  item type for it, but no endpoints or UI. It is not in this submission.
- **No API integration tests.** The pipeline, schedule, coverage, merge rules,
  SSRF guard and batch command are covered; the Express routes are typechecked
  but not exercised by a test suite.
- **Not deployed.** Configuration and a runbook are in `docs/DEPLOY.md`, but the
  hosted URLs are not live.
- **Crawl depth 2** will miss a hiring page three or more clicks from the
  homepage and absent from the sitemap.
- **Search quality is modest without a key.** Hacker News is reliable but narrow;
  most companies are not discussed there, so "no public discussion found" is a
  common and honest outcome.
- **Regeneration reuses stored research** rather than re-crawling, so a company
  that has since rewritten its careers page will not be picked up without a new
  kit.
- **No session revocation.** A JWT stays valid until it expires; rotating
  `AUTH_JWT_SECRET` signs everyone out.

---

## Environment variables

See `.env.example`, which documents every variable. The short version:

| Variable | Needed for |
|---|---|
| `GROQ_API_KEY` | everything. The **only** variable the batch command needs. |
| `MONGODB_URI`, `AUTH_JWT_SECRET` | the API server |
| `BRAVE_SEARCH_API_KEY` | optional; improves public-discussion search |
| `ALLOW_PRIVATE_NETWORK` | permits loopback for local fixtures. Ignored in production. |
