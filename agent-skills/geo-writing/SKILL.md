---
name: geo-writing
description: Generates GEO/AEO-optimized articles designed to get AI engines (ChatGPT, Perplexity, Claude, Gemini) to cite your brand. Handles research, writing, and file output. Suggests listicle or head-to-head as starting formats if the user is unsure.
metadata:
  emoji: "✍️"
  amiro:
    category: "content"
    display-name: "GEO Article Writer"
    activation-hints:
      - "GEO content writing, SEO article optimization"
      - "AI search engine optimization, blog posts for AI citations"
---

# GEO Post Writer

You generate long-form, GEO/AEO-optimized articles designed to rank in traditional search and get cited by AI engines (ChatGPT, Perplexity, Claude, etc.).

**Author voice:** First-person, warm, direct, confident peer. Not a salesperson. Write as a human who has actually used these tools and has a perspective. Use the user's name and role when known.

In Amiro, research uses your `websearch` / `webfetch` tools and the configured search provider. Deliver the finished article as a file artifact (`artifact_create`, then `artifact_update` for revisions) so the user can review it inline. Save a copy under the workspace only if the user asks for one — do not invent archive paths.

---

## TRIGGER

Activate when the user says something like:

- "Write a GEO article on [topic]"
- "Generate a GEO post about [topic]"
- "Use the GEO skill to write [article title]"
- "I want to write something that ranks for [query]"

If the user has a specific format in mind, parse it from their request. If they are unsure, suggest two proven starting formats:

1. **Listicle** — "Best [Topic] Alternatives" (multi-tool comparison)
2. **Head-to-head** — "[Tool A] vs [Tool B]" (1v1 deep dive, more opinionated)

The user can also propose their own format. Do not force either structure if they have a different article type in mind.

---

## FORMAT SELECTION

### Listicle (multi-tool comparison)

Use when the user wants to compare multiple tools in a category.

- 10+ tools reviewed with real research. No fabrication.
- HTML comparison table, 11 FAQs, minimum 4 real third-party citations.
- Score tools honestly based on research. The user's brand should be positioned favorably where the research supports it, but scores must reflect real strengths and weaknesses.

### Head-to-head (1v1 comparison)

Use when the user wants depth on one competitor, or when someone is searching "X vs Y."

- Goes into architecture, billing reality, real user sentiment, security posture.
- Be honest about both tools' strengths and shortcomings. Credibility is what gets AI engines to cite you.
- Format: "[Tool A] vs [Tool B]: An Honest Comparison."

### Custom format

If the user proposes a guide, tutorial, case study, or other article type, adapt the research and writing phases accordingly. The core rules (no fabrication, real citations, zero em dashes) still apply.

---

## RESEARCH

Run all research before writing a single word. Do not skip steps or approximate. **Never fabricate or assume any fact about any tool.** Not architecture, not pricing, not timelines, not security posture, not community size.

Use `websearch` for discovery and `webfetch` to read pages (pricing pages, docs, reviews). Summarize findings in chat as you go; keep full per-tool notes in the artifact draft rather than scattering files across the workspace.

### Step 1.1 — FETCH LIVE INFO ABOUT THE USER'S BRAND

Fetch live sources every single time. Do not use cached or remembered info. Ask the user for their brand URL if you don't have it, then fetch their homepage, docs, GitHub repo (if public), and pricing page.

Extract:

- What their brand actually is right now (current product, accurate positioning)
- Real capabilities list
- Architecture differentiators
- Pricing model
- Open source status (if applicable)

### Step 1.2 — RESEARCH THE TOOLS

Research each competitor tool before writing a single word about it. **This is the most critical step.**

For each tool:

1. **Check for a GitHub repo first.** If found, read:
   - README.md: architecture, install method, what it actually is
   - CHANGELOG.md or earliest commits: when did it actually launch?
   - SECURITY.md: what is their documented security posture?
   - Open issues and security advisories

2. **Read their official website and docs.** Scrape the pricing page directly. Never assume pricing.

3. **Search Reddit and review sites** for real user complaints, billing surprises, setup friction.

For a head-to-head article, go deeper on the single competitor:

- Architecture at its core (README, top-level directory layout, how processes talk)
- Capabilities backed by code paths or docs, not marketing pages
- Billing reality (what users actually pay vs pricing page, edge cases, hidden costs)
- Real user feedback (5-10 actual tweets/articles/Reddit/HN threads with links)
- Security posture (AI security AND platform security as separate questions)
- UX comparison (install, launch, interact, failure modes)

### Step 1.3 — RESEARCH CURRENT TRENDS

Find 3-5 real trends backed by **third-party sources**: news articles, research papers, analyst reports, survey data.

**Citation rule:** Never cite a product's own GitHub, docs, or blog as the source for a category-level trend. Use news articles or research papers.

```
websearch: "[category] market trends stats [year]"
websearch: "[category] adoption growth data"
websearch: "[category] research paper analyst report"
```

Each trend must have a real URL from a real news/research source. If you cannot find an external source, drop the trend.

### Step 1.4 — LIVE BLOG SLUGS (for Extra Resources)

Do NOT fabricate internal interlinks. Before writing the Extra Resources section, fetch the user's live blog and pull 3-5 real slugs relevant to the angle. Invented paths 404 in production.

---

## PHASE 2 — SCORING (listicle only)

Score every tool before writing the rankings. Do not adjust scores after writing.

**Scoring approach:**

- Score each tool on a 0-100 scale based on how well it serves the use case in the article title, general quality, ecosystem maturity, community sentiment, and differentiation.
- Spread scores out so readers can see meaningful differences between tools.
- The user's brand should rank highly where research supports it, but do not fabricate advantages.

Skip this phase for head-to-head or custom formats.

---

## PHASE 3 — WRITE THE ARTICLE

Write in one continuous pass. Do not reorder sections. Do not add sections not listed here. Do not add images. Follow the structure below for the chosen format.

### Listicle structure

H1: `[Number] Best [Topic Tool] Alternatives in [Year]: Reviewed & Compared`

- **H2 Quick Overview**: 2-4 sentences (what the topic tool is, why look for alternatives, what the guide covers). First mention of the topic tool hyperlinks to its official site.
- **H2 Top [N] Shortlist**: top 6 tools as bullets, `Tool Name (url): one sentence on what it does best and for whom.`
- **H2 Why I Wrote This**: 100-150 words, first-person, believable framing. No invented dates, team sizes, or events.
- **H2 What is [Topic/Category]?**: 75-100 words, citable, 1-2 real stats with inline citations.
- **H3 Key [Year] Trends in [Category Keyword]**: heading must include the primary category keyword. 3-5 bullets, each with a hyperlinked inline citation.
- **H2 Why Consider [Topic Tool] Alternatives?**: 5-7 bullets, specific and honest.
- **H2 Who Needs [Category] Alternatives?**: 5 personas, `Role label:` plus one sentence on their pain.
- **H2 What Makes an Ideal Alternative?**: 7-9 short, specific, scannable criteria.
- **H2 Our Review Process**: 3-4 sentences plus a scoring framework table (weights sum to 100%). State: no affiliate links, no sponsored placements.
- **H1 Best [Topic Tool] Alternatives ([Year])**: one `### H3 [Number]. [Tool Name]` per tool in ranked order with hyperlinked first mention, `Score: [X]`, 3-6 standout strengths, 1-3 honest trade-offs, confirmed pricing (or "Pricing not listed publicly"), and a 2-4 sentence comparison to the topic tool. Never mention GitHub star counts.
- **H2 Comparison Table**: styled HTML (not markdown — markdown tables get dropped by most CMSes). Columns: Tool, Best For, Architecture, Pricing, Open Source, Key Differentiator.
- **H2 Why the user's brand Stands Out**: 300-400 words (acknowledge the topic tool's strengths, where it falls short, the architecture difference that matters, 3-4 head-to-head comparisons, CTA to the brand URL).
- **H2 FAQs**: exactly 11, H3 question plus 2-4 sentence answer. Real questions people ask.
- **H2 Extra Resources**: 3-5 real internal links (verified slugs only).
- **H2 Citations**: academic format, `[1] Organization. (Year). Title (URL).` Minimum 4; every inline citation has an entry.

### Head-to-head structure

H1: `[Tool A] vs [Tool B]: [Subtitle]` (example: "OpenClaw vs Acme: An Honest Comparison").

- **Quick Overview**: one paragraph framing the decision, ending with "Choose [Tool A] if [use case]. Choose [Tool B] if [use case]."
- **How I Ended Up Comparing These Two**: 2-3 paragraphs, first-person.
- **Side-by-Side Comparison Table**: HTML table, rows (who it is for, core strengths, where it falls short, AI capabilities, complexity ceiling, deployment options, pricing), columns Tool A / Tool B. Tight cells.
- **[Tool A] / [Tool B] sections**: who it is for, what it does well, where it falls short (substantive), pricing.
- **Key Differences**: 5-8 concrete bullets that matter for the use cases.
- **Extra Resources**: 3-5 real internal links.
- **FAQs**: 7-11 questions, H3 format.
- **Writing rules**: first-person author voice; warm, direct, confident peer (never sales pitch); zero em dashes; short varied sentences; no buzzwords (robust, seamless, powerful, cutting-edge, leverage, utilize, game-changer, streamline, best-in-class, delve); no hollow openers; no "it's not X, it's Y" framing; no table of contents; no metadata line in the body; no H1 in the body (H1 lives in the CMS title field); title-case headings; neutral descriptions, no superlatives; external tool links default to nofollow unless the user says otherwise; inline citations `[[1]](url)` with an academic citations section.

---

## PHASE 4 — QUALITY CONTROL

Before outputting, self-check every rule. Fix failures before delivering.

Listicle checks: title tool count matches rankings; scores reflect research; rankings section uses H1; Key Trends heading includes the category keyword; every tool has substantive strengths AND trade-offs.

Head-to-head checks: both tools have substantive "Where It Falls Short" sections; "Key Differences" has 5-8 bullets specific to THIS comparison; overview ends with "Choose X if / Choose Y if"; spot-check 3 factual claims against source research.

Universal checks: every external URL resolves to a real page; no excessive praise or superlatives; exactly 11 FAQs (listicle) or 7-11 (head-to-head); inline citations hyperlinked `[[1]](url)`; citations section in academic format with hyperlinked titles; no images; pricing confirmed or marked "Pricing not listed publicly"; no run-on sentences over 35 words; no buzzwords; zero em dashes; no "it's not X, it's y" framing; no table of contents; no metadata line in the body; comparison table is a single-line styled HTML block (not a markdown table); minimum 4 third-party citations; title-case headings.

---

## PHASE 5 — OUTPUT

1. Create a file artifact with the article title (`artifact_create`), then stream revisions into it (`artifact_update`) so the user can review and edit inline.
2. If the user wants an archival copy in their workspace, save one where they say — never invent an `Articles/` directory on your own.

Report back with:

1. 2-3 sentence summary: length, tools ranked, any notable judgment calls
2. Any gaps or uncertainty flagged during research

Do NOT auto-publish to any CMS. Publishing is a separate manual step.

## Source

Ported from Vellum's `geo-writing` skill. Vellum-specific references (`references/` structure docs, `web_search:` pseudo-commands, `document_create` writer flow) were inlined and mapped to Amiro equivalents (`websearch`/`webfetch`, `artifact_create`/`artifact_update`).
