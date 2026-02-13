# AI Sequence Generation API

You hand this service a LinkedIn URL and some context about your company, and it hands you back a realistic, insight-driven outreach sequence.  
No toy examples, no hard-coded JSON. This is a production-minded backend that treats AI like an infrastructure dependency, not a magic trick.

## Live Demo

- Base URL: https://ai-sequence-generation-api-production.up.railway.app/
- Health check: https://ai-sequence-generation-api-production.up.railway.app/health

## Architecture Overview

The app is intentionally small but not shallow. It follows a layered structure that's easy to reason about under operational pressure:

```text
src/
├── index.ts              # Express app entry point
├── routes/               # HTTP route definitions
├── controllers/          # HTTP request/response handling
├── services/             # Business logic layer
│   ├── sequenceService.ts    # Core sequence generation orchestration
│   └── aiService.ts          # OpenAI integration & prompt engineering
├── db/                   # Database access layer
│   └── prisma.ts         # Prisma client singleton
└── utils/                # Shared utilities
    ├── validation.ts     # Zod schemas
    ├── errorHandler.ts   # Global error middleware
    ├── tovTranslator.ts  # Tone-of-voice numeric → natural language
    └── linkedinParser.ts # Mock LinkedIn profile parser
```

**Design principles (the “we actually ship this” rules):**
- Controllers handle HTTP only. No business logic, no ORM calls.
- Services own business logic and orchestration.
- All AI integration lives in `aiService` so you can swap models/prompts without touching controllers.
- Prisma sits behind a single client in `db/prisma.ts`.
- Input validation is Zod-powered: happens at controller layer for early rejection, and again in service as a defensive check.
- A global error handler gives consistent JSON errors.
- Everything is async/await; no callbacks, no promise pyramids.

## End-to-End Data Flow

When a request hits `/api/generate-sequence`, here's what happens:

1. **Request validation** — Zod schema validates the payload shape and value ranges.
2. **Idempotency check** — Look up existing sequence by prospect URL, company context, TOV values, and sequence length. If found, return cached result and skip AI.
3. **LinkedIn parsing** — Extract handle from URL and generate mock profile data (structured name, headline, company, experience, skills).
4. **TOV translation** — Convert numeric formality/warmth/directness values into natural language descriptions.
5. **AI generation** — Call OpenAI with system + user prompts, parse JSON response, validate structure.
6. **Response validation** — Ensure messages array exists, confidence is numeric, each message has step/message/reasoning.
7. **Transactional persistence** — Within a single Prisma transaction: upsert Prospect, find/create TovConfig, insert MessageSequence, insert AIGeneration with token usage.
8. **Response return** — Return analysis, messages array, and confidence score to the client.

The idempotency check happens before any AI calls, so duplicate requests return instantly without cost.

## Database Schema Design

AI features are only as good as the data model they sit on. This schema is built to keep things observable and evolvable, not just “working on my machine”.

### Models

**Prospect**
- Stores LinkedIn profile information.
- `linkedinUrl` is unique and indexed so everything fans out from a single anchor.
- `profileData` (JSONB) carries the flexible, semi-structured profile payload.

**TovConfig**
- Represents tone-of-voice configuration:
  - `formality`, `warmth`, `directness` in the 0–1 range.
- `description` is the human-readable version we feed into prompts.

**MessageSequence**
- Core entity for a generated outreach sequence.
- Linked to both `Prospect` and `TovConfig`.
- Stores:
  - `messages` (JSONB array of steps)
  - `analysis` (JSONB with insights/hooks/value prop)
  - `confidence` (float).

**AIGeneration**
- One row per AI call.
- Tracks:
  - `model`
  - `promptVersion`
  - `promptTokens`, `completionTokens`, `totalTokens`
  - `estimatedCost`
  - `rawResponse` (JSONB)
  - `thinking` (JSONB)
- Lets you audit “what did we ask for, what did we pay, what came back?”

### Why JSONB?

Postgres JSONB is the middle ground between “YOLO JSON” and over-normalized misery:

1. **Flexibility**: AI responses evolve; JSONB lets you roll with it without migrations every week.
2. **Query performance**: You can still index and query into the JSON when you care.
3. **Future-proofing**: New fields and metadata slot in without touching the relational shape.
4. **Cost tracking**: Raw responses live in JSONB so you can do post-hoc analysis.

**Tradeoffs:**
- The DB won’t enforce schemas for you. TypeScript + Zod do that job at the edges.
- JSONB querying is a bit more verbose, but acceptable given the current workload.

### Relations & Constraints

- `MessageSequence` → `Prospect`: cascade delete when a prospect disappears.
- `MessageSequence` → `TovConfig`: restrict delete to keep shared configs intact.
- `AIGeneration` → `MessageSequence`: cascade delete audit rows with their parent.

### Transaction Usage

All the writes that make up “one generation” happen inside a single `prisma.$transaction`:
- Upsert the `Prospect`.
- Find or create the `TovConfig`.
- Insert the `MessageSequence`.
- Insert the `AIGeneration`.

Either the whole thing commits, or none of it does. No half-baked AI runs left dangling.

## AI Integration & Prompt Engineering

The model isn’t magic; it’s an expensive function call that needs rails.

### Where Is The “Thinking Process”?

- The API exposes structured reasoning per message through each message object's `reasoning` field.
- The `analysis` object provides prospect-level reasoning (insights, hooks, and value framing).
- The system intentionally does not expose raw chain-of-thought tokens in API responses.
- Instead, it returns a controlled reasoning summary designed for production-safe transparency.
- Raw AI responses and deeper reasoning traces are persisted internally in `AIGeneration` for auditability.

### Model Selection

- **Model**: `gpt-4o-mini` — small, fast, and cheap enough to iterate with.
- **Temperature**: `0.7` — creative without going off the rails.
- **Response format**: `json_object` — we always ask for JSON, never prose.

### Prompt Design

**System prompt:**
- Locks in an explicit JSON schema:
  - `analysis` with `prospect_insights`, `personalization_hooks[]`, and `value_proposition`.
  - `messages[]` with `step`, `message`, `reasoning`.
  - `confidence` as a numeric score.
- Bans markdown and extra commentary.
- Forces LinkedIn-native behavior:
  - No subject lines, no email formatting, no signatures, no placeholders.
  - Step 1 under 60 words.
  - Conversational tone, not brochureware.
  - Anti-generic guardrails against common cold-outreach clichés.
- Pushes the model to:
  - Reason from role, seniority, and company, not just skill keywords.
  - Infer likely responsibilities and challenges.
  - Make each message include at least one specific observation and feel like thoughtful peer outreach.

**User prompt:**
- Passes in:
  - Prospect details (name, headline, company).
  - Structured profile JSON.
  - Company context describing the product and who it helps.
  - Humanized tone-of-voice description.
  - Exact sequence length.
- Repeats the rules so the model can’t pretend it didn’t see them.

### Handling AI Variability

**JSON parsing:**
- First, attempt a straight `JSON.parse()` on the response.
- If that fails, look for ```json ... ``` or ```...``` blocks and parse the inner content.
- If the model still won’t cooperate:
  - Log a snippet of the bad output.
  - Fall back to a standardized AI error instead of throwing raw exceptions.

**Response validation:**
- Ensure:
  - `messages` exists and is an array.
  - `confidence` is a number.
  - Each message includes `step`, `message`, and `reasoning`.
- On invalid structure, we log what we got and return a safe error.

**Token & cost tracking:**

```typescript
// Cost calculation (as of 2024 pricing)
const estimatedCost =
  (promptTokens / 1_000_000) * PROMPT_COST_PER_1M +
  (completionTokens / 1_000_000) * COMPLETION_COST_PER_1M;
```

- After each successful call we log:
  - `model`
  - `promptVersion`
  - `promptTokens`, `completionTokens`, `totalTokens`
  - `estimatedCost`
- The same values are written into `AIGeneration` for:
  - Cost analysis and budgeting.
  - Model and prompt comparison.
  - Post-hoc debugging.

### Prompt Versioning

- `PROMPT_VERSION` is hard-coded to `v1.1` in this iteration.
- Every `AIGeneration` row stores that version so you can:
  - Tie any sequence back to the prompt that created it.
  - Compare quality and cost across versions.
- Rolling out `v1.2`, `v1.3`, etc. is a constant bump, not a schema migration.

### Latency Characteristics

Current latency is dominated by the OpenAI API call (typically 2–5 seconds). This is acceptable for a prototype where synchronous responses are fine. In production, decouple generation from the request lifecycle by moving AI calls to a background queue (BullMQ, AWS SQS) and return immediately with a job ID. Clients can poll for completion or receive webhook notifications when the sequence is ready.

## Idempotency Strategy

**Implementation:**
Lightweight deterministic lookup based on the full semantic request:
- `prospect_url` (via `Prospect.linkedinUrl`)
- `company_context` (exact match)
- TOV values (`formality`, `warmth`, `directness` - exact match)
- `sequence_length` (exact match)

**Query Flow (before any AI calls):**
1. Find `Prospect` by `linkedinUrl`.
2. Find `TovConfig` matching the numeric TOV values.
3. Find `MessageSequence` with matching `prospectId`, `tovConfigId`, `companyContext`, and `sequenceLength`.
4. If a match exists:
   - Log an idempotent cache hit: `Idempotent sequence hit - returning cached result (no AI cost incurred)`.
   - Return the stored `analysis`, `messages`, and `confidence` without calling the AI.
5. If no match exists:
   - Proceed to LinkedIn parsing, TOV translation, AI generation, and transactionally insert a new `MessageSequence` + `AIGeneration`.

To keep lookups efficient, a composite index is defined on `MessageSequence`:
- `@@index([prospectId, tovConfigId, companyContext, sequenceLength])`

**Design Decision:**
- **Why deterministic lookup?** Simple, fast, no additional infrastructure
- **Tradeoff:** Exact match required (no fuzzy matching on company_context)
- **Future Improvement:** Add hash-based idempotency key for more flexible matching

**Benefits:**
- Prevents duplicate AI calls for identical requests
- Reduces costs
- Faster response times for repeated requests
- Consistent results for same inputs

## Tone-of-Voice Translation

The model doesn’t think in sliders, so we translate the sliders into English before they hit the prompt.

- `0.8` formality → “formal but not stiff”.
- `0.6` warmth → “moderately warm and approachable”.
- `0.7` directness → “direct but not abrupt”.

We store that combined description in `TovConfig.description` so:
- Humans can see how the system interpreted the knobs.
- Prompts are easier for the model to follow.
- Identical TOV presets can be reused across many sequences.

## Mock LinkedIn Profile Parser

We want a realistic data shape without shipping a LinkedIn scraper.

**Implementation:**
- Take the LinkedIn URL, pull out a handle, and return deterministic mock data:
  - `fullName`
  - `headline`
  - `company`
  - `profileData` with experience, education, skills, summary.

**Tradeoffs:**
- **Current:** Purely local, no network hops, no TOS worries.
- **Production:** Swap in LinkedIn Sales Navigator or a third-party enrichment API.

**Why mock at all?**
- Keeps the focus on the pipeline, not scraping.
- Still tests URL → profile → sequence flow.
- Makes behavior easy to reason about under operational pressure.

**Production considerations:**
- Use official APIs or compliant providers.
- Add rate limiting, retries, and caching layers.
- Handle profile privacy and visibility rules.
- Decide how fresh profile data needs to be and design your expiry strategy around that.

## Error Handling

**Validation Errors (400):**
- Zod schema validation at controller layer (early rejection) and service layer (defensive check)
- Validates: `prospect_url` (must be valid URL), `tov_config` values (0-1 range), `company_context` (non-empty), `sequence_length` (1-10)
- Returns structured error with field-level details

**AI Failures:**
- All AI calls are wrapped in `try/catch` and never crash the server.
- OpenAI and parsing/validation issues are normalized into a single `AppError` code (`AI_GENERATION_FAILED`).
- The global error handler maps this to a standardized 500 response:

  ```json
  {
    "error": "AI generation failed",
    "message": "Please retry later"
  }
  ```

- Detailed error information (message, stack in development, response snippets) is logged server-side for debugging and observability.

**Defensive Checks:**
- `OPENAI_API_KEY` is checked at startup; if missing, the server logs a clear error and AI calls fail with the standardized 500 response above rather than crashing

**Error Response Format:**
```json
{
  "error": "Error message",
  "details": [...] // For validation errors
}
```

## Scaling Considerations

At ~1,000+ generations/day, synchronous AI calls become a bottleneck. Here's what changes:

**Background workers:**
- Move AI generation off the request path using BullMQ or AWS SQS.
- API returns immediately with a job ID; clients poll or receive webhooks.
- Workers pull jobs, call OpenAI, persist results, notify completion.

**Concurrency limiting:**
- Cap concurrent outbound AI calls (e.g., 10–20 workers) to avoid OpenAI rate limits.
- Queue jobs when at capacity; retry with exponential backoff on transient failures.

**Redis for hot paths:**
- Cache idempotent lookups in Redis with TTL (e.g., 1 hour).
- Reduces database load for repeated requests with identical parameters.

**Read replicas:**
- Route read queries (idempotency checks, sequence retrieval) to Postgres replicas.
- Keep writes on primary; scale reads horizontally.

**Request-level timeouts:**
- Set 30s timeout on AI calls; fail fast if OpenAI is slow or unresponsive.
- Return 504 Gateway Timeout with retry guidance.

**Cost guardrails:**
- Track daily token spend; alert at thresholds (e.g., 80% of budget).
- Auto-pause generation if cost exceeds limit.
- Per-customer rate limits to prevent abuse.

## Production Improvements

### 1. Async Queue for Generation

**Current:** Synchronous API call blocks request
**Improvement:** Move AI generation to background queue (BullMQ, AWS SQS)

**Benefits:**
- Non-blocking API responses
- Better handling of long-running generations
- Retry logic for transient failures
- Rate limiting at queue level

### 2. Rate Limiting

**Implementation:** Express rate limiter middleware
- Per-IP limits
- Per-API-key limits (when auth added)
- Sliding window or token bucket

### 3. Prompt Version Experimentation

**Current:** Hardcoded version string
**Improvement:** 
- Version management system
- A/B testing framework
- Metrics tracking per version
- Gradual rollout capabilities

### 4. Model Fallback Strategy

**Current:** Single model (`gpt-4o-mini`)
**Improvement:**
- Fallback to cheaper model on failure
- Model selection based on request characteristics
- Cost/quality optimization

### 5. Idempotency Improvements

**Current:** Deterministic lookup
**Improvements:**
- Hash-based idempotency keys
- Fuzzy matching on company_context
- TTL on cached sequences
- Cache invalidation strategies

### 6. Cost Optimization

**Strategies:**
- Response caching (Redis)
- Prompt template optimization
- Token usage monitoring and alerts
- Model selection based on complexity
- Batch processing for similar requests

### 7. Observability

**Logging:**
- Structured logging (Winston, Pino)
- Request IDs for tracing
- AI call logging with metadata

**Metrics:**
- Generation latency
- Token usage trends
- Cost per sequence
- Error rates
- Cache hit rates

**Monitoring:**
- Health checks
- Alerting on high error rates
- Cost threshold alerts

### 8. Caching Strategies

**Redis Cache:**
- Cache sequences by idempotency key
- TTL based on data freshness requirements
- Invalidate on prospect profile updates

**Benefits:**
- Reduced database load
- Faster response times
- Lower AI API costs

## Tradeoffs Due to 4-5 Hour Constraint

**What Was Prioritized:**
- Clean architecture and separation of concerns
- Robust error handling
- Idempotency implementation
- Comprehensive database design
- Production-aware documentation

**What Was Deferred:**
- Authentication/authorization (documented as future)
- Background job queue (documented as future)
- Comprehensive test suite (would add in production)
- Rate limiting implementation (documented)
- Advanced caching (documented)
- Real LinkedIn integration (mock with clear documentation)

**Rationale:**
Focus on demonstrating systems thinking, AI maturity, and production awareness rather than implementing every feature. The architecture supports all documented improvements without major refactoring.

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 14+ (Railway PostgreSQL recommended for deployment)
- OpenAI API key

### Installation

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run prisma:generate

# Set up environment variables
cp env.example .env
# Edit .env with your DATABASE_URL and OPENAI_API_KEY

# Run database migrations
npm run prisma:migrate
```

### Running Locally

```bash
# Development mode (with hot reload)
npm run dev

# Production build
npm run build
npm start
```

### Environment Variables

Required in `.env`:

- `DATABASE_URL`: PostgreSQL connection string
  - **Local**: `postgresql://user:password@localhost:5432/sequence_generator?schema=public`
  - **Railway**: Automatically provided when you add a PostgreSQL service in Railway. Copy the `DATABASE_URL` from your Railway project's PostgreSQL service variables.
- `OPENAI_API_KEY`: Your OpenAI API key
- `PORT`: Server port (default: 3000)

#### Railway PostgreSQL Setup

1. Create a new Railway project
2. Add a PostgreSQL service to your project
3. Railway automatically provides the `DATABASE_URL` environment variable
4. Copy the `DATABASE_URL` value from Railway's PostgreSQL service variables
5. Add it to your `.env` file or Railway's environment variables

**Note:** Railway's PostgreSQL automatically handles connection pooling and provides a production-ready database instance with JSONB support.

### API Usage

**Endpoints:**
- `GET /` — Returns a simple text message indicating the API is running
- `GET /health` — Returns `{ "status": "ok" }` for health checks
- `POST /api/generate-sequence` — Main endpoint for sequence generation

**Request:**
```json
{
  "prospect_url": "https://linkedin.com/in/john-doe",
  "tov_config": {
    "formality": 0.8,
    "warmth": 0.6,
    "directness": 0.7
  },
  "company_context": "We help SaaS companies automate sales",
  "sequence_length": 3  // Must be between 1 and 10
}
```

**Response:**
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

### Database Management

```bash
# Open Prisma Studio (GUI)
npm run prisma:studio

# Create new migration
npm run prisma:migrate
```

## Technology Stack

- **Runtime:** Node.js with TypeScript
- **Framework:** Express.js
- **ORM:** Prisma
- **Database:** PostgreSQL (with JSONB) - Railway PostgreSQL for deployment
- **AI:** OpenAI Node SDK (official)
- **Validation:** Zod
- **Config:** dotenv

## License

ISC
