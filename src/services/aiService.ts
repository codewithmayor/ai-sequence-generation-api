import OpenAI from 'openai';
import { AppError } from '../utils/errorHandler';
import type { ProspectProfile } from '../utils/linkedinParser';
import { strategyToPromptBlock } from '../utils/roleContextStrategy';
import type { MessageStrategy } from '../utils/roleContextStrategy';

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error(
    'OPENAI_API_KEY environment variable is missing. AI generation requests will fail until it is set.'
  );
}

const openai = apiKey ? new OpenAI({ apiKey }) : null;

const PROMPT_VERSION = 'v5.2';
const MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.5;

// Cost per 1M tokens (gpt-4o-mini pricing)
const PROMPT_COST_PER_1M = 0.15;
const COMPLETION_COST_PER_1M = 0.6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AIGenerationResult {
  analysis: Record<string, any>;
  messages: Array<{ step: number; message: string; reasoning: string }>;
  confidence: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  rawResponse: any;
}

type ProspectData = ProspectProfile;

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

// ---------------------------------------------------------------------------
// Post-generation validation constants (light guardrails in code)
// ---------------------------------------------------------------------------

// Only flag the truly egregious claims — outbound cannot touch these systems.
const HARD_DOMAIN_CLAIMS = [
  'improve ci/cd', 'improve deployment', 'improve backend performance',
  'improve threat modeling', 'improve security controls',
  'enhance infrastructure', 'boost reliability',
];

// Discourage generic marketing-speak — logged, not blocked.
const GENERIC_FILLER_PHRASES = [
  'would you be open to a brief chat', 'would love to connect',
  'let me know if you\'d be interested', 'can we schedule a call',
  'happy to chat', 'i\'ve been following', 'i came across your profile',
  'innovative approach', 'i imagine', 'i can see how',
  'cross-team collaboration', 'this could help',
];

const ANALYSIS_GENERIC_PHRASES = [
  'industry-leading', 'unlock new opportunities', 'drive growth',
  'transform your business',
];

const CROSS_FUNCTIONAL_WORKFLOW_HINTS = [
  'sales-engineering handoff', 'technical validation loop',
  'prospect qualification feedback cycle', 'founder interrupt-driven engineering',
  'inbound triage burden', 'pre-sales technical review',
  'outbound personalization research load', 'qualification loop',
  'inbound triage', 'technical validation step', 'cross-functional escalation loop',
];

const STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'that', 'this', 'from', 'into', 'your',
  'their', 'about', 'over', 'under', 'build', 'building', 'senior',
  'lead', 'manager', 'engineer', 'team', 'role',
]);

// ---------------------------------------------------------------------------
// Main entry point — ONE model call
// ---------------------------------------------------------------------------

export async function generateSequenceWithAI(
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number,
  strategy: MessageStrategy
): Promise<AIGenerationResult> {
  if (!openai) {
    console.error('AI generation attempted without a configured OpenAI client (missing OPENAI_API_KEY).');
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  try {
  const systemPrompt = buildSystemPrompt(sequenceLength);
  const userPrompt = buildUserPrompt(prospectData, companyContext, tovDescription, sequenceLength, strategy);

    // Token observability — pre-call
    console.log('Prompt lengths (chars)', {
      systemPrompt: systemPrompt.length,
      userPrompt: userPrompt.length,
    });

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: TEMPERATURE,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('Empty response from OpenAI API', { responseId: response.id });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }

    const tokenUsage = extractTokenUsage(response);

    // Token observability — post-call
    console.log('AI generation token usage', {
      model: MODEL,
      promptVersion: PROMPT_VERSION,
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      totalTokens: tokenUsage.totalTokens,
      estimatedCost: tokenUsage.estimatedCost,
    });

    const parsed = parseAIJsonContent(content);

    // Structural validation (throws on failure)
    validateOutputStructure(parsed, sequenceLength);

    // Content validation — log issues but accept output (no repair pass).
    // A senior engineer optimizes cost and complexity, not perfection.
    const issues = validateContentQuality(parsed, prospectData, companyContext);
    if (issues.length > 0) {
      console.warn('Quality issues detected (accepted, no repair)', { issues });
    }

    // In-code sanitization for persistent banned phrases
    sanitizeOutput(parsed);

    const calcConf = calculateConfidence(parsed, prospectData);
    const aiConf = parsed.confidence || 0.5;
    const confidence = Math.abs(aiConf - calcConf) > 0.3 ? calcConf : (aiConf + calcConf) / 2;

    return {
      analysis: parsed.analysis || {},
      messages: parsed.messages,
      confidence,
      tokenUsage,
      rawResponse: response,
    };
  } catch (error: any) {
    console.error('AI generation error', {
      error: error instanceof Error ? error.message : String(error),
      stack: process.env.NODE_ENV === 'development' && error instanceof Error ? error.stack : undefined,
    });

    if (error instanceof AppError) throw error;

    if (error instanceof OpenAI.APIError) {
      console.error('OpenAI API error details', {
        status: error.status,
        code: error.code,
        type: error.type,
      });
    }

    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }
}

// ---------------------------------------------------------------------------
// Adaptive step progression — narrative layers scale with sequence length
// ---------------------------------------------------------------------------

const LAYER_OBSERVATION = `OBSERVATION. "Hi [Name]," + a grounded hypothesis about their role and the chosen friction (<60 words). Reference a skill or headline detail. Statement, not a question. Example: "Hi Neo, most DevOps leads I talk to end up fielding late-stage security review requests for prospects that were never qualified — especially painful when the team's deep in Kubernetes work."`;

const LAYER_SPOTLIGHT = `WORKFLOW SPOTLIGHT. No greeting. Name a specific capability or workflow FROM THE COMPANY CONTEXT and connect it to the friction. You MUST reference what the company sells (from company_context), not just restate the friction from Step 1. Be concrete about what happens and who triggers it. Can end with one question. Example: "The pattern I keep hearing is that security reviews get triggered before anyone confirms the prospect has real budget or timeline — so your team does the work, and the deal stalls anyway."`;

const LAYER_CAUSE = `CAUSAL LINK. No greeting. Explain HOW the upstream problem (poor qualification, noisy pipeline) creates the friction for their team. Connect company_context to their pain. Example: "It usually starts upstream — qualification isn't precise enough, so technical validation gets triggered for prospects that should have been filtered two steps earlier."`;

const LAYER_IMPROVEMENT = `IMPROVEMENT + CTA. No greeting. Name the concrete operational change and what's different after. End with a specific, low-friction ask. Example: "We help sales teams tighten that qualification layer so security reviews only happen when deal intent is confirmed. Happy to show what that filter looks like if the pattern sounds familiar."`;

const LAYER_SOCIAL_PROOF = `SOCIAL PROOF. No greeting. Reference how similar teams solved this + reinforce the improvement. Example: "One platform team we work with cut their ad-hoc prospect-driven review load by routing all technical asks through a qualification gate first — only confirmed-intent prospects reach their queue now."`;

const LAYER_EXPANSION = `EXPANSION. No greeting. Broaden the impact — name a second workflow or team that benefits from the same upstream fix. End with a specific ask. Example: "The same qualification filter also means your security team stops fielding questionnaires for deals that were never going to close — so the fix compounds across teams."`;

function buildStepProgression(sequenceLength: number): string {
  const steps: string[] = [];

  if (sequenceLength === 1) {
    steps.push(`1: OBSERVATION + CTA. "Hi [Name]," + grounded hypothesis about the friction + how we help + low-friction ask. All in one concise message (<80 words).`);
  } else if (sequenceLength === 2) {
    steps.push(`1: ${LAYER_OBSERVATION}`);
    steps.push(`2: ${LAYER_IMPROVEMENT}`);
  } else if (sequenceLength === 3) {
    steps.push(`1: ${LAYER_OBSERVATION}`);
    steps.push(`2: ${LAYER_SPOTLIGHT}`);
    steps.push(`3: ${LAYER_IMPROVEMENT}`);
  } else if (sequenceLength === 4) {
    steps.push(`1: ${LAYER_OBSERVATION}`);
    steps.push(`2: ${LAYER_SPOTLIGHT}`);
    steps.push(`3: ${LAYER_CAUSE}`);
    steps.push(`4: ${LAYER_IMPROVEMENT}`);
  } else {
    // 5+
    steps.push(`1: ${LAYER_OBSERVATION}`);
    steps.push(`2: ${LAYER_SPOTLIGHT}`);
    steps.push(`3: ${LAYER_CAUSE}`);
    steps.push(`4: ${LAYER_IMPROVEMENT}`);
    steps.push(`5: ${LAYER_SOCIAL_PROOF}`);
    if (sequenceLength >= 6) {
      steps.push(`6: ${LAYER_EXPANSION}`);
    }
    for (let i = 7; i <= sequenceLength; i++) {
      steps.push(`${i}: Follow-up. No greeting. Add a new angle or reinforce the improvement with a specific ask.`);
    }
  }

  return `STEP PROGRESSION (each step is a DIFFERENT LAYER — not a different friction):\n${steps.join('\n')}`;
}

// ---------------------------------------------------------------------------
// ONE system prompt (~400-500 tokens)
// ---------------------------------------------------------------------------

function buildSystemPrompt(sequenceLength: number): string {
  return `You write LinkedIn DMs for B2B outbound automation. Output ONLY valid JSON.

{
  "analysis": {
    "prospect_insights": "Max 3 sentences. Reference one skill + one inferred responsibility.",
    "personalization_hooks": ["hook referencing actual data", "hook referencing actual data"],
    "value_proposition": "How our product reduces cross-functional friction for the prospect's team."
  },
  "messages": [{ "step": 1, "message": "DM text", "reasoning": "Angle: <layer> | Workflow: <named> | Signal: <data point>" }],
  "confidence": 0.85
}

Generate exactly ${sequenceLength} messages. Pick ONE friction from the user prompt. Build ALL messages as a progressive ${sequenceLength}-layer narrative — not ${sequenceLength} restatements.

SCOPE:
- Sales roles: frame as direct workflow improvement (targeting, enrichment, personalization, pipeline velocity).
- Non-sales roles: frame as UPSTREAM FRICTION REDUCTION from their perspective. Not "we help sales qualify" — instead describe what changes FOR THEM: fewer interruptions, less validation noise, better filtering before escalation, reduced internal back-and-forth. Example: instead of "We help sales qualify prospects earlier" → "We reduce how often security gets pulled into late-stage reviews for deals that were never a fit."

RULES:
- LinkedIn DMs only. No subject lines, signatures, placeholders.
- Step 1: "Hi [Name]," + observation (<60 words). Steps 2+: no re-greeting.
- Each step = new narrative layer. Spotlight step must reference company_context.
- No invented stats. No numeric claims. Hooks must reference real prospect data.
- BANNED: "Would you be open to a brief chat", "Would love to connect", "I imagine", "I came across your profile", "I've been following", "operational workflows", "save your team time", "innovative approach".
- Reasoning: max 25 words. Angle = layer name, not friction name.

${buildStepProgression(sequenceLength)}

Confidence: 0.8-0.95 (clear signals), 0.6-0.79 (ambiguous), 0.4-0.59 (weak).`;
}

// ---------------------------------------------------------------------------
// Role-specific impact framing (eliminates generic "reduce sales interruptions")
// ---------------------------------------------------------------------------

// ROLE_IMPACT_MAP has been replaced by the strategy engine (roleContextStrategy.ts).
// Role → friction mapping is now computed via:
//   company_context → capability tags → role allowed workflows → intersection.
// This eliminates static role framing and ensures causal validity per request.

// ---------------------------------------------------------------------------
// ONE user prompt
// ---------------------------------------------------------------------------

function buildUserPrompt(
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number,
  strategy: MessageStrategy
): string {
  const skills = prospectData.skills.length > 0 ? prospectData.skills.join(', ') : 'n/a';
  const responsibilities = prospectData.inferredResponsibilities.length > 0
    ? prospectData.inferredResponsibilities.join(', ')
    : 'n/a';

  const experience = Array.isArray(prospectData.profileData?.experience)
    ? prospectData.profileData.experience
        .map((e) => `${e.title} at ${e.company} (${e.duration})`)
        .join(' | ')
    : 'n/a';

  // Strategy-driven friction block replaces static ROLE_IMPACT_MAP
  const frictionBlock = strategyToPromptBlock(strategy);

  // If strategy targets a different persona than the enriched profile, add persona signal.
  // The profile stays authentic — we don't fake their identity. The strategy tells
  // the model which frictions to surface and how to frame the value.
  const personaSignal = strategy.targetPersona !== prospectData.roleCategory
    ? `\nTARGET PERSONA: ${strategy.targetPersona}. The prospect's profile is ${prospectData.roleCategory}, but the company_context is most relevant to ${strategy.targetPersona} frictions. Frame the outreach through ${strategy.targetPersona}-relevant pain points while personalizing with the prospect's actual skills and experience.`
    : '';

  return `Generate ${sequenceLength} LinkedIn DMs for this prospect.

PROSPECT:
- Name: ${prospectData.fullName}
- Headline: ${prospectData.headline}
- Company: ${prospectData.company}
- Role: ${prospectData.roleCategory} (${prospectData.seniority})
- Skills: ${skills}
- Responsibilities: ${responsibilities}
- Experience: ${experience}${personaSignal}

COMPANY CONTEXT (what we sell): ${companyContext}

TONE: ${tovDescription}

${frictionBlock}

GROUNDING:
- prospect_insights: reference one skill + one headline responsibility. Max 3 sentences.
- personalization_hooks: exactly 2. Must reference actual data (skill name, company, headline keyword).
- value_proposition: how our product reduces the chosen friction. Reference company capability + prospect role.
- Pick ONE friction. Build ${sequenceLength} progressive layers. Last message = company_context + CTA.

Return ONLY JSON.`;
}

// ---------------------------------------------------------------------------
// Structural validation (throws on failure)
// ---------------------------------------------------------------------------

function validateOutputStructure(parsed: any, sequenceLength: number): void {
  if (!parsed || typeof parsed !== 'object') {
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  if (!parsed.analysis || typeof parsed.analysis !== 'object') {
    throw new AppError('AI generation failed: missing analysis', 500, 'AI_GENERATION_FAILED');
  }

  if (!Array.isArray(parsed.messages)) {
    throw new AppError('AI generation failed: missing messages', 500, 'AI_GENERATION_FAILED');
  }

  if (typeof parsed.confidence !== 'number') {
    throw new AppError('AI generation failed: missing confidence', 500, 'AI_GENERATION_FAILED');
  }

  if (parsed.messages.length !== sequenceLength) {
    throw new AppError('AI generation failed: message count mismatch', 500, 'AI_GENERATION_FAILED');
  }

  for (const [index, msg] of parsed.messages.entries()) {
    if (!msg || typeof msg !== 'object') {
      throw new AppError(`AI generation failed: message ${index + 1} invalid`, 500, 'AI_GENERATION_FAILED');
    }
    // Normalize step to expected sequential value (models sometimes misnumber)
    msg.step = index + 1;
    if (typeof msg.message !== 'string' || !msg.message.trim()) {
      throw new AppError(`AI generation failed: message ${index + 1} empty`, 500, 'AI_GENERATION_FAILED');
    }
    if (typeof msg.reasoning !== 'string' || !msg.reasoning.trim()) {
      throw new AppError(`AI generation failed: reasoning ${index + 1} empty`, 500, 'AI_GENERATION_FAILED');
    }
  }
}

// ---------------------------------------------------------------------------
// Content quality validation (code-level guardrails)
// ---------------------------------------------------------------------------

function validateContentQuality(
  parsed: Record<string, any>,
  prospectData: ProspectData,
  _companyContext: string
): string[] {
  const issues: string[] = [];
  const analysis = (parsed.analysis || {}) as Record<string, any>;
  const insights = str(analysis.prospect_insights);
  const valueProp = str(analysis.value_proposition);
  const skills = prospectData.skills.map((s) => s.toLowerCase());
  const headlineKw = extractSignalKeywords(prospectData.headline);

  // --- No invented statistics ---
  if (/\d+%/.test(insights) || /\d+%/.test(valueProp)) {
    issues.push('analysis contains numeric percentage claims');
  }

  // --- prospect_insights grounding ---
  if (skills.length > 0 && !hits(insights, skills)) {
    issues.push('prospect_insights should reference at least one skill');
  }
  if (hits(insights, ANALYSIS_GENERIC_PHRASES)) {
    issues.push('prospect_insights contains generic phrasing');
  }

  // --- personalization_hooks: must be exactly 2 ---
  const hooks = Array.isArray(analysis.personalization_hooks) ? analysis.personalization_hooks : [];
  if (hooks.length !== 2) {
    issues.push(`personalization_hooks must be exactly 2 (found ${hooks.length})`);
  }

  // --- Hard domain claims only (not micro-policing) ---
  if (!isSales(prospectData.roleCategory) && hits(valueProp, HARD_DOMAIN_CLAIMS)) {
    issues.push('value_proposition claims improvement to core technical system');
  }

  // --- messages ---
  for (const [i, msg] of parsed.messages.entries()) {
    const text = str(msg.message);
    const reasoning = String(msg.reasoning || '');
    const reasoningLower = reasoning.toLowerCase();
    const idx = i + 1;

    // Step 1 length
    if (i === 0) {
      const wordCount = String(msg.message || '').trim().split(/\s+/).length;
      if (wordCount > 60) {
        issues.push(`message 1 exceeds 60 words (${wordCount})`);
      }
    }

    // No invented stats
    if (/\d+%/.test(text)) {
      issues.push(`message ${idx} contains numeric percentage claim`);
    }

    // Generic filler
    if (hits(text, GENERIC_FILLER_PHRASES)) {
      issues.push(`message ${idx} contains generic filler`);
    }

    // Hard domain claims (non-sales only)
    if (!isSales(prospectData.roleCategory) && hits(text, HARD_DOMAIN_CLAIMS)) {
      issues.push(`message ${idx} claims improvement to core technical system`);
    }

    // Reasoning: check labels exist (lightly)
    const angle = extractLabel(reasoningLower, 'angle');
    const workflow = extractLabel(reasoningLower, 'workflow');
    const signal = extractLabel(reasoningLower, 'signal');

    if (!angle) issues.push(`message ${idx} reasoning missing Angle label`);
    if (!workflow) issues.push(`message ${idx} reasoning missing Workflow label`);
    // Signal: just check it mentions something concrete — no taxonomy enforcement
    if (!signal || signal.length < 3) {
      issues.push(`message ${idx} reasoning missing Signal (should mention a concrete profile element)`);
    }
  }

  // --- narrative: all-question detection ---
  if (parsed.messages.length >= 2) {
    const questionCount = parsed.messages.filter(
      (m: any) => String(m.message || '').trim().endsWith('?')
    ).length;
    if (questionCount === parsed.messages.length) {
      issues.push('all messages end with questions — need progressive narrative layers');
    }
  }

  // --- restatement detection ---
  for (let i = 1; i < parsed.messages.length; i++) {
    const prevWords = extractContentWords(str(parsed.messages[i - 1].message));
    const currWords = extractContentWords(str(parsed.messages[i].message));
    if (prevWords.size > 0 && currWords.size > 0) {
      let overlap = 0;
      for (const w of currWords) {
        if (prevWords.has(w)) overlap++;
      }
      const ratio = overlap / Math.min(prevWords.size, currWords.size);
      if (ratio > 0.5) {
        issues.push(`messages ${i} and ${i + 1} are too similar (${Math.round(ratio * 100)}% overlap)`);
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// In-code text sanitization (catches phrases that survive model passes)
// ---------------------------------------------------------------------------

const TEXT_REPLACEMENTS: [RegExp, string][] = [
  [/\bstreamlining\s+/gi, 'reducing '],
  [/\bstreamlines?\s+the\b/gi, 'reduces friction in'],
  [/\bstreamlines?\s/gi, 'reduces '],
  [/\bsmoother\s+operational\b/gi, 'fewer disruptive'],
  [/\boperational\s+workflows?\b/gi, 'cross-functional processes'],
  [/\boperational\s+readiness\b/gi, 'team focus'],
  [/\boperational\s+efficiency\b/gi, 'qualification clarity'],
  [/\bcan disrupt workflow significantly\b/gi, 'pulls your team off planned work'],
  [/\bsave your team time\b/gi, 'free your team from unqualified noise'],
  [/\bwaste valuable time\b/gi, 'cost your team cycles on deals that never close'],
];

function sanitizeText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function sanitizeOutput(parsed: Record<string, any>): void {
  if (parsed.analysis) {
    if (typeof parsed.analysis.value_proposition === 'string') {
      parsed.analysis.value_proposition = sanitizeText(parsed.analysis.value_proposition);
    }
    if (typeof parsed.analysis.prospect_insights === 'string') {
      parsed.analysis.prospect_insights = sanitizeText(parsed.analysis.prospect_insights);
    }
  }
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (typeof msg.message === 'string') {
        msg.message = sanitizeText(msg.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Confidence calculation (grounding-based, not random)
// ---------------------------------------------------------------------------

function calculateConfidence(parsed: Record<string, any>, prospectData: ProspectData): number {
  const analysis = (parsed.analysis || {}) as Record<string, any>;
  const insights = str(analysis.prospect_insights);
  const valueProp = str(analysis.value_proposition);
  const skills = prospectData.skills.map((s) => s.toLowerCase());
  const headlineKw = extractSignalKeywords(prospectData.headline);

  let score = 0.5;

  // Skills available and referenced
  if (skills.length > 0) {
    score += hits(insights, skills) ? 0.2 : -0.1;
  } else {
    score -= 0.1;
  }

  // Role inference
  if (headlineKw.length > 0 && hits(insights, headlineKw)) {
    score += 0.15;
  } else {
    score -= 0.1;
  }

  // Causal mapping
  if (hasNamedWorkflow(valueProp) && headlineKw.length > 0 && hits(valueProp, headlineKw)) {
    score += 0.15;
  } else {
    score -= 0.1;
  }

  // Generic penalty
  if (hits(insights, ANALYSIS_GENERIC_PHRASES)) {
    score -= 0.2;
  }

  return Math.max(0.4, Math.min(0.95, score));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAIJsonContent(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch =
      content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) {
      console.error('Failed to parse AI response as JSON.', { snippet: content.slice(0, 300) });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e) {
      console.error('Failed to parse extracted JSON block.', { snippet: content.slice(0, 300) });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }
  }
}

function extractTokenUsage(response: OpenAI.Chat.Completions.ChatCompletion): TokenUsage {
  const promptTokens = response.usage?.prompt_tokens || 0;
  const completionTokens = response.usage?.completion_tokens || 0;
  const totalTokens = response.usage?.total_tokens || 0;
  const estimatedCost =
    (promptTokens / 1_000_000) * PROMPT_COST_PER_1M +
    (completionTokens / 1_000_000) * COMPLETION_COST_PER_1M;
  return { promptTokens, completionTokens, totalTokens, estimatedCost };
}


/** Lowercase string helper */
function str(val: unknown, lower = true): string {
  const s = String(val || '');
  return lower ? s.toLowerCase() : s;
}

/** Check if text contains any of the given tokens (case-insensitive) */
function hits(text: string, tokens: string[]): boolean {
  return tokens.some((t) => t && text.includes(t.toLowerCase()));
}

/** Extract a label value from reasoning (e.g. "Angle: ..." ) */
function extractLabel(reasoning: string, label: string): string {
  const match = reasoning.match(new RegExp(`${label}\\s*:\\s*([^|.;\\n]+)`, 'i'));
  return match ? match[1].trim().toLowerCase() : '';
}

/** Check if text references a named outbound workflow */
function hasNamedWorkflow(text: string): boolean {
  const n = text.toLowerCase();
  if (hits(n, CROSS_FUNCTIONAL_WORKFLOW_HINTS)) return true;
  return /\b(handoff|triage|qualification|validation|pre-sales|interrupt|research load|review cycle)\b/.test(n);
}

/** Check if role is sales/revenue/BD — outbound automation IS their core workflow */
function isSales(roleCategory: string): boolean {
  const r = roleCategory.toLowerCase();
  return r.includes('sales') || r.includes('revenue') || r.includes('business development');
}

function extractSignalKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens)).slice(0, 12);
}

/** Extract meaningful content words from text (for restatement detection) */
function extractContentWords(text: string): Set<string> {
  const filler = new Set([
    ...STOPWORDS, 'your', 'team', 'often', 'these', 'that', 'they', 'them',
    'which', 'when', 'what', 'where', 'many', 'most', 'some', 'more',
    'also', 'just', 'like', 'have', 'been', 'will', 'would', 'could',
    'should', 'does', 'didn', 'aren', 'isn', 'wasn', 'hasn', 'don',
    'can', 'not', 'very', 'much', 'well', 'even', 'still', 'come',
    'before', 'after', 'without', 'leading',
  ]);
  return new Set(
    text.toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4 && !filler.has(w))
  );
}

export { PROMPT_VERSION, MODEL };
