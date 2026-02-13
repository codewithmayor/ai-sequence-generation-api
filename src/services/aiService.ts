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

const PROMPT_VERSION = 'v1.1';

// Model selection: Using gpt-4o-mini for cost-effective prototyping
// In production, this could be configurable or A/B tested
const MODEL = 'gpt-4o-mini';

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

  const systemPrompt = buildSystemPrompt(sequenceLength);
  const userPrompt = buildUserPrompt(prospectData, companyContext, tovDescription, sequenceLength);

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7, // Balance between creativity and consistency
    });

    const rawResponse = response;
    const content = response.choices[0]?.message?.content;

    if (!content) {
      console.error('Empty response from OpenAI API', { responseId: response.id });
      throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
    }

    // Parse JSON response with safe fallbacks
    let parsedResponse: any;
    try {
      parsedResponse = JSON.parse(content);
    } catch (parseError) {
      // Handle cases where AI returns markdown-wrapped JSON or extra text
      try {
        const jsonMatch =
          content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);

        if (jsonMatch) {
          parsedResponse = JSON.parse(jsonMatch[1]);
        } else {
          console.error('Failed to parse AI response as JSON (no JSON block found).', {
            contentSnippet: content.slice(0, 300),
          });
          throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
        }
      } catch (nestedParseError) {
        console.error('Failed to parse AI response as JSON after extraction attempt.', {
          contentSnippet: content.slice(0, 300),
          error: nestedParseError instanceof Error ? nestedParseError.message : nestedParseError,
        });
        throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
      }
    }

    // Validate response structure
    if (!parsedResponse.messages || !Array.isArray(parsedResponse.messages)) {
      console.error('Invalid AI response structure: missing messages array.', {
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

    // Validate each generated message has the required shape.
    for (const [index, messageItem] of parsedResponse.messages.entries()) {
      if (!messageItem || typeof messageItem !== 'object') {
        console.error('Invalid AI response structure: message is not an object.', { index });
        throw new AppError('AI generation failed', 500, 'AI_GENERATION_FAILED');
      }

      const step = (messageItem as { step?: unknown }).step;
      const messageText = (messageItem as { message?: unknown }).message;
      const reasoningText = (messageItem as { reasoning?: unknown }).reasoning;

      if (!Number.isInteger(step) || (step as number) < 1) {
        console.error('Invalid AI response structure: message.step must be a positive integer.', {
          index,
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

    // Extract token usage
    const usage = response.usage;
    const promptTokens = usage?.prompt_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;
    const totalTokens = usage?.total_tokens || 0;

    // Calculate estimated cost
    const estimatedCost =
      (promptTokens / 1_000_000) * PROMPT_COST_PER_1M +
      (completionTokens / 1_000_000) * COMPLETION_COST_PER_1M;

    // Log token usage for observability and cost tracking
    console.log('AI generation token usage', {
      model: MODEL,
      promptVersion: PROMPT_VERSION,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
    });

    return {
      analysis: parsedResponse.analysis || {},
      messages: parsedResponse.messages,
      confidence: parsedResponse.confidence,
      tokenUsage: {
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCost,
      },
      rawResponse: rawResponse,
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

INSIGHT-DRIVEN SEQUENCE:
- Treat this as thoughtful peer outreach: focus on observations, hypotheses, and value, not aggressive pitching.
- Each message should add a new, specific insight or angle (e.g., a pattern you see in similar companies, a workflow friction they probably have, or a small suggestion).

SEQUENCE COHERENCE:
- Each message should build naturally on the previous messages.
- Do not repeat the same pitch; evolve the conversation slightly with each step.

STRICT OUTPUT:
- DO NOT include markdown formatting.
- DO NOT include any commentary, explanation, or notes outside the JSON structure.`;
}

function buildUserPrompt(
  prospectData: ProspectData,
  companyContext: string,
  tovDescription: string,
  sequenceLength: number
): string {
  return `Generate a ${sequenceLength}-message LinkedIn direct message sequence for this prospect.

PROSPECT INFORMATION:
- Name: ${prospectData.fullName}
- Headline: ${prospectData.headline}
- Company: ${prospectData.company}
- Profile Data (JSON): ${JSON.stringify(prospectData.profileData)}

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

Return ONLY the JSON object as specified in the system prompt. Do not add any markdown or commentary.`;
}

export { PROMPT_VERSION, MODEL };
