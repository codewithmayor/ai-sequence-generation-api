# AI Sequence Generation API

Backend API that takes a LinkedIn prospect URL, tone-of-voice settings, and company context, then returns a personalized LinkedIn message sequence.

## Live Demo

- Base URL: https://ai-sequence-generation-api-production.up.railway.app/
- Health: https://ai-sequence-generation-api-production.up.railway.app/health

## Core Endpoint

`POST /api/generate-sequence`

Request:

```json
{
  "prospect_url": "https://linkedin.com/in/john-doe",
  "tov_config": {
    "formality": 0.8,
    "warmth": 0.6,
    "directness": 0.7
  },
  "company_context": "We help SaaS companies automate sales",
  "sequence_length": 3
}
```

Response:

```json
{
  "analysis": {
    "prospect_insights": "...",
    "personalization_hooks": ["..."],
    "value_proposition": "..."
  },
  "messages": [
    {
      "step": 1,
      "message": "...",
      "reasoning": "..."
    }
  ],
  "confidence": 0.85
}
```

## Architecture (Concise)

- `controllers`: HTTP request/response only
- `services`: orchestration + AI integration
- `utils`: validation, TOV translation, LinkedIn parsing, role–context strategy engine, error middleware
- `utils/roleContextStrategy.ts`: derives target role from `company_context`, extracts capability tags, intersects with role-allowed workflows, computes alignment score
- `services/enrichmentProviderFactory.ts`: config-based enrichment provider selection (mock now, provider-backed later)
- `db/prisma.ts`: Prisma client singleton
- `prisma/schema.prisma`: relational models + JSONB fields

---

## 1) Database Schema Decisions And Why

The schema is designed around one generation lifecycle:

- **Prospect**: stores LinkedIn anchor data (`linkedinUrl`, `fullName`, `headline`, `company`, `profileData`)
- **TovConfig**: stores normalized TOV numeric settings + translated description
- **MessageSequence**: stores campaign output (`messages`, `analysis`, `confidence`) and request context
- **AIGeneration**: stores model metadata, token usage, estimated cost, and raw AI response

Why this shape:

- Keeps request context (`prospect`, `tov`, `company_context`, `sequence_length`) separate from generated output.
- Supports idempotent lookup before paying AI cost again.
- Uses JSONB (`profileData`, `messages`, `analysis`, `rawResponse`, `thinking`) for AI-shaped payload flexibility.
- Preserves observability (cost, model, prompt version) for later analysis.
- Uses a DB transaction so writes for one generation are atomic.

## 2) Prompt Engineering Approach

Prompting is intentionally structured, not ad hoc:

- TOV sliders are converted into natural language (`tovTranslator`) before being sent to the model.
- System prompt defines a strict JSON contract and message quality constraints.
- User prompt injects prospect data, company context, TOV description, and exact sequence length.
- Output is requested as JSON (`response_format: json_object`) to reduce parsing ambiguity.
- Prompt version is tracked (`PROMPT_VERSION`) and persisted for traceability.

### Adaptive Narrative Progression

Messages are not independent — they form a developing story. Each step adds a new narrative layer instead of repeating the same friction in different words. The layer model scales with `sequence_length`:

| Length | Layers |
|--------|--------|
| 1 | Observation + CTA |
| 2 | Observation → Improvement + CTA |
| 3 | Observation → Workflow Spotlight → Improvement + CTA |
| 4 | Observation → Spotlight → Causal Link → Improvement + CTA |
| 5+ | ...adds Social Proof, Cross-team Expansion |

The model picks ONE friction most relevant to `company_context` and builds all messages around it. This prevents the "4 complaints" anti-pattern where each message restates the same angle.

### Upstream Friction Framing

Value is framed differently depending on the prospect's role:

- **Sales roles**: framed as direct workflow improvement — better targeting, faster qualification, less manual enrichment, pipeline velocity.
- **Non-sales roles**: framed as **upstream friction reduction from their perspective**. Not "we help sales qualify prospects earlier" — instead, what changes *for them*: fewer interruptions, less validation noise, better filtering before escalation, reduced internal back-and-forth.

Example for a Security Engineer:

| Wrong (sales-centric) | Right (their perspective) |
|---|---|
| "We help sales qualify prospects earlier." | "We reduce how often security gets pulled into late-stage reviews for deals that were never a fit." |

This ensures messages sound like they understand the prospect's world — not like a sales pitch forwarded to the wrong person.

## 3) AI Integration Patterns And Error Handling

Implementation in `aiService` follows production-safe patterns:

- ONE system prompt + ONE user prompt + ONE model call. No chained prompts, no repair loops.
- OpenAI call wrapped in try/catch with standardized failure code: `AI_GENERATION_FAILED`.
- Two-stage parsing: direct JSON parse, then markdown-block extraction fallback.
- Structural validation enforces required fields (`messages[]`, `confidence`, per-message `step/message/reasoning`).
- Content quality validators log grounding issues (domain overreach, generic filler, restatement) but accept small imperfections — optimizing cost and complexity over perfection.
- In-code text sanitization catches persistent banned phrases post-generation.
- Role-aware validators: for non-sales roles, core domain overreach is flagged; for sales roles, direct workflow improvement claims are expected.
- Token usage and estimated cost are computed and persisted in `AIGeneration`.
- Raw AI response is stored for auditability; API returns controlled reasoning (`analysis` + per-message `reasoning`) rather than raw chain-of-thought tokens.

### Internal Observability Logging

The system logs structured diagnostics at every decision point — none of this is exposed to API consumers, but it's available in server logs for debugging, auditing, and product iteration:

- **Prompt lengths** (chars) before OpenAI call — tracks prompt bloat over time.
- **Token usage breakdown** (prompt / completion / total) + estimated USD cost after every call.
- **Role–context strategy** — logged on every request: `prospectRole`, `targetPersona`, `personaShifted`, `capabilityTags`, `activeWorkflows`, `alignmentScore`, `alignmentNote`.
- **Low alignment warnings** — if `alignmentScore < 0.25`, a warning is emitted: `"Low contextual alignment between prospect role and company_context"`. The system knows when the pitch and persona don't match well.
- **Quality issues** — post-generation validators log grounding issues (domain overreach, generic filler, restatement detection) but accept the output. No repair pass, no double cost.
- **Idempotency events** — cache hits and prompt-version mismatches are logged with sequence IDs.
- **Strategy persistence** — the full strategy (`prospectRole`, `targetPersona`, `capabilityTags`, `activeWorkflows`, `alignmentScore`) is stored in the `thinking` JSONB field on `AIGeneration`, making every persona derivation auditable after the fact.

This is product thinking: the system doesn't just generate — it knows when it's on shaky ground and leaves a trail.

## 4) API Design Choices And Data Validation

Key API choices:

- Single focused endpoint: `POST /api/generate-sequence`.
- Zod validation on inbound payload (`prospect_url`, TOV range checks, required `company_context`, bounded `sequence_length`).
- Defensive validation in both controller and service layers.
- Deterministic idempotency check before AI generation to avoid duplicate cost.
- Idempotency is implemented via deterministic lookup on (`prospectId`, `tovConfigId`, `company_context`, `sequence_length`) and current `promptVersion` before invoking the AI provider.
- Consistent error shape via global middleware; validation errors return `400`, AI failures return normalized `500`.

Data flow:

`LinkedIn URL → Enrichment → Role–Context Strategy → TOV Translation → AI Generation → Database Storage`

In a production environment, I would integrate with an official LinkedIn partner API or a compliant enrichment provider such as People Data Labs or Proxycurl.
For this exercise, I implemented deterministic mock enrichment derived from the LinkedIn slug to simulate realistic profile data while keeping the system architecture production-ready and legally safe.
The enrichment layer is abstracted behind a `ProspectEnrichmentProvider` interface, so the generation pipeline remains unchanged when swapping implementations.

### Role–Context Strategy Engine

The system does not rely on the LinkedIn URL slug alone to determine what frictions to surface. Instead, it derives the target role **deterministically from `company_context`**, then intersects it with structured capability and workflow data to produce a focused message strategy.

**Pipeline:**

```
company_context
  ├── inferTargetRoleFromContext()     → target persona (weighted keyword scoring)
  ├── extractCapabilityTags()          → what the company's product does
  ├── ROLE_ALLOWED_WORKFLOWS[persona]  → causally valid frictions for this persona
  ├── intersectWorkflows()             → only frictions the company CAN address AND the persona experiences
  └── computeAlignmentScore()          → 0–1 quality signal (logged internally)
```

The system maintains a clean separation between **prospectRole** (who they are, from the URL slug) and **targetPersona** (who the pitch is aimed at, from `company_context`). The profile is **never remapped** — the prospect keeps their authentic identity (skills, headline, title). When the persona differs, a `TARGET PERSONA` signal is injected into the prompt, telling the model which frictions to surface while personalizing with the prospect's real data. This prevents grounding drift: identity stays truthful, only strategy adapts.

**Example:**

| Input | Result |
|-------|--------|
| URL slug: `john-doe` (→ Engineering) | |
| Context: `"We help sales teams qualify prospects so fewer security reviews are triggered"` | |
| Inferred persona: **Security** (keyword: `security review`) | |
| Capability tags: `qualification`, `filtering`, `security-review-reduction` | |
| Active workflows: `security-questionnaires`, `compliance-checks`, `pre-sales-feasibility`, `unqualified-escalations` | |
| Alignment score: **1.0** (strong) | |

The AI prompt receives only the **intersected frictions** — not a static list of every possible friction for the role. This ensures every message is causally grounded in what the company actually does.

**Alignment scoring** (internal, not exposed to API):

| Score | Meaning |
|-------|---------|
| ≥ 0.75 | Strong — capabilities directly address most role frictions |
| ≥ 0.50 | Moderate — some role frictions addressable |
| < 0.25 | Low — logged as warning (context and role don't match well) |

This demonstrates: deterministic persona derivation, explicit persona storage (persisted in `thinking.strategy` JSONB), persona → workflow mapping, context → capability mapping, intersection-based strategy, and alignment-aware logging.

### Enrichment Architecture

The enrichment layer produces a strongly typed `ProspectProfile`:

```
ProspectProfile {
  fullName, headline, company,
  roleCategory: Engineering | DevOps | Security | Data | Product | Sales
  seniority: Senior | Manager | Lead | Founder
  skills: string[]                    // static per roleCategory
  inferredResponsibilities: string[]  // deterministic per roleCategory
}
```

The AI pipeline consumes `roleCategory`, `seniority`, `skills`, and `inferredResponsibilities` directly — it never infers role randomly.

### How Deterministic Mock Enrichment Works

1. **URL normalization**: strip protocol, `www`, trailing slash, query params, fragments → clean slug.
2. **Role inference**: `hash(slug + "role") % 6` → deterministic index into `[Engineering, DevOps, Security, Data, Product, Sales]`. Same name → same role, always.
3. **Seniority inference**: `hash(slug + "seniority") % 4` → deterministic index into `[Senior, Manager, Lead, Founder]`. Same name → same seniority, always.
4. **Static skill mapping**: skills are fixed per role (e.g., Engineering → TypeScript, Node.js, System Design).
5. **Static responsibility mapping**: responsibilities are fixed per role (e.g., Engineering → backend platform ownership, release quality, cross-team technical validation).
6. **Company**: neutral placeholder (`"their current company"`) — real enrichment providers would supply the actual company name. No fabricated names.
7. **Idempotent**: same LinkedIn URL always yields the same profile. No randomness, no keyword matching — pure hash-based deterministic mapping.

### Framework And Execution Tradeoffs

- **Why Express over Fastify?** In this prototype, end-to-end latency is dominated by the AI call. Express provided the fastest path to stable routing and middleware with minimal setup.
- **Why not Nest?** Nest adds strong structure, but module/DI scaffolding was unnecessary for a single-service implementation under a strict timebox.
- **Why not a background queue yet?** Keeping generation synchronous made the full request path easier to validate and demo; queue-based async execution is the next production step.
- **Why not a separate worker process yet?** Worker processes require broker, retry orchestration, and deployment coordination. The current service boundaries are already designed to move into workers without redesign.

## 5) What I'd Improve With More Time

- Move AI generation to async queue + worker process (BullMQ/SQS) for throughput and retries.
- Add authentication, per-tenant quotas, and rate limiting.
- Add Redis caching for hot idempotent reads.
- Add full test suite (unit + integration + contract tests).
- Add prompt experimentation framework (A/B prompt versions with quality/cost metrics).

---

## Quick Start

Prereqs:

- Node.js 18+
- PostgreSQL 14+
- OpenAI API key

Install and run:

```bash
npm install
npm run prisma:generate
cp env.example .env
npm run prisma:migrate
npm run dev
```

Useful commands:

```bash
npm run build
npm start
npm run prisma:studio
```

## Environment Variables

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `ENRICHMENT_PROVIDER` (`mock` by default)
- `PORT` (default `3000`)

## Tech Stack

- Node.js + TypeScript
- Express
- Prisma
- PostgreSQL (JSONB)
- OpenAI API
- Zod
