import { generateSequenceSchema } from '../utils/validation';
import prisma from '../db/prisma';
import { ProspectEnrichmentProvider } from '../utils/linkedinParser';
import { translateTovToDescription } from '../utils/tovTranslator';
import { computeMessageStrategy } from '../utils/roleContextStrategy';
import { generateSequenceWithAI, PROMPT_VERSION, MODEL } from './aiService';
import { getEnrichmentProvider } from './enrichmentProviderFactory';

export interface SequenceResponse {
  analysis: Record<string, any>;
  messages: Array<{
    step: number;
    message: string;
    reasoning: string;
  }>;
  confidence: number;
}

interface SequenceServiceDependencies {
  enrichmentProvider?: ProspectEnrichmentProvider;
}

/**
 * Main service function for generating or retrieving message sequences.
 * Implements idempotency: if an identical request exists, returns cached result.
 */
export async function generateSequenceService(
  input: unknown,
  dependencies: SequenceServiceDependencies = {}
): Promise<SequenceResponse> {
  // Validate input
  const validatedInput = generateSequenceSchema.parse(input);
  const enrichmentProvider =
    dependencies.enrichmentProvider ?? getEnrichmentProvider();

  const { prospect_url, tov_config, company_context, sequence_length } = validatedInput;

  // Check for existing sequence (idempotency)
  const existingSequence = await findExistingSequence(
    prospect_url,
    company_context,
    tov_config,
    sequence_length
  );

  if (existingSequence) {
    console.log('Idempotent sequence hit - returning cached result (no AI cost incurred)', {
      prospectUrl: prospect_url,
      companyContext: company_context,
      sequenceLength: sequence_length,
      tovConfig: tov_config,
      sequenceId: existingSequence.id,
    });

    return {
      analysis: existingSequence.analysis as Record<string, any>,
      messages: existingSequence.messages as Array<{
        step: number;
        message: string;
        reasoning: string;
      }>,
      confidence: existingSequence.confidence,
    };
  }

  // Enrich prospect profile through a swappable enrichment provider.
  // The provider returns a strongly typed ProspectProfile with roleCategory,
  // seniority, skills, and inferredResponsibilities — grounding the AI pipeline.
  const profile = await enrichmentProvider.enrich(prospect_url);

  // --- Role–Context Strategy Engine ---
  // Derive target role deterministically from company_context,
  // intersect with capability tags and role-allowed workflows,
  // and produce a focused MessageStrategy for the AI pipeline.
  //
  // IMPORTANT: We do NOT remap the profile. The prospect keeps their authentic
  // identity (skills, headline, title). The strategy only adapts WHICH frictions
  // to surface and HOW to frame the value — preventing grounding drift.
  const strategy = computeMessageStrategy(company_context, profile.roleCategory);

  // Log alignment diagnostics — prospectRole and targetPersona stay separate.
  // The profile keeps its authentic identity; the persona guides the strategy.
  console.log('Message strategy computed', {
    prospectRole: profile.roleCategory,
    targetPersona: strategy.targetPersona,
    personaShifted: strategy.targetPersona !== profile.roleCategory,
    capabilityTags: strategy.capabilityTags,
    activeWorkflows: strategy.activeWorkflows,
    alignmentScore: strategy.alignmentScore,
    alignmentNote: strategy.alignmentNote,
  });

  if (strategy.alignmentScore < 0.25) {
    console.warn('Low contextual alignment between prospect role and company_context', {
      prospectRole: profile.roleCategory,
      targetPersona: strategy.targetPersona,
      alignmentScore: strategy.alignmentScore,
    });
  }

  // Translate TOV to description
  const tovDescription = translateTovToDescription(
    tov_config.formality,
    tov_config.warmth,
    tov_config.directness
  );

  // Generate sequence with AI — receives profile, context, and strategy.
  const aiResult = await generateSequenceWithAI(
    profile,
    company_context,
    tovDescription,
    sequence_length,
    strategy
  );

  // Store everything in database using transaction for atomicity
  // Increased timeout to 15s to handle multiple sequential DB operations
  const result = await prisma.$transaction(
    async (tx) => {
    // Upsert prospect
    const prospect = await tx.prospect.upsert({
      where: { linkedinUrl: prospect_url },
      update: {
        fullName: profile.fullName,
        headline: profile.headline,
        company: profile.company,
        profileData: profile.profileData,
        updatedAt: new Date(),
      },
      create: {
        linkedinUrl: prospect_url,
        fullName: profile.fullName,
        headline: profile.headline,
        company: profile.company,
        profileData: profile.profileData,
      },
    });

    // Create or find TOV config
    const tovConfig = await tx.tovConfig.findFirst({
      where: {
        formality: tov_config.formality,
        warmth: tov_config.warmth,
        directness: tov_config.directness,
      },
    });

    let finalTovConfig;
    if (tovConfig) {
      finalTovConfig = tovConfig;
    } else {
      finalTovConfig = await tx.tovConfig.create({
        data: {
          formality: tov_config.formality,
          warmth: tov_config.warmth,
          directness: tov_config.directness,
          description: tovDescription,
        },
      });
    }

    // Create message sequence
    const sequence = await tx.messageSequence.create({
      data: {
        prospectId: prospect.id,
        tovConfigId: finalTovConfig.id,
        companyContext: company_context,
        sequenceLength: sequence_length,
        messages: aiResult.messages,
        analysis: aiResult.analysis,
        confidence: aiResult.confidence,
      },
    });

    // Create AI generation record
    await tx.aIGeneration.create({
      data: {
        sequenceId: sequence.id,
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        promptTokens: aiResult.tokenUsage.promptTokens,
        completionTokens: aiResult.tokenUsage.completionTokens,
        totalTokens: aiResult.tokenUsage.totalTokens,
        estimatedCost: aiResult.tokenUsage.estimatedCost,
        rawResponse: aiResult.rawResponse,
        thinking: {
          analysis: aiResult.analysis,
          strategy: {
            prospectRole: profile.roleCategory,
            targetPersona: strategy.targetPersona,
            capabilityTags: strategy.capabilityTags,
            activeWorkflows: strategy.activeWorkflows,
            alignmentScore: strategy.alignmentScore,
          },
        },
      },
    });

    return sequence;
    },
    {
      timeout: 15000, // 15 seconds - enough for multiple sequential DB operations
    }
  );

  return {
    analysis: result.analysis as Record<string, any>,
    messages: result.messages as Array<{
      step: number;
      message: string;
      reasoning: string;
    }>,
    confidence: result.confidence,
  };
}

/**
 * Idempotency check: Find existing sequence with identical parameters.
 * Uses deterministic lookup based on prospect URL, company context, TOV values, and sequence length.
 */
async function findExistingSequence(
  prospectUrl: string,
  companyContext: string,
  tovConfig: { formality: number; warmth: number; directness: number },
  sequenceLength: number
) {
  // Find prospect
  const prospect = await prisma.prospect.findUnique({
    where: { linkedinUrl: prospectUrl },
  });

  if (!prospect) {
    return null;
  }

  // Find matching TOV config
  const tov = await prisma.tovConfig.findFirst({
    where: {
      formality: tovConfig.formality,
      warmth: tovConfig.warmth,
      directness: tovConfig.directness,
    },
  });

  if (!tov) {
    return null;
  }

  // Find matching sequence generated with the current prompt version.
  const sequence = await prisma.messageSequence.findFirst({
    where: {
      prospectId: prospect.id,
      tovConfigId: tov.id,
      companyContext: companyContext,
      sequenceLength,
      aiGenerations: {
        some: {
          promptVersion: PROMPT_VERSION,
        },
      },
    },
    orderBy: {
      createdAt: 'desc', // Return most recent if multiple exist
    },
  });

  if (!sequence) {
    const staleSequence = await prisma.messageSequence.findFirst({
      where: {
        prospectId: prospect.id,
        tovConfigId: tov.id,
        companyContext: companyContext,
        sequenceLength,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        aiGenerations: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
      },
    });

    if (staleSequence) {
      console.log('Skipping cached sequence due to prompt version mismatch; regenerating.', {
        sequenceId: staleSequence.id,
        expectedPromptVersion: PROMPT_VERSION,
        cachedPromptVersion: staleSequence.aiGenerations[0]?.promptVersion || null,
      });
    }
  }

  return sequence;
}
