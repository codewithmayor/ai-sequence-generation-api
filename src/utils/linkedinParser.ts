/**
 * Mock LinkedIn profile parser.
 * 
 * TRADEOFF: In production, this would integrate with LinkedIn's official API
 * or a third-party scraping service. For this assessment, we return structured
 * placeholder data based on the URL to demonstrate the data flow without
 * external dependencies or legal concerns around web scraping.
 * 
 * Production considerations:
 * - Use LinkedIn Sales Navigator API for official access
 * - Implement rate limiting and caching
 * - Handle profile privacy settings gracefully
 * - Store parsed profiles to avoid redundant API calls
 */
export interface LinkedInProfile {
  fullName: string;
  headline: string;
  company: string;
  profileData: {
    experience?: Array<{
      title: string;
      company: string;
      duration: string;
    }>;
    education?: Array<{
      school: string;
      degree: string;
    }>;
    skills?: string[];
    summary?: string;
  };
}

export interface EnrichmentProvider {
  enrichLinkedInProfile(url: string): Promise<LinkedInProfile>;
}

const COMPANY_SUFFIXES = ['Labs', 'Systems', 'Technologies', 'Solutions', 'Inc'];
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

interface RoleTemplate {
  title: string;
  focus: string;
  responsibility: string;
  coreSkills: string[];
}

const DEFAULT_ROLE_TEMPLATES: RoleTemplate[] = [
  {
    title: 'Senior Software Engineer',
    focus: 'Building scalable backend platforms',
    responsibility: 'service reliability and system performance',
    coreSkills: ['TypeScript', 'Node.js', 'PostgreSQL'],
  },
  {
    title: 'Engineering Manager',
    focus: 'Leading platform and delivery teams',
    responsibility: 'execution quality and engineering throughput',
    coreSkills: ['People Leadership', 'Roadmapping', 'System Design'],
  },
  {
    title: 'Product Manager',
    focus: 'Driving product strategy and execution',
    responsibility: 'prioritization and cross-functional delivery',
    coreSkills: ['Product Strategy', 'User Research', 'Analytics'],
  },
  {
    title: 'Data Engineer',
    focus: 'Building reliable data pipelines',
    responsibility: 'data quality and pipeline reliability',
    coreSkills: ['Python', 'SQL', 'Data Modeling'],
  },
  {
    title: 'DevOps Engineer',
    focus: 'Improving release reliability and infrastructure',
    responsibility: 'deployment stability and operational readiness',
    coreSkills: ['AWS', 'Kubernetes', 'CI/CD'],
  },
  {
    title: 'Security Engineer',
    focus: 'Strengthening cloud and application security',
    responsibility: 'risk reduction and security controls',
    coreSkills: ['Application Security', 'Threat Modeling', 'Cloud Security'],
  },
];

const HANDLE_KEYWORD_ROLE_MAP: Array<{ keyword: string; template: RoleTemplate }> = [
  { keyword: 'data', template: DEFAULT_ROLE_TEMPLATES[3] },
  { keyword: 'ml', template: DEFAULT_ROLE_TEMPLATES[3] },
  { keyword: 'analytics', template: DEFAULT_ROLE_TEMPLATES[3] },
  { keyword: 'product', template: DEFAULT_ROLE_TEMPLATES[2] },
  { keyword: 'pm', template: DEFAULT_ROLE_TEMPLATES[2] },
  { keyword: 'manager', template: DEFAULT_ROLE_TEMPLATES[1] },
  { keyword: 'lead', template: DEFAULT_ROLE_TEMPLATES[1] },
  { keyword: 'devops', template: DEFAULT_ROLE_TEMPLATES[4] },
  { keyword: 'platform', template: DEFAULT_ROLE_TEMPLATES[4] },
  { keyword: 'infra', template: DEFAULT_ROLE_TEMPLATES[4] },
  { keyword: 'security', template: DEFAULT_ROLE_TEMPLATES[5] },
  { keyword: 'sec', template: DEFAULT_ROLE_TEMPLATES[5] },
];

const SUPPLEMENTAL_SKILLS = [
  'Redis',
  'Docker',
  'GraphQL',
  'Kafka',
  'Terraform',
  'Observability',
  'Microservices',
  'A/B Testing',
  'ETL',
  'Feature Flags',
];

function extractLinkedInHandle(url: string): string {
  const handleMatch = url.match(/linkedin\.com\/in\/([^/?]+)/i);
  return handleMatch?.[1] || 'unknown';
}

function capitalizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9]/g, '');
  if (!cleaned) {
    return 'Unknown';
  }

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function deterministicIndex(seed: string, listLength: number, salt: string): number {
  if (listLength === 0) {
    return 0;
  }
  return hashString(`${seed}:${salt}`) % listLength;
}

function pickDeterministic<T>(items: T[], seed: string, salt: string): T {
  return items[deterministicIndex(seed, items.length, salt)];
}

function inferRoleTemplate(handle: string): RoleTemplate {
  const segments = handle.toLowerCase().split('-').filter(Boolean);

  for (const { keyword, template } of HANDLE_KEYWORD_ROLE_MAP) {
    if (segments.some((segment) => segment.includes(keyword))) {
      return template;
    }
  }

  return pickDeterministic(DEFAULT_ROLE_TEMPLATES, handle, 'default-role');
}

function generateDeterministicSkills(handle: string, template: RoleTemplate): string[] {
  const skills = [...template.coreSkills];
  const supplementalStart = deterministicIndex(handle, SUPPLEMENTAL_SKILLS.length, 'supplemental-skill-start');
  let offset = 0;

  while (skills.length < 5 && offset < SUPPLEMENTAL_SKILLS.length * 2) {
    const candidate = SUPPLEMENTAL_SKILLS[(supplementalStart + offset * 3) % SUPPLEMENTAL_SKILLS.length];
    if (!skills.includes(candidate)) {
      skills.push(candidate);
    }
    offset += 1;
  }

  return skills;
}

function generateCompanyName(handle: string): string {
  const segments = handle.split('-').filter(Boolean);
  const baseSegment = segments.length > 1 ? segments[1] : segments[0] || 'unknown';
  const baseName = capitalizeSegment(baseSegment);
  const suffix = COMPANY_SUFFIXES[hashString(handle) % COMPANY_SUFFIXES.length];
  return `${baseName} ${suffix}`;
}

export async function parseLinkedInProfile(url: string): Promise<LinkedInProfile> {
  // Extract a deterministic handle and derive mock profile values from it.
  const username = extractLinkedInHandle(url);
  const roleTemplate = inferRoleTemplate(username);
  const skills = generateDeterministicSkills(username, roleTemplate);
  const company = generateCompanyName(username);
  const educationSchool = pickDeterministic(SCHOOLS, username, 'school');
  const educationDegree = pickDeterministic(DEGREES, username, 'degree');
  const experienceStartYear = pickDeterministic(EXPERIENCE_START_YEARS, username, 'experience-year');
  const fullName =
    username
      .split('-')
      .filter(Boolean)
      .map((word) => capitalizeSegment(word))
      .join(' ') || 'Unknown';
  const headline = `${roleTemplate.title} | ${roleTemplate.focus}`;
  const summary = `Experienced ${roleTemplate.title.toLowerCase()} focused on ${roleTemplate.responsibility} using ${skills[0]} and ${skills[1]}.`;

  // Return mock structured data
  // In production, this would make an API call or use a scraping service
  return {
    fullName,
    headline,
    company,
    profileData: {
      experience: [
        {
          title: roleTemplate.title,
          company,
          duration: `${experienceStartYear} - Present`,
        },
      ],
      education: [
        {
          school: educationSchool,
          degree: educationDegree,
        },
      ],
      skills,
      summary,
    },
  };
}

export class MockEnrichmentProvider implements EnrichmentProvider {
  async enrichLinkedInProfile(url: string): Promise<LinkedInProfile> {
    return parseLinkedInProfile(url);
  }
}
