/**
 * Role–Context Strategy Engine
 *
 * Derives the target prospect role deterministically from the company_context,
 * maps both role and context to structured capability/workflow tags,
 * intersects them to produce a focused MessageStrategy that drives the AI pipeline.
 *
 * This module encodes:
 *   1. Context → Role inference        (who should receive this message?)
 *   2. Context → Capability tags       (what does the selling company do?)
 *   3. Role → Allowed workflow impacts  (what frictions are legitimate for this role?)
 *   4. Intersection → Active workflows  (which frictions actually apply?)
 *   5. Alignment scoring                (how well does the context match the role?)
 *
 * The AI generation pipeline consumes MessageStrategy directly — no guesswork,
 * no generic fallbacks. Every message is grounded in a causally valid intersection.
 */

import type { RoleCategory } from './linkedinParser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tags describing what the selling company's product does. */
export type CapabilityTag =
  | 'qualification'
  | 'filtering'
  | 'enrichment'
  | 'personalization'
  | 'security-review-reduction'
  | 'pipeline-automation'
  | 'handoff-optimization'
  | 'triage-automation'
  | 'demo-qualification'
  | 'targeting-precision'
  | 'escalation-reduction';

/** Tags describing workflow frictions legitimate for a given role. */
export type WorkflowTag =
  | 'unqualified-escalations'
  | 'ad-hoc-data-requests'
  | 'pre-sales-feasibility'
  | 'security-questionnaires'
  | 'demo-environment-requests'
  | 'roadmap-disruption'
  | 'founder-interrupts'
  | 'manual-enrichment'
  | 'low-fit-leads'
  | 'qualification-cycles'
  | 'personalization-at-scale'
  | 'feature-request-noise'
  | 'compliance-checks'
  | 'architecture-discussions';

/** The computed message strategy consumed by the AI pipeline. */
export interface MessageStrategy {
  /** Persona derived from company_context — who the pitch is aimed at. */
  targetPersona: RoleCategory;
  /** What the selling company's product does. */
  capabilityTags: CapabilityTag[];
  /** All workflow frictions legitimate for the target persona. */
  allowedWorkflows: WorkflowTag[];
  /** Intersection: workflows both relevant to context AND legitimate for persona. */
  activeWorkflows: WorkflowTag[];
  /** 0–1 score: how well the context aligns with the target persona. */
  alignmentScore: number;
  /** Internal diagnostic note (logged, not exposed to API consumers). */
  alignmentNote: string;
}

// ---------------------------------------------------------------------------
// Context → Role inference
// ---------------------------------------------------------------------------

/**
 * Weighted keyword signals for inferring the target role from company_context.
 * Higher weight = stronger signal. Multiple matches accumulate.
 */
const CONTEXT_ROLE_SIGNALS: Array<{
  keywords: string[];
  role: RoleCategory;
  weight: number;
}> = [
  // Sales signals (direct outbound improvement)
  { keywords: ['sales team', 'outbound', 'pipeline', 'prospecting', 'sdr', 'bdr', 'quota', 'revenue team'], role: 'Sales', weight: 3 },
  { keywords: ['crm', 'cold outreach', 'sales cycle', 'close rate'], role: 'Sales', weight: 2 },

  // Security signals (burden reduction)
  { keywords: ['security review', 'security questionnaire', 'compliance review', 'vendor review', 'security assessment'], role: 'Security', weight: 3 },
  { keywords: ['compliance', 'risk assessment', 'audit'], role: 'Security', weight: 2 },

  // Data signals (noise reduction)
  { keywords: ['data team', 'data pull', 'analytics request', 'data feasibility', 'enrichment request'], role: 'Data', weight: 3 },
  { keywords: ['reporting', 'bi team', 'data validation'], role: 'Data', weight: 2 },

  // DevOps signals (interrupt reduction)
  { keywords: ['infrastructure', 'demo environment', 'infra feasibility', 'environment request', 'devops'], role: 'DevOps', weight: 3 },
  { keywords: ['deployment', 'ci/cd', 'platform team', 'sre'], role: 'DevOps', weight: 2 },

  // Product signals (prioritization protection)
  { keywords: ['product team', 'roadmap', 'feature request', 'prioritization', 'product scope'], role: 'Product', weight: 3 },
  { keywords: ['backlog', 'product-market', 'user research'], role: 'Product', weight: 2 },

  // Engineering signals (interrupt/escalation reduction)
  { keywords: ['engineering team', 'technical validation', 'engineering escalation', 'architect'], role: 'Engineering', weight: 3 },
  { keywords: ['backend', 'frontend', 'sprint planning', 'engineering bandwidth'], role: 'Engineering', weight: 2 },
];

/**
 * Infer the target prospect role from the company_context.
 * Deterministic: same context always produces the same role.
 * Uses accumulated weighted keyword matching — highest-scoring role wins.
 */
export function inferTargetRoleFromContext(companyContext: string): RoleCategory {
  const ctx = companyContext.toLowerCase();
  const scores: Record<string, number> = {};

  for (const signal of CONTEXT_ROLE_SIGNALS) {
    for (const kw of signal.keywords) {
      if (ctx.includes(kw)) {
        scores[signal.role] = (scores[signal.role] || 0) + signal.weight;
      }
    }
  }

  // Find highest-scoring role
  let bestRole: RoleCategory = 'Engineering'; // default
  let bestScore = 0;

  for (const [role, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestRole = role as RoleCategory;
    }
  }

  // If no keywords matched at all, apply simple heuristic
  if (bestScore === 0) {
    if (ctx.includes('sales') || ctx.includes('automate')) return 'Sales';
    if (ctx.includes('security')) return 'Security';
    return 'Engineering';
  }

  return bestRole;
}

// ---------------------------------------------------------------------------
// Context → Capability tags
// ---------------------------------------------------------------------------

const CONTEXT_CAPABILITY_MAP: Array<{
  keywords: string[];
  tag: CapabilityTag;
}> = [
  { keywords: ['qualify', 'qualification', 'icp', 'fit', 'qualified'], tag: 'qualification' },
  { keywords: ['filter', 'filtering', 'gate', 'screen', 'fewer'], tag: 'filtering' },
  { keywords: ['enrich', 'enrichment', 'research', 'prospect data'], tag: 'enrichment' },
  { keywords: ['personalize', 'personalization', 'tailor', 'custom message'], tag: 'personalization' },
  { keywords: ['security review', 'security questionnaire', 'compliance review'], tag: 'security-review-reduction' },
  { keywords: ['pipeline', 'outbound', 'sequence', 'automate sales'], tag: 'pipeline-automation' },
  { keywords: ['handoff', 'escalation', 'routing', 'hand-off'], tag: 'handoff-optimization' },
  { keywords: ['triage', 'inbound', 'sort', 'prioritize inbound'], tag: 'triage-automation' },
  { keywords: ['demo', 'trial', 'poc', 'proof of concept'], tag: 'demo-qualification' },
  { keywords: ['target', 'targeting', 'precision', 'icp match'], tag: 'targeting-precision' },
  { keywords: ['reduce escalation', 'fewer escalation', 'escalation volume'], tag: 'escalation-reduction' },
];

/**
 * Extract capability tags from the company_context.
 * Deterministic: same context always produces the same tags.
 */
export function extractCapabilityTags(companyContext: string): CapabilityTag[] {
  const ctx = companyContext.toLowerCase();
  const tags: Set<CapabilityTag> = new Set();

  for (const mapping of CONTEXT_CAPABILITY_MAP) {
    for (const kw of mapping.keywords) {
      if (ctx.includes(kw)) {
        tags.add(mapping.tag);
        break; // one match per mapping is enough
      }
    }
  }

  // If no tags extracted, infer from broad signals
  if (tags.size === 0) {
    if (ctx.includes('automate') || ctx.includes('automation')) {
      tags.add('pipeline-automation');
    }
    if (ctx.includes('sales')) {
      tags.add('qualification');
    }
    // Minimum fallback: qualification (the most universal capability)
    if (tags.size === 0) {
      tags.add('qualification');
    }
  }

  return [...tags];
}

// ---------------------------------------------------------------------------
// Role → Allowed workflow impacts
// ---------------------------------------------------------------------------

/**
 * Maps each role to the workflow friction tags that are causally legitimate.
 * These are the ONLY frictions that can appear in messages for that role.
 */
const ROLE_ALLOWED_WORKFLOWS: Record<RoleCategory, WorkflowTag[]> = {
  Engineering: [
    'unqualified-escalations',
    'founder-interrupts',
    'pre-sales-feasibility',
    'architecture-discussions',
  ],
  DevOps: [
    'demo-environment-requests',
    'pre-sales-feasibility',
    'founder-interrupts',
    'architecture-discussions',
  ],
  Security: [
    'security-questionnaires',
    'compliance-checks',
    'pre-sales-feasibility',
    'unqualified-escalations',
  ],
  Data: [
    'ad-hoc-data-requests',
    'pre-sales-feasibility',
    'manual-enrichment',
    'unqualified-escalations',
  ],
  Product: [
    'roadmap-disruption',
    'feature-request-noise',
    'pre-sales-feasibility',
    'qualification-cycles',
  ],
  Sales: [
    'low-fit-leads',
    'manual-enrichment',
    'qualification-cycles',
    'personalization-at-scale',
  ],
};

// ---------------------------------------------------------------------------
// Capability → Workflow bridge
// ---------------------------------------------------------------------------

/**
 * Maps capability tags to the workflow frictions they address.
 * This is the bridge between what the company DOES and what frictions it SOLVES.
 */
const CAPABILITY_WORKFLOW_BRIDGE: Record<CapabilityTag, WorkflowTag[]> = {
  'qualification': [
    'unqualified-escalations', 'pre-sales-feasibility', 'security-questionnaires',
    'low-fit-leads', 'qualification-cycles', 'compliance-checks',
    'architecture-discussions', 'demo-environment-requests',
  ],
  'filtering': [
    'unqualified-escalations', 'ad-hoc-data-requests', 'feature-request-noise',
    'security-questionnaires', 'compliance-checks', 'low-fit-leads',
  ],
  'enrichment': [
    'manual-enrichment', 'ad-hoc-data-requests', 'personalization-at-scale',
  ],
  'personalization': [
    'personalization-at-scale', 'manual-enrichment',
  ],
  'security-review-reduction': [
    'security-questionnaires', 'compliance-checks',
  ],
  'pipeline-automation': [
    'low-fit-leads', 'qualification-cycles', 'personalization-at-scale',
    'manual-enrichment',
  ],
  'handoff-optimization': [
    'unqualified-escalations', 'founder-interrupts', 'pre-sales-feasibility',
  ],
  'triage-automation': [
    'unqualified-escalations', 'ad-hoc-data-requests', 'low-fit-leads',
    'feature-request-noise',
  ],
  'demo-qualification': [
    'demo-environment-requests', 'pre-sales-feasibility',
  ],
  'targeting-precision': [
    'low-fit-leads', 'qualification-cycles', 'unqualified-escalations',
  ],
  'escalation-reduction': [
    'unqualified-escalations', 'founder-interrupts', 'architecture-discussions',
  ],
};

// ---------------------------------------------------------------------------
// Intersection + Alignment
// ---------------------------------------------------------------------------

/**
 * Compute the intersection of capability-driven workflows and role-allowed workflows.
 * Only workflows that are BOTH:
 *   1. Addressable by the company's capabilities
 *   2. Causally legitimate for the target role
 * make it into the active set.
 */
function intersectWorkflows(
  capabilityTags: CapabilityTag[],
  roleWorkflows: WorkflowTag[]
): WorkflowTag[] {
  // Collect all workflows the company's capabilities can address
  const capabilityWorkflows = new Set<WorkflowTag>();
  for (const tag of capabilityTags) {
    const workflows = CAPABILITY_WORKFLOW_BRIDGE[tag] || [];
    for (const wf of workflows) {
      capabilityWorkflows.add(wf);
    }
  }

  // Intersect with role's allowed workflows
  return roleWorkflows.filter((wf) => capabilityWorkflows.has(wf));
}

/**
 * Compute alignment score: how well does the company_context match the target role?
 * Score = |activeWorkflows| / |roleAllowedWorkflows|
 * 1.0 = perfect alignment (all role frictions covered by capabilities)
 * 0.0 = no overlap (capabilities don't address any role frictions)
 */
function computeAlignmentScore(
  activeWorkflows: WorkflowTag[],
  roleWorkflows: WorkflowTag[]
): { score: number; note: string } {
  if (roleWorkflows.length === 0) {
    return { score: 0, note: 'No allowed workflows defined for role' };
  }

  const score = activeWorkflows.length / roleWorkflows.length;

  let note: string;
  if (score >= 0.75) {
    note = 'Strong alignment — company capabilities directly address most role frictions';
  } else if (score >= 0.5) {
    note = 'Moderate alignment — some role frictions are addressable';
  } else if (score > 0) {
    note = 'Low contextual alignment between prospect role and company_context';
  } else {
    note = 'No overlap — company capabilities do not address any frictions for this role';
  }

  return { score: Math.round(score * 100) / 100, note };
}

// ---------------------------------------------------------------------------
// Public API — Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute the full message strategy from company_context and an optional
 * enrichment-inferred role. If the context implies a different target role,
 * the context-derived role takes precedence.
 *
 * This function is deterministic: same inputs always produce the same strategy.
 *
 * @param companyContext - What the selling company does
 * @param enrichedRole  - Role inferred from LinkedIn slug enrichment
 * @returns MessageStrategy with resolved role, tags, workflows, and alignment
 */
export function computeMessageStrategy(
  companyContext: string,
  enrichedRole: RoleCategory
): MessageStrategy {
  // 1. Derive target role from company_context
  const contextRole = inferTargetRoleFromContext(companyContext);

  // 2. Resolve target persona — context takes precedence over slug inference.
  //    The persona guides strategy; the profile stays authentic.
  const targetPersona = contextRole;

  // 3. Extract what the company's product does
  const capabilityTags = extractCapabilityTags(companyContext);

  // 4. Get allowed workflows for the target persona
  const allowedWorkflows = ROLE_ALLOWED_WORKFLOWS[targetPersona];

  // 5. Intersect: which persona frictions can the company actually address?
  const activeWorkflows = intersectWorkflows(capabilityTags, allowedWorkflows);

  // 6. Score alignment
  const { score, note } = computeAlignmentScore(activeWorkflows, allowedWorkflows);

  // 7. Build alignment note with persona derivation info
  const personaShifted = enrichedRole !== targetPersona;
  const fullNote = personaShifted
    ? `Persona shift: prospect is ${enrichedRole}, targeting ${targetPersona} frictions (context-driven). ${note}`
    : `Persona confirmed: ${targetPersona}. ${note}`;

  return {
    targetPersona,
    capabilityTags,
    allowedWorkflows,
    activeWorkflows,
    alignmentScore: score,
    alignmentNote: fullNote,
  };
}

// ---------------------------------------------------------------------------
// Prompt serialization — converts strategy to prompt-injectable text
// ---------------------------------------------------------------------------

/**
 * Human-readable descriptions of workflow tags for prompt injection.
 */
const WORKFLOW_DESCRIPTIONS: Record<WorkflowTag, string> = {
  'unqualified-escalations': 'unqualified prospects escalated to technical teams',
  'ad-hoc-data-requests': 'ad-hoc data pulls for prospects that go nowhere',
  'pre-sales-feasibility': '"can we support this?" feasibility checks for unqualified deals',
  'security-questionnaires': 'security questionnaires filled for prospects who never buy',
  'demo-environment-requests': 'demo environments spun up for prospects who never close',
  'roadmap-disruption': 'roadmap disrupted by unqualified prospect feature requests',
  'founder-interrupts': 'founders pulling team into unqualified prospect conversations',
  'manual-enrichment': 'manual hours spent researching prospects',
  'low-fit-leads': 'time wasted on prospects who don\'t match ICP',
  'qualification-cycles': 'slow back-and-forth to determine prospect fit',
  'personalization-at-scale': 'individual messages written without structured prospect intelligence',
  'feature-request-noise': 'cross-functional noise from prospect-driven feature requests',
  'compliance-checks': 'compliance checks triggered by low-fit prospects',
  'architecture-discussions': 'architecture discussions triggered by unqualified prospects',
};

/**
 * Serialize the active workflows into a prompt-ready block.
 * This replaces the static ROLE_IMPACT_MAP in the AI pipeline.
 */
export function strategyToPromptBlock(strategy: MessageStrategy): string {
  if (strategy.activeWorkflows.length === 0) {
    // Fallback: use all allowed workflows for the persona
    const fallbackDescriptions = strategy.allowedWorkflows
      .map((wf) => `- ${WORKFLOW_DESCRIPTIONS[wf]}`)
      .join('\n');
    return `PERSONA FRICTIONS (${strategy.targetPersona}) — pick the ONE most relevant to company_context:
${fallbackDescriptions}
Their skills are CONTEXT for personalization. The friction is what our product solves.`;
  }

  const descriptions = strategy.activeWorkflows
    .map((wf) => `- ${WORKFLOW_DESCRIPTIONS[wf]}`)
    .join('\n');

  return `TARGETED FRICTIONS (${strategy.targetPersona}, derived from company_context alignment):
${descriptions}
These frictions are causally validated: the company's capabilities directly address them for this persona.
Pick the ONE most relevant. Build ALL messages around it as a progressive narrative.
Their skills are CONTEXT for personalization. The friction is what our product solves.`;
}
