/**
 * LinkedIn Prospect Enrichment Layer
 *
 * WHY DETERMINISTIC ENRICHMENT:
 * This module uses deterministic mock enrichment derived from the LinkedIn URL slug.
 * The same slug always produces the same profile — no randomness, no external APIs.
 * This ensures:
 *   - Reproducible AI prompt grounding across identical requests
 *   - Stable idempotency (same input = same enrichment = same generation)
 *   - Testable, auditable enrichment output
 *
 * WHY THIS IMPROVES REPRODUCIBILITY:
 * By mapping slug → hash → structured profile deterministically, the AI pipeline
 * receives identical facts for identical prospects. This eliminates a source of
 * non-determinism that would otherwise require caching or deduplication at the
 * enrichment layer.
 *
 * HOW TO SWAP FOR A REAL PROVIDER:
 * 1. Implement ProspectEnrichmentProvider with a class that calls LinkedIn's
 *    official API (e.g., People Data Labs, Proxycurl, or LinkedIn Sales Navigator).
 * 2. Map the API response to the ProspectProfile interface.
 * 3. Register the new provider in enrichmentProviderFactory.ts.
 * 4. Set ENRICHMENT_PROVIDER=<provider-name> in your environment.
 * The generation pipeline remains unchanged — it only depends on ProspectProfile.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Role categories supported by the enrichment layer.
 * Each category drives deterministic skill and responsibility assignment.
 */
export type RoleCategory =
  | 'Engineering'
  | 'DevOps'
  | 'Security'
  | 'Data'
  | 'Product'
  | 'Sales';

/**
 * Seniority levels inferred from the LinkedIn slug.
 */
export type Seniority = 'Senior' | 'Manager' | 'Lead' | 'Founder';

/**
 * Strongly typed prospect profile produced by any enrichment provider.
 * The AI pipeline consumes this directly — roleCategory, seniority, skills,
 * and inferredResponsibilities ground the prompt without guesswork.
 */
export interface ProspectProfile {
  fullName: string;
  headline: string;
  company: string;
  roleCategory: RoleCategory;
  seniority: Seniority;
  skills: string[];
  inferredResponsibilities: string[];
  /**
   * Raw structured data stored in DB as JSONB.
   * Includes experience, education, summary, and the typed fields above
   * so the database record is self-contained.
   */
  profileData: {
    roleCategory: RoleCategory;
    seniority: Seniority;
    skills: string[];
    inferredResponsibilities: string[];
    experience: Array<{ title: string; company: string; duration: string }>;
    education: Array<{ school: string; degree: string }>;
    summary: string;
  };
}

/**
 * Interface for prospect enrichment providers.
 * Any implementation — mock or production — must satisfy this contract.
 * The generation pipeline depends only on this interface, never on a concrete provider.
 */
export interface ProspectEnrichmentProvider {
  enrich(linkedinUrl: string): Promise<ProspectProfile>;
}

// ---------------------------------------------------------------------------
// URL Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a LinkedIn URL to a clean slug.
 *
 * Accepts:
 *   https://linkedin.com/in/name
 *   https://www.linkedin.com/in/name/
 *   https://linkedin.com/in/name-abc123
 *   http://www.linkedin.com/in/name?trk=foo#bar
 *
 * Returns: "name" (lowercase, no protocol, no www, no trailing slash, no query params, no fragments)
 */
export function normalizeLinkedInSlug(url: string): string {
  // Strip protocol
  let cleaned = url.replace(/^https?:\/\//, '');
  // Strip www
  cleaned = cleaned.replace(/^www\./, '');
  // Strip query params and fragments
  cleaned = cleaned.split('?')[0].split('#')[0];
  // Strip trailing slash
  cleaned = cleaned.replace(/\/+$/, '');
  // Extract the /in/<slug> portion
  const match = cleaned.match(/linkedin\.com\/in\/([^/]+)/i);
  if (!match) {
    return 'unknown';
  }
  return match[1].toLowerCase();
}

// ---------------------------------------------------------------------------
// Deterministic Hash Utilities
// ---------------------------------------------------------------------------

/**
 * Simple deterministic string hash (djb2-style).
 * Returns a positive 32-bit integer. No randomness.
 */
function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Pick an index from a list deterministically using slug + salt.
 * Same slug + same salt always returns the same index.
 */
function deterministicIndex(slug: string, listLength: number, salt: string): number {
  if (listLength === 0) return 0;
  return hashString(`${slug}:${salt}`) % listLength;
}

function pickDeterministic<T>(items: T[], slug: string, salt: string): T {
  return items[deterministicIndex(slug, items.length, salt)];
}

// ---------------------------------------------------------------------------
// Static Mappings (NO randomness — role drives everything)
// ---------------------------------------------------------------------------

const ROLE_CATEGORIES: RoleCategory[] = ['Engineering', 'DevOps', 'Security', 'Data', 'Product', 'Sales'];

const SENIORITY_LEVELS: Seniority[] = ['Senior', 'Manager', 'Lead', 'Founder'];

/** Skills are fixed per role category — no random selection. */
const SKILLS_BY_ROLE: Record<RoleCategory, string[]> = {
  Engineering: ['TypeScript', 'Node.js', 'System Design'],
  DevOps: ['AWS', 'Kubernetes', 'CI/CD'],
  Security: ['Application Security', 'Threat Modeling', 'Cloud Security'],
  Data: ['Python', 'SQL', 'Data Modeling'],
  Product: ['Roadmapping', 'Stakeholder Alignment', 'Prioritization'],
  Sales: ['Outbound Prospecting', 'Pipeline Management', 'CRM Optimization'],
};

/** Responsibilities are inferred deterministically from roleCategory. */
const RESPONSIBILITIES_BY_ROLE: Record<RoleCategory, string[]> = {
  Engineering: [
    'backend platform ownership',
    'release quality',
    'cross-team technical validation',
  ],
  DevOps: [
    'infrastructure reliability',
    'CI/CD stability',
    'operational readiness',
  ],
  Security: [
    'risk assessment',
    'security control validation',
    'threat modeling review cycles',
  ],
  Data: [
    'pipeline reliability',
    'data quality validation',
    'stakeholder reporting cycles',
  ],
  Product: [
    'roadmap prioritization',
    'cross-functional alignment',
    'release coordination',
  ],
  Sales: [
    'pipeline generation',
    'prospect qualification',
    'outbound sequencing',
  ],
};

/** Title templates per role category. */
const TITLES_BY_ROLE: Record<RoleCategory, Record<Seniority, string>> = {
  Engineering: {
    Senior: 'Senior Software Engineer',
    Manager: 'Engineering Manager',
    Lead: 'Staff Engineer',
    Founder: 'Founding Engineer',
  },
  DevOps: {
    Senior: 'Senior DevOps Engineer',
    Manager: 'DevOps Manager',
    Lead: 'Lead Platform Engineer',
    Founder: 'Founding Infrastructure Engineer',
  },
  Security: {
    Senior: 'Senior Security Engineer',
    Manager: 'Security Engineering Manager',
    Lead: 'Lead Security Engineer',
    Founder: 'Founding Security Engineer',
  },
  Data: {
    Senior: 'Senior Data Engineer',
    Manager: 'Data Engineering Manager',
    Lead: 'Lead Data Engineer',
    Founder: 'Founding Data Engineer',
  },
  Product: {
    Senior: 'Senior Product Manager',
    Manager: 'Director of Product',
    Lead: 'Lead Product Manager',
    Founder: 'Head of Product',
  },
  Sales: {
    Senior: 'Senior Account Executive',
    Manager: 'Sales Manager',
    Lead: 'Head of Sales',
    Founder: 'VP of Sales',
  },
};

/** Focus areas per role for headline construction. */
const FOCUS_BY_ROLE: Record<RoleCategory, string> = {
  Engineering: 'Building scalable backend platforms',
  DevOps: 'Improving release reliability and infrastructure',
  Security: 'Strengthening cloud and application security posture',
  Data: 'Building reliable data pipelines and analytics',
  Product: 'Driving product strategy and cross-functional execution',
  Sales: 'Driving pipeline growth and outbound revenue',
};

// No fabricated company names — real LinkedIn enrichment would provide this.
// Mock uses a neutral placeholder so the AI doesn't cite a fake company.

const EXPERIENCE_START_YEARS = [2018, 2019, 2020, 2021, 2022];

const SCHOOLS = [
  'University of Technology',
  'State Technical University',
  'City Institute of Engineering',
  'Metropolitan School of Computing',
  'National University of Information Systems',
];

const DEGREES = [
  'BS Computer Science',
  'BS Software Engineering',
  'MS Information Systems',
  'BS Information Technology',
  'MS Computer Engineering',
];

// No keyword matching — real LinkedIn slugs are just names (e.g., "john-doe").
// Role and seniority are derived purely from deterministic hash.

// ---------------------------------------------------------------------------
// Deterministic Inference
// ---------------------------------------------------------------------------

function capitalizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9]/g, '');
  if (!cleaned) return 'Unknown';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/**
 * Infer role category from slug using deterministic hash.
 * Same slug → same hash → same role. Always.
 */
function inferRoleCategory(slug: string): RoleCategory {
  return pickDeterministic(ROLE_CATEGORIES, slug, 'role');
}

/**
 * Infer seniority from slug using deterministic hash.
 * Same slug → same hash → same seniority. Always.
 */
function inferSeniority(slug: string): Seniority {
  return pickDeterministic(SENIORITY_LEVELS, slug, 'seniority');
}

/**
 * Return a neutral company placeholder.
 * Real enrichment providers (People Data Labs, Proxycurl) would supply the actual company.
 * Mock enrichment avoids fabricating a fake company name — cleaner, less fabricated, more realistic.
 */
function generateCompanyName(_slug: string): string {
  return 'their current company';
}

/**
 * Build the full name from slug segments.
 * "john-doe" → "John Doe"
 * Real LinkedIn slugs are just names — no keyword stripping needed.
 */
function generateFullName(slug: string): string {
  const segments = slug.split('-').filter(Boolean);
  return segments.map((s) => capitalizeSegment(s)).join(' ') || 'Unknown';
}

// ---------------------------------------------------------------------------
// Role Remapping (context-driven role override)
// ---------------------------------------------------------------------------

/**
 * Remap an existing ProspectProfile to a different role category.
 * Called when the company_context implies a target role that differs from
 * the URL-slug-inferred role. Replaces skills, responsibilities, headline,
 * and title while preserving the prospect's name and company.
 */
export function remapProfileToRole(
  profile: ProspectProfile,
  targetRole: RoleCategory
): ProspectProfile {
  if (profile.roleCategory === targetRole) return profile;

  const skills = SKILLS_BY_ROLE[targetRole];
  const inferredResponsibilities = RESPONSIBILITIES_BY_ROLE[targetRole];
  const title = TITLES_BY_ROLE[targetRole][profile.seniority];
  const focus = FOCUS_BY_ROLE[targetRole];
  const headline = `${title} | ${focus}`;
  const summary = `Experienced ${title.toLowerCase()} focused on ${inferredResponsibilities[0]} and ${inferredResponsibilities[1]}.`;

  return {
    ...profile,
    headline,
    roleCategory: targetRole,
    skills,
    inferredResponsibilities,
    profileData: {
      ...profile.profileData,
      roleCategory: targetRole,
      skills,
      inferredResponsibilities,
      experience: [
        {
          title,
          company: profile.company,
          duration: profile.profileData.experience[0]?.duration ?? '2021 - Present',
        },
      ],
      summary,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Provider Implementation
// ---------------------------------------------------------------------------

/**
 * Deterministic mock LinkedIn enrichment provider.
 *
 * Given a LinkedIn URL, normalizes the slug and produces a fully structured
 * ProspectProfile using deterministic hash-based selection. No randomness,
 * no external APIs. Same URL always yields the same profile.
 *
 * This can be swapped for a real provider (e.g., People Data Labs, Proxycurl,
 * LinkedIn Sales Navigator API) by implementing ProspectEnrichmentProvider
 * and registering it in enrichmentProviderFactory.ts.
 */
export class MockLinkedInProvider implements ProspectEnrichmentProvider {
  async enrich(linkedinUrl: string): Promise<ProspectProfile> {
    // Step 1: Normalize URL → clean slug (deterministic, idempotent)
    const slug = normalizeLinkedInSlug(linkedinUrl);

    // Step 2: Infer role category from slug keywords or deterministic hash
    const roleCategory = inferRoleCategory(slug);

    // Step 3: Infer seniority from slug keywords or deterministic hash
    const seniority = inferSeniority(slug);

    // Step 4: Look up static skills and responsibilities (role-driven, not random)
    const skills = SKILLS_BY_ROLE[roleCategory];
    const inferredResponsibilities = RESPONSIBILITIES_BY_ROLE[roleCategory];

    // Step 5: Generate deterministic profile fields
    const fullName = generateFullName(slug);
    const company = generateCompanyName(slug);
    const title = TITLES_BY_ROLE[roleCategory][seniority];
    const focus = FOCUS_BY_ROLE[roleCategory];
    const headline = `${title} | ${focus}`;
    const summary = `Experienced ${title.toLowerCase()} focused on ${inferredResponsibilities[0]} and ${inferredResponsibilities[1]}.`;

    const experienceStartYear = pickDeterministic(EXPERIENCE_START_YEARS, slug, 'exp-year');
    const school = pickDeterministic(SCHOOLS, slug, 'school');
    const degree = pickDeterministic(DEGREES, slug, 'degree');

    return {
      fullName,
      headline,
      company,
      roleCategory,
      seniority,
      skills,
      inferredResponsibilities,
      profileData: {
        roleCategory,
        seniority,
        skills,
        inferredResponsibilities,
        experience: [
          {
            title,
            company,
            duration: `${experienceStartYear} - Present`,
          },
        ],
        education: [
          {
            school,
            degree,
          },
        ],
        summary,
      },
    };
  }
}
