import OpenAI from 'openai';
import { AppError } from '../utils/errorHandler';

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  // Defensive check: do not crash the server, but log loudly.
  console.error(
    'OPENAI_API_KEY environment variable is missing. AI generation requests will fail until it is set.'
  );
}

const openai = apiKey
  ? new OpenAI({
      apiKey,
    })
  : null;

const PROMPT_VERSION = 'v1.2';

// Model selection: Using gpt-4o-mini for cost-effective prototyping
// In production, this could be configurable or A/B tested
const MODEL = 'gpt-4o-mini';
const ANALYSIS_MODEL = MODEL;
const REPAIR_MODEL = MODEL;
const MAIN_TEMPERATURE = 0.5;
const ANALYSIS_TEMPERATURE = 0.4;
const REPAIR_TEMPERATURE = 0.2;

// Cost per 1M tokens (as of 2024)
const PROMPT_COST_PER_1M = 0.15; // $0.15 per 1M input tokens
const COMPLETION_COST_PER_1M = 0.6; // $0.60 per 1M output tokens

export interface AIGenerationResult {
  analysis: Record<string, any>;
  messages: Array<{
    step: number;
    message: string;
    reasoning: string;
  }>;
  confidence: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  rawResponse: any;
}

interface ProspectData {
  fullName: string;
  headline: string;
  company: string;
  profileData: any;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

interface AIJsonCallResult {
  parsed: any;
  rawResponse: any;
  tokenUsage: TokenUsage;
}

interface AnalysisPlan {
  analysis: Record<string, any>;
  angles: string[];
  stepObjectives: string[];
}

interface GenerationPassResult {
  parsedResponse: any;
  rawResponses: any[];
  tokenUsages: TokenUsage[];
  analysisPlan?: AnalysisPlan;
}

const STOPWORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'their',
  'about',
  'over',
  'under',
  'build',
  'building',
  'senior',
  'lead',
  'manager',
  'engineer',
  'team',
  'role',
]);

const ANALYSIS_GENERIC_PHRASES = [
  'industry-leading',
  'unlock new opportunities',
  'drive growth',
  'transform your business',
];

const OPERATIONAL_IMPROVEMENT_KEYWORDS = [
  'cycle time',
  'lead time',
  'conversion',
  'response time',
  'forecast',
  'handoff',
  'pipeline',
  'incident',
  'throughput',
  'uptime',
  'onboarding',
  'latency',
  'backlog',
  'error rate',
  'deployment',
];

const SPECIFICITY_HINT_KEYWORDS = [
  'pipeline',
  'handoff',
  'onboarding',
  'incident',
  'deployment',
  'forecast',
  'conversion',
  'response',
  'latency',
  'backlog',
];

const MAX_QUALITY_REPAIR_ATTEMPTS = 1;

export async function generateSequenceWithAI(
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number
): Promise<AIGenerationResult> {
  if (!openai) {
    console.error('AI generation attempted without a configured OpenAI client (missing OPENAI_API_KEY).');
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  try {
    const factsBlock = buildFactsBlock(prospectData);
    let generationResult: GenerationPassResult;

    try {
      generationResult = await generateWithMultiPass(
        prospectData,
        companyContext,
        tovDescription,
        sequenceLength,
        factsBlock
      );
    } catch (multiPassError) {
      console.warn('Multi-pass generation failed; falling back to single-pass generation.', {
        error: multiPassError instanceof Error ? multiPassError.message : multiPassError,
      });
      generationResult = await generateWithSinglePass(
        prospectData,
        companyContext,
        tovDescription,
        sequenceLength,
        factsBlock
      );
    }

    let parsedResponse = generationResult.parsedResponse;
    validateGeneratedResponseStructure(parsedResponse, sequenceLength);

    let qualityIssues = getQualityIssues(
      parsedResponse,
      prospectData,
      companyContext
    );

    let repairAttempts = 0;
    while (qualityIssues.length > 0 && repairAttempts < MAX_QUALITY_REPAIR_ATTEMPTS) {
      repairAttempts += 1;
      console.warn('Generated output failed quality checks; attempting repair pass.', {
        qualityIssues,
        attempt: repairAttempts,
      });

      const repaired = await runRepairPass(
        parsedResponse,
        qualityIssues,
        prospectData,
        companyContext,
        tovDescription,
        sequenceLength,
        factsBlock,
        generationResult.analysisPlan
      );

      generationResult.rawResponses.push(repaired.rawResponse);
      generationResult.tokenUsages.push(repaired.tokenUsage);
      parsedResponse = repaired.parsed;
      validateGeneratedResponseStructure(parsedResponse, sequenceLength);
      qualityIssues = getQualityIssues(parsedResponse, prospectData, companyContext);
    }

    if (qualityIssues.length > 0) {
      console.warn('Proceeding with response despite unresolved quality warnings.', {
        qualityIssues,
      });
    }

    const totalUsage = mergeTokenUsages(generationResult.tokenUsages);

    // Log token usage for observability and cost tracking
    console.log('AI generation token usage', {
      model: MODEL,
      promptVersion: PROMPT_VERSION,
      promptTokens: totalUsage.promptTokens,
      completionTokens: totalUsage.completionTokens,
      totalTokens: totalUsage.totalTokens,
      estimatedCost: totalUsage.estimatedCost,
      stages: generationResult.rawResponses.length,
    });

    return {
      analysis: parsedResponse.analysis || {},
      messages: parsedResponse.messages,
      confidence: parsedResponse.confidence,
      tokenUsage: {
        promptTokens: totalUsage.promptTokens,
        completionTokens: totalUsage.completionTokens,
        totalTokens: totalUsage.totalTokens,
        estimatedCost: totalUsage.estimatedCost,
      },
      rawResponse:
        generationResult.rawResponses.length === 1
          ? generationResult.rawResponses[0]
          : { stages: generationResult.rawResponses },
    };
  } catch (error: any) {
    console.error('AI generation error', {
      error: error instanceof Error ? error.message : String(error),
      stack: process.env.NODE_ENV === 'development' && error instanceof Error ? error.stack : undefined,
    });

    if (error instanceof AppError) {
      throw error;
    }

    // Handle OpenAI API errors
    if (error instanceof OpenAI.APIError) {
      console.error('OpenAI API error details', {
        status: error.status,
        code: error.code,
        type: error.type,
      });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }

    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }
}

async function generateWithMultiPass(
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number,
  factsBlock: string
): Promise<GenerationPassResult> {
  const analysisCall = await requestJsonObjectFromAI({
    model: ANALYSIS_MODEL,
    systemPrompt: buildAnalysisSystemPrompt(),
    userPrompt: buildAnalysisUserPrompt(
      prospectData,
      companyContext,
      tovDescription,
      sequenceLength,
      factsBlock
    ),
    temperature: ANALYSIS_TEMPERATURE,
  });

  const analysisPlan = parseAnalysisPlan(analysisCall.parsed, sequenceLength);
  const finalCall = await requestJsonObjectFromAI({
    model: MODEL,
    systemPrompt: buildSystemPrompt(sequenceLength),
    userPrompt: buildUserPrompt(
      prospectData,
      companyContext,
      tovDescription,
      sequenceLength,
      factsBlock,
      analysisPlan
    ),
    temperature: MAIN_TEMPERATURE,
  });

  return {
    parsedResponse: finalCall.parsed,
    rawResponses: [analysisCall.rawResponse, finalCall.rawResponse],
    tokenUsages: [analysisCall.tokenUsage, finalCall.tokenUsage],
    analysisPlan,
  };
}

async function generateWithSinglePass(
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number,
  factsBlock: string
): Promise<GenerationPassResult> {
  const finalCall = await requestJsonObjectFromAI({
    model: MODEL,
    systemPrompt: buildSystemPrompt(sequenceLength),
    userPrompt: buildUserPrompt(
      prospectData,
      companyContext,
      tovDescription,
      sequenceLength,
      factsBlock
    ),
    temperature: MAIN_TEMPERATURE,
  });

  return {
    parsedResponse: finalCall.parsed,
    rawResponses: [finalCall.rawResponse],
    tokenUsages: [finalCall.tokenUsage],
  };
}

async function runRepairPass(
  currentResponse: Record<string, any>,
  qualityIssues: string[],
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number,
  factsBlock: string,
  analysisPlan?: AnalysisPlan
): Promise<AIJsonCallResult> {
  return requestJsonObjectFromAI({
    model: REPAIR_MODEL,
    systemPrompt: buildRepairSystemPrompt(sequenceLength),
    userPrompt: buildRepairUserPrompt(
      currentResponse,
      qualityIssues,
      prospectData,
      companyContext,
      tovDescription,
      sequenceLength,
      factsBlock,
      analysisPlan
    ),
    temperature: REPAIR_TEMPERATURE,
  });
}

function parseAnalysisPlan(parsed: any, sequenceLength: number): AnalysisPlan {
  if (!parsed || typeof parsed !== 'object' || !parsed.analysis || typeof parsed.analysis !== 'object') {
    console.error('Invalid analysis plan structure.', { parsedKeys: Object.keys(parsed || {}) });
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  const rawAngles: unknown[] = Array.isArray(parsed.angles) ? parsed.angles : [];
  const rawStepObjectives: unknown[] = Array.isArray(parsed.step_objectives)
    ? parsed.step_objectives
    : [];

  const angles = rawAngles
    .filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, Math.max(2, sequenceLength));

  const stepObjectives = rawStepObjectives
    .filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, sequenceLength);

  return {
    analysis: parsed.analysis as Record<string, any>,
    angles,
    stepObjectives,
  };
}

async function requestJsonObjectFromAI(options: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
}): Promise<AIJsonCallResult> {
  if (!openai) {
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  const response = await openai.chat.completions.create({
    model: options.model,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: options.temperature,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    console.error('Empty response from OpenAI API', { responseId: response.id });
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  return {
    parsed: parseAIJsonContent(content),
    rawResponse: response,
    tokenUsage: extractTokenUsage(response),
  };
}

function parseAIJsonContent(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch =
      content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);

    if (!jsonMatch) {
      console.error('Failed to parse AI response as JSON (no JSON block found).', {
        contentSnippet: content.slice(0, 300),
      });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }

    try {
      return JSON.parse(jsonMatch[1]);
    } catch (parseError) {
      console.error('Failed to parse extracted JSON block.', {
        contentSnippet: content.slice(0, 300),
        error: parseError instanceof Error ? parseError.message : parseError,
      });
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

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCost,
  };
}

function mergeTokenUsages(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, usage) => ({
      promptTokens: acc.promptTokens + usage.promptTokens,
      completionTokens: acc.completionTokens + usage.completionTokens,
      totalTokens: acc.totalTokens + usage.totalTokens,
      estimatedCost: acc.estimatedCost + usage.estimatedCost,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 }
  );
}

function validateGeneratedResponseStructure(parsedResponse: any, sequenceLength: number): void {
  if (!parsedResponse || typeof parsedResponse !== 'object') {
    console.error('Invalid AI response structure: root must be an object.');
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  if (!parsedResponse.messages || !Array.isArray(parsedResponse.messages)) {
    console.error('Invalid AI response structure: missing messages array.', {
      parsedKeys: Object.keys(parsedResponse || {}),
    });
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  if (!parsedResponse.analysis || typeof parsedResponse.analysis !== 'object') {
    console.error('Invalid AI response structure: missing analysis object.', {
      parsedKeys: Object.keys(parsedResponse || {}),
    });
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  if (typeof parsedResponse.confidence !== 'number') {
    console.error('Invalid AI response structure: missing confidence score.', {
      confidenceType: typeof parsedResponse.confidence,
    });
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  if (parsedResponse.messages.length !== sequenceLength) {
    console.error('Invalid AI response structure: message count mismatch.', {
      expected: sequenceLength,
      actual: parsedResponse.messages.length,
    });
    throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
  }

  for (const [index, messageItem] of parsedResponse.messages.entries()) {
    if (!messageItem || typeof messageItem !== 'object') {
      console.error('Invalid AI response structure: message is not an object.', { index });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }

    const expectedStep = index + 1;
    const step = (messageItem as { step?: unknown }).step;
    const messageText = (messageItem as { message?: unknown }).message;
    const reasoningText = (messageItem as { reasoning?: unknown }).reasoning;

    if (!Number.isInteger(step) || step !== expectedStep) {
      console.error('Invalid AI response structure: message.step must be sequential.', {
        index,
        expectedStep,
        step,
      });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }

    if (typeof messageText !== 'string' || messageText.trim().length === 0) {
      console.error('Invalid AI response structure: message.message must be a non-empty string.', {
        index,
        messageType: typeof messageText,
      });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }

    if (typeof reasoningText !== 'string' || reasoningText.trim().length === 0) {
      console.error('Invalid AI response structure: message.reasoning must be a non-empty string.', {
        index,
        reasoningType: typeof reasoningText,
      });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }
  }
}

function getQualityIssues(
  parsedResponse: Record<string, any>,
  prospectData: ProspectData,
  companyContext: string
): string[] {
  const issues: string[] = [];
  const analysis = (parsedResponse.analysis || {}) as Record<string, any>;
  const prospectInsights = String(analysis.prospect_insights || '').toLowerCase();
  const valueProposition = String(analysis.value_proposition || '').toLowerCase();
  const headlineKeywords = extractSignalKeywords(prospectData.headline);
  const companyContextKeywords = extractSignalKeywords(companyContext);
  const skills = Array.isArray(prospectData.profileData?.skills)
    ? (prospectData.profileData.skills as unknown[])
        .filter((item): item is string => typeof item === 'string')
        .map((skill) => skill.toLowerCase())
    : [];

  if (skills.length > 0 && !containsAnyToken(prospectInsights, skills)) {
    issues.push('analysis.prospect_insights should reference at least one explicit skill from profileData.skills');
  }

  if (headlineKeywords.length > 0 && !containsAnyToken(prospectInsights, headlineKeywords)) {
    issues.push('analysis.prospect_insights should reference a responsibility signal inferred from headline');
  }

  if (containsAnyToken(prospectInsights, ANALYSIS_GENERIC_PHRASES)) {
    issues.push('analysis.prospect_insights contains generic unsupported phrasing');
  }

  if (headlineKeywords.length > 0 && !containsAnyToken(valueProposition, headlineKeywords)) {
    issues.push('analysis.value_proposition should include responsibility language tied to headline');
  }

  if (companyContextKeywords.length > 0 && !containsAnyToken(valueProposition, companyContextKeywords)) {
    issues.push('analysis.value_proposition should include terms grounded in company_context');
  }

  if (!containsAnyToken(valueProposition, OPERATIONAL_IMPROVEMENT_KEYWORDS)) {
    issues.push('analysis.value_proposition should include a concrete operational improvement');
  }

  if (
    valueProposition.includes('streamline workflows') &&
    !containsAnyToken(valueProposition, SPECIFICITY_HINT_KEYWORDS)
  ) {
    issues.push('analysis.value_proposition uses vague language without operational specifics');
  }

  return issues;
}

function containsAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => token && text.includes(token.toLowerCase()));
}

function extractSignalKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));

  return Array.from(new Set(tokens)).slice(0, 12);
}

function buildFactsBlock(prospectData: ProspectData): string {
  const skills = Array.isArray(prospectData.profileData?.skills)
    ? (prospectData.profileData.skills as unknown[])
        .filter((item): item is string => typeof item === 'string')
        .join(', ')
    : 'n/a';

  const experience = Array.isArray(prospectData.profileData?.experience)
    ? (prospectData.profileData.experience as Array<Record<string, unknown>>)
        .map((entry) => {
          const title = typeof entry.title === 'string' ? entry.title : 'Unknown title';
          const company = typeof entry.company === 'string' ? entry.company : 'Unknown company';
          const duration = typeof entry.duration === 'string' ? entry.duration : 'Unknown duration';
          return `${title} at ${company} (${duration})`;
        })
        .join(' | ')
    : 'n/a';

  const summary =
    typeof prospectData.profileData?.summary === 'string'
      ? prospectData.profileData.summary
      : 'n/a';

  return `FACTS:
- Name: ${prospectData.fullName}
- Headline: ${prospectData.headline}
- Current Company: ${prospectData.company}
- Skills: ${skills}
- Experience: ${experience}
- Summary: ${summary}`;
}

function buildAnalysisSystemPrompt(): string {
  return `You are a B2B SaaS prospect analyst. Output ONLY valid JSON.

Return this exact structure:
{
  "analysis": {
    "prospect_insights": "Grounded analysis of this prospect's likely responsibilities and operating context",
    "personalization_hooks": ["specific hook 1", "specific hook 2"],
    "value_proposition": "Concrete value proposition connected to role + company_context + operational improvement"
  },
  "angles": ["angle 1", "angle 2", "angle 3"],
  "step_objectives": ["step 1 objective", "step 2 objective", "step 3 objective"]
}

MANDATORY GROUNDING:
- Use only provided facts; do not invent unsupported claims.
- In analysis.prospect_insights, reference at least one explicit skill when skills are provided.
- In analysis.prospect_insights, reference one responsibility inferred from headline.
- In analysis.value_proposition, explicitly connect:
  1) prospect responsibility,
  2) company_context capability,
  3) concrete operational improvement.
- Avoid vague phrases like "streamline workflows" unless you name a specific workflow/operational area.
- Ensure output varies across prospects by using provided profile data (headline, company, skills, experience).

ROLE-AWARE PLAYBOOKS:
- Engineering roles: prioritize reliability, deployment velocity, incident reduction, system performance.
- Product roles: prioritize prioritization quality, roadmap execution, cross-functional alignment, release outcomes.
- Data roles: prioritize pipeline reliability, data quality, model/report freshness, stakeholder delivery.
- DevOps/platform roles: prioritize infra stability, CI/CD throughput, change failure reduction, observability.
- Security roles: prioritize risk reduction, controls coverage, incident response readiness, compliance evidence.
- If role is mixed/unclear, stick to explicit facts and conservative inference.

SILENT QUALITY CHECKLIST (DO NOT OUTPUT):
- Skills referenced? Responsibility inferred from headline? Value prop linked to company_context and concrete operations?
- No generic unsupported claims?
- Output strictly valid JSON only.`;
}

function buildSystemPrompt(sequenceLength: number): string {
  return `You are an expert at writing realistic, insight-driven LinkedIn direct messages between experienced B2B SaaS operators.

CRITICAL REQUIREMENTS:
1. Output ONLY valid JSON. No markdown, no code blocks, no commentary, no extra text before or after the JSON.
2. Return a JSON object with this exact structure:
{
  "analysis": {
    "prospect_insights": "Brief analysis of the prospect, how their role operates day-to-day, and what they are likely accountable for",
    "personalization_hooks": ["specific observation or hook 1", "specific observation or hook 2"],
    "value_proposition": "Why this prospect should care, tied tightly to their responsibilities and likely challenges"
  },
  "messages": [
    {
      "step": 1,
      "message": "Full LinkedIn DM text",
      "reasoning": "Why this message works for this prospect, which profile signals it uses, and which role-level challenges it is addressing"
    }
  ],
  "confidence": 0.85
}

3. Generate exactly ${sequenceLength} messages in the messages array.
4. Each message must include:
   - step: sequential number (1, 2, 3...)
   - message: a single LinkedIn direct message (no subject line)
   - reasoning: explanation of why this message fits the prospect and how it uses their profile.

5. Confidence must be a number between 0 and 1 representing your confidence in the sequence quality.

LINKEDIN-NATIVE MESSAGING RULES:
- Write as LinkedIn DMs, not emails.
- NO subject lines.
- NO email formatting (no "Subject:", no greetings like "Dear ...", no signature blocks).
- NO signatures (no name, title, or company at the end).
- NO placeholders or template variables like [Your Company Name], [First Name], or any text in brackets [like this].
- NO brackets used as template markers. Do not output any [PLACEHOLDER] style text.

ANTI-GENERIC / ANTI-MARKETING GUARDRAILS:
- DO NOT use generic phrases such as:
  - "Hope this message finds you well"
  - "I came across your profile"
  - "Following up on my previous email"
  - "Would you be open to a brief chat"
  - "Just checking in"
- Avoid vague references like "some SaaS companies", "many businesses", or "organizations like yours".
- Avoid generic business clichés and obvious sales framing (e.g., "drive growth", "unlock new opportunities", "transform your business").

MESSAGE REALISM:
- step 1 message MUST be under 60 words.
- All messages must feel conversational and natural, as if written by a peer who deeply understands B2B SaaS, not a salesperson.
- Avoid corporate buzzwords and jargon (e.g., "synergies", "leverage at scale", "cutting-edge solution").
- Avoid over-polished marketing or pitch-deck tone. Prefer simple, specific, grounded language.

PERSONALIZATION & INSIGHT:
- Go beyond surface-level skills. Use the prospect's role, seniority, company type, and experience to infer what they are likely responsible for (metrics, workflows, decisions).
- Infer 1–2 likely challenges or tradeoffs this role faces and weave them into the messages.
- Tie the company context and value proposition directly to those responsibilities and challenges.
- Each message should include at least one subtle, concrete observation about the prospect's situation, not just flattery.
- Make each message feel written uniquely for this prospect, not a generic persona.

ANALYSIS GROUNDING RULES:
- In analysis.prospect_insights, explicitly reference at least one skill from profileData.skills when skills are provided.
- In analysis.prospect_insights, explicitly reference one likely responsibility inferred from the headline.
- Do not use generic claims unless directly supported by the provided profile data.
- In analysis.value_proposition, explicitly connect: (a) the prospect's likely responsibilities, (b) the provided company context, and (c) one concrete operational improvement.
- Avoid vague phrases like "streamline workflows" unless you name a specific workflow or operational area.
- Ensure variation across prospects by grounding analysis in the actual provided profile data (headline, company, skills, experience), not reused template phrasing.

ROLE-AWARE PLAYBOOKS:
- Engineering roles: emphasize reliability, release quality, performance, and incident load.
- Product roles: emphasize prioritization clarity, roadmap execution, and cross-functional throughput.
- Data roles: emphasize data quality, pipeline reliability, freshness, and stakeholder trust.
- DevOps/platform roles: emphasize CI/CD stability, infra reliability, and operational visibility.
- Security roles: emphasize control coverage, risk reduction, and response readiness.

STEP OBJECTIVES:
- Step 1: concise opener (<60 words), one grounded observation, one role-specific hypothesis.
- Step 2: spotlight a concrete operational friction tied to responsibility and context.
- Step 3: propose a concrete improvement and low-friction next step.
- Steps 4+: continue progression with new evidence-backed angles; avoid repetition.

INSIGHT-DRIVEN SEQUENCE:
- Treat this as thoughtful peer outreach: focus on observations, hypotheses, and value, not aggressive pitching.
- Each message should add a new, specific insight or angle (e.g., a pattern you see in similar companies, a workflow friction they probably have, or a small suggestion).

SEQUENCE COHERENCE:
- Each message should build naturally on the previous messages.
- Do not repeat the same pitch; evolve the conversation slightly with each step.

STRICT OUTPUT:
- DO NOT include markdown formatting.
- DO NOT include any commentary, explanation, or notes outside the JSON structure.
- DO NOT output raw chain-of-thought; keep reasoning concise and limited to the requested fields.

SILENT QUALITY RUBRIC (DO NOT OUTPUT):
- analysis.prospect_insights references at least one explicit skill (if available) and one responsibility inferred from headline.
- analysis.value_proposition explicitly links responsibility + company_context + concrete operational improvement.
- Messages follow step objectives and progressively evolve without generic filler.`;
}

function buildAnalysisUserPrompt(
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number,
  factsBlock: string
): string {
  return `Create an analysis plan for a ${sequenceLength}-message LinkedIn outreach sequence.

${factsBlock}

COMPANY CONTEXT:
${companyContext}

TONE OF VOICE:
${tovDescription}

Return ONLY JSON with analysis + angles + step_objectives.
- Provide at least ${Math.min(Math.max(sequenceLength, 2), 5)} angles.
- Provide exactly ${sequenceLength} step objectives.
- Keep all claims grounded in provided facts.`;
}

function buildUserPrompt(
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number,
  factsBlock: string,
  analysisPlan?: AnalysisPlan
): string {
  const analysisGuidance = analysisPlan
    ? `ANALYSIS PLAN (must inform your output):
${JSON.stringify(
        {
          analysis: analysisPlan.analysis,
          angles: analysisPlan.angles,
          step_objectives: analysisPlan.stepObjectives,
        },
        null,
        2
      )}`
    : 'ANALYSIS PLAN: Not provided. Infer from facts and constraints.';

  return `Generate a ${sequenceLength}-message LinkedIn direct message sequence for this prospect.

PROSPECT INFORMATION:
- Name: ${prospectData.fullName}
- Headline: ${prospectData.headline}
- Company: ${prospectData.company}
- Profile Data (JSON): ${JSON.stringify(prospectData.profileData)}

${factsBlock}

COMPANY CONTEXT (sender):
${companyContext}

TONE OF VOICE:
${tovDescription}

SEQUENCE REQUIREMENTS:
- Generate exactly ${sequenceLength} LinkedIn DMs.
- Each message must be a single message (no subject line, no email structure, no signature).
- Keep step 1 under 60 words.
- Make all messages conversational and natural, avoiding corporate buzzwords and over-polished marketing tone.
- Strong personalization: explicitly reference details from the prospect's role, headline, company, and experience where relevant.
- Tie the company context and value proposition directly to what this prospect likely cares about in their role.
- Avoid generic outreach templates and clichés.
- Build a natural progression across the sequence (e.g., initial connection-style message, then context-building, then value-driven follow-ups).
- In analysis.prospect_insights, include at least one explicit skill from profileData.skills when available and one responsibility inferred from the headline.
- In analysis.value_proposition, explicitly connect responsibilities + company context + a concrete operational improvement.

${analysisGuidance}

OUTPUT QUALITY CHECK (SILENT):
- Ensure claims are grounded in facts.
- Ensure response varies by this specific prospect data.
- Ensure no unsupported generic claims.

Return ONLY the JSON object as specified in the system prompt. Do not add any markdown or commentary.`;
}

function buildRepairSystemPrompt(sequenceLength: number): string {
  return `You are fixing a JSON output for quality compliance.

Return ONLY valid JSON in this exact structure:
{
  "analysis": {
    "prospect_insights": "...",
    "personalization_hooks": ["...", "..."],
    "value_proposition": "..."
  },
  "messages": [
    { "step": 1, "message": "...", "reasoning": "..." }
  ],
  "confidence": 0.85
}

Hard constraints:
- Exactly ${sequenceLength} messages with sequential steps starting at 1.
- Keep step 1 under 60 words.
- No markdown, no extra text, no raw chain-of-thought.
- Keep reasoning concise and field-limited.
- Preserve strong grounding in provided facts and company context.`;
}

function buildRepairUserPrompt(
  currentResponse: Record<string, any>,
  qualityIssues: string[],
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number,
  factsBlock: string,
  analysisPlan?: AnalysisPlan
): string {
  const analysisPlanText = analysisPlan
    ? JSON.stringify(
        {
          analysis: analysisPlan.analysis,
          angles: analysisPlan.angles,
          step_objectives: analysisPlan.stepObjectives,
        },
        null,
        2
      )
    : 'n/a';

  return `Fix the following JSON output to resolve quality issues while keeping the same overall intent.

QUALITY ISSUES TO FIX:
${qualityIssues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

CURRENT OUTPUT JSON:
${JSON.stringify(currentResponse, null, 2)}

PROSPECT FACTS:
${factsBlock}

PROSPECT INFORMATION:
- Name: ${prospectData.fullName}
- Headline: ${prospectData.headline}
- Company: ${prospectData.company}
- Profile Data (JSON): ${JSON.stringify(prospectData.profileData)}

COMPANY CONTEXT:
${companyContext}

TONE OF VOICE:
${tovDescription}

TARGET MESSAGE COUNT:
${sequenceLength}

ANALYSIS PLAN:
${analysisPlanText}

Return ONLY corrected JSON.`;
}

export { PROMPT_VERSION, MODEL };
