import { describe, expect, it } from 'vitest';
import {
  assessHiringPage,
  needsModelRerank,
  rankLinks,
  type RankableLink,
} from './rankLinks.js';

function link(url: string, anchor: string, extra: Partial<RankableLink> = {}): RankableLink {
  return {
    url,
    anchor,
    inChrome: false,
    context: '',
    depth: new URL(url).pathname.split('/').filter(Boolean).length,
    ...extra,
  };
}

const topUrl = (links: RankableLink[]) => rankLinks(links)[0]!.url;

describe('it finds hiring pages at paths no list would predict', () => {
  it('ranks a GitLab-shaped handbook path above the obvious candidates', () => {
    // The brief names GitLab specifically: the hiring process lives in a
    // handbook, several levels deep, and is not at /careers.
    const links = [
      link('https://handbook.gitlab.com/handbook/hiring/', 'Hiring', { inChrome: true }),
      link('https://about.gitlab.com/pricing/', 'Pricing', { inChrome: true }),
      link('https://about.gitlab.com/blog/2019/party/', 'Our summer party'),
      link('https://about.gitlab.com/privacy/', 'Privacy Notice', { inChrome: true }),
    ];
    expect(topUrl(links)).toBe('https://handbook.gitlab.com/handbook/hiring/');
  });

  it('ranks a PostHog-shaped nested hiring-process path first', () => {
    const links = [
      link('https://posthog.com/handbook/people/hiring-process', 'Hiring process'),
      link('https://posthog.com/handbook/', 'Handbook', { inChrome: true }),
      link('https://posthog.com/blog/', 'Blog', { inChrome: true }),
      link('https://posthog.com/pricing', 'Pricing', { inChrome: true }),
    ];
    expect(topUrl(links)).toBe('https://posthog.com/handbook/people/hiring-process');
  });

  it('prefers the process page over the careers index that links to it', () => {
    const links = [
      link('https://acme.example/careers', 'Careers', { inChrome: true }),
      link('https://acme.example/careers/interview-process', 'What to expect in our interviews'),
    ];
    expect(topUrl(links)).toBe('https://acme.example/careers/interview-process');
  });

  it('finds the process even when the anchor text is uninformative', () => {
    // "Read more" tells us nothing; the path and the surrounding text do.
    const links = [
      link('https://acme.example/blog/latest', 'Read more'),
      link('https://acme.example/company/joining-us/how-we-interview', 'Read more', {
        context: 'Curious what our interview process looks like? Read more',
      }),
    ];
    expect(topUrl(links)).toBe('https://acme.example/company/joining-us/how-we-interview');
  });
});

describe('what it pushes down', () => {
  it('deprioritises an individual job advert against the process description', () => {
    // We want the description of how they hire, not one open vacancy.
    const links = [
      link('https://acme.example/jobs/48213', 'Senior Backend Engineer'),
      link('https://acme.example/how-we-hire', 'How we hire'),
    ];
    expect(topUrl(links)).toBe('https://acme.example/how-we-hire');
  });

  it('recognises an applicant-tracking job id as a single posting', () => {
    const ranked = rankLinks([
      link('https://boards.greenhouse.io/acme/jobs/4001?gh_jid=4001', 'Backend Engineer'),
      link('https://acme.example/careers', 'Careers', { inChrome: true }),
    ]);
    expect(ranked[0]!.url).toBe('https://acme.example/careers');
  });

  it('scores legal and account pages negatively', () => {
    const ranked = rankLinks([
      link('https://acme.example/privacy', 'Privacy policy'),
      link('https://acme.example/login', 'Log in'),
      link('https://acme.example/terms', 'Terms of service'),
    ]);
    for (const r of ranked) expect(r.score).toBeLessThan(0);
  });

  it('applies only a mild depth penalty, holding vocabulary constant', () => {
    // Same words, different depth — so this isolates the penalty itself.
    const shallow = rankLinks([link('https://acme.example/hiring', 'Hiring')])[0]!;
    const deep = rankLinks([link('https://acme.example/a/b/c/d/hiring', 'Hiring')])[0]!;
    expect(deep.score).toBeLessThan(shallow.score);
    expect(deep.score).toBeGreaterThan(0); // penalised, not disqualified
  });

  it('lets richer vocabulary outweigh depth, which is why handbooks are findable', () => {
    // A deep handbook path SHOULD beat a shallow bare one: `handbook` and
    // `people` are real signal, and this is exactly the GitLab/PostHog shape.
    const bare = rankLinks([link('https://acme.example/hiring', 'Hiring')])[0]!;
    const handbook = rankLinks([
      link('https://acme.example/handbook/people/hiring', 'Hiring'),
    ])[0]!;
    expect(handbook.score).toBeGreaterThan(bare.score);
  });
});

describe('placement and corroboration', () => {
  it('treats a site-wide chrome link as more canonical than a body link', () => {
    const inFooter = rankLinks([link('https://acme.example/careers', 'Careers', { inChrome: true })])[0]!;
    const inBody = rankLinks([link('https://acme.example/careers', 'Careers')])[0]!;
    expect(inFooter.score).toBeGreaterThan(inBody.score);
  });

  it('rewards a URL that also appears in the sitemap', () => {
    const url = 'https://acme.example/careers';
    const withSitemap = rankLinks([link(url, 'Careers')], { sitemapUrls: new Set([url]) })[0]!;
    const without = rankLinks([link(url, 'Careers')])[0]!;
    expect(withSitemap.score).toBeGreaterThan(without.score);
  });

  it('rewards a URL linked from several crawled pages', () => {
    const url = 'https://acme.example/careers';
    const corroborated = rankLinks([link(url, 'Careers')], {
      inboundCounts: new Map([[url, 3]]),
    })[0]!;
    expect(corroborated.score).toBeGreaterThan(rankLinks([link(url, 'Careers')])[0]!.score);
  });
});

describe('the about profile reuses the same scorer', () => {
  it('ranks the about page first when asked for one', () => {
    const links = [
      link('https://acme.example/careers', 'Careers', { inChrome: true }),
      link('https://acme.example/about', 'About us', { inChrome: true }),
    ];
    const ranked = rankLinks(links, { profile: 'about' });
    expect(ranked[0]!.url).toBe('https://acme.example/about');
  });
});

describe('when to spend a model call on re-ranking', () => {
  it('skips the call when one candidate is clearly ahead', () => {
    const ranked = rankLinks([
      link('https://acme.example/how-we-hire', 'How we hire: our interview process', {
        inChrome: true,
      }),
      link('https://acme.example/privacy', 'Privacy'),
    ]);
    expect(needsModelRerank(ranked)).toBe(false);
  });

  it('asks for the call when nothing scores convincingly', () => {
    // This is the case a model genuinely beats keywords: no hiring vocabulary
    // anywhere, so the heuristic has nothing to go on.
    const ranked = rankLinks([
      link('https://acme.example/resources', 'Resources'),
      link('https://acme.example/updates', 'Updates'),
      link('https://acme.example/more', 'More'),
    ]);
    expect(needsModelRerank(ranked)).toBe(true);
  });

  it('asks for the call when the top three are too close to separate', () => {
    const ranked = rankLinks([
      link('https://acme.example/careers', 'Careers'),
      link('https://acme.example/jobs', 'Jobs'),
      link('https://acme.example/join', 'Join us'),
    ]);
    expect(needsModelRerank(ranked)).toBe(true);
  });

  it('does not ask when there is nothing to rank', () => {
    expect(needsModelRerank([])).toBe(false);
  });
});

describe('deciding whether a fetched page really describes a process', () => {
  it('is confident about an ordered, list-shaped description', () => {
    const text = `## How we hire
- 1. Recruiter screen, 30 minutes
- 2. Take-home exercise
- 3. System design interview
- 4. Values interview with the hiring manager
- 5. Offer`;
    const assessment = assessHiringPage(text);
    expect(assessment.confidence).toBe('confident');
    expect(assessment.signals.systemDesign).toBe(true);
    expect(assessment.signals.takeHome).toBe(true);
    expect(assessment.signals.values).toBe(true);
  });

  it('is only weakly confident about a passing mention', () => {
    const text =
      'We are hiring! There is a recruiter screen, and later an onsite, but we do not describe the rest here.';
    expect(assessHiringPage(text).confidence).toBe('weak');
  });

  it('does not call a single stray stage word a hiring page', () => {
    // A false positive here wrongly changes which question categories get
    // generated, so one passing word must not be enough.
    const text = 'Our recruiter will be in touch for a screen.';
    expect(assessHiringPage(text).confidence).toBe('none');
  });

  it('finds nothing in an ordinary marketing page', () => {
    const text = 'Acme builds warehouse robotics for logistics companies worldwide.';
    const assessment = assessHiringPage(text);
    expect(assessment.confidence).toBe('none');
    expect(assessment.signals.systemDesign).toBe(false);
    expect(assessment.signals.takeHome).toBe(false);
  });

  it('reports no signals for an empty page rather than throwing', () => {
    expect(assessHiringPage('').confidence).toBe('none');
  });
});

describe('lexicon word forms', () => {
  // Regression guards: each of these once scored zero and cost a real ranking.
  it.each([
    ['Hiring', 'https://acme.example/hiring'],
    ['Joining us', 'https://acme.example/joining-us'],
    ['Careers', 'https://acme.example/careers'],
    ['Recruiting', 'https://acme.example/recruiting'],
    ['Openings', 'https://acme.example/openings'],
  ])('recognises %s as careers vocabulary', (anchor, url) => {
    expect(rankLinks([link(url, anchor)])[0]!.score).toBeGreaterThan(0);
  });
});
