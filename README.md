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
- `utils`: validation, TOV translation, LinkedIn mock parser, error middleware
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

## 3) AI Integration Patterns And Error Handling

Implementation in `aiService` follows production-safe patterns:

- OpenAI call wrapped in try/catch with standardized failure code: `AI_GENERATION_FAILED`.
- Two-stage parsing: direct JSON parse, then markdown-block extraction fallback.
- Structural validation enforces required fields (`messages[]`, `confidence`, per-message `step/message/reasoning`).
- Token usage and estimated cost are computed and persisted in `AIGeneration`.
- Raw AI response is stored for auditability; API returns controlled reasoning (`analysis` + per-message `reasoning`) rather than raw chain-of-thought tokens.

## 4) API Design Choices And Data Validation

Key API choices:

- Single focused endpoint: `POST /api/generate-sequence`.
- Zod validation on inbound payload (`prospect_url`, TOV range checks, required `company_context`, bounded `sequence_length`).
- Defensive validation in both controller and service layers.
- Deterministic idempotency check before AI generation to avoid duplicate cost.
- Idempotency is implemented via deterministic lookup on (`prospectId`, `tovConfigId`, `company_context`, `sequence_length`) before invoking the AI provider.
- Consistent error shape via global middleware; validation errors return `400`, AI failures return normalized `500`.

Data flow:

`LinkedIn URL -> Profile Analysis -> TOV Translation -> AI Generation -> Database Storage`

LinkedIn profile enrichment is deterministic mock data derived from the URL slug; company names are generated from the LinkedIn handle for consistency in demos, not as real-world company resolution logic.
In production, this would be replaced with official LinkedIn data access or a compliant enrichment provider, with caching, rate limiting, and retry policies.

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
- `PORT` (default `3000`)

## Tech Stack

- Node.js + TypeScript
- Express
- Prisma
- PostgreSQL (JSONB)
- OpenAI API
- Zod
