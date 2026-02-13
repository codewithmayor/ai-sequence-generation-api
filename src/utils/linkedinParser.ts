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

const COMPANY_SUFFIXES = ['Labs', 'Systems', 'Technologies', 'Solutions', 'Inc'];

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
  const company = generateCompanyName(username);
  const fullName =
    username
      .split('-')
      .filter(Boolean)
      .map((word) => capitalizeSegment(word))
      .join(' ') || 'Unknown';

  // Return mock structured data
  // In production, this would make an API call or use a scraping service
  return {
    fullName,
    headline: 'Senior Software Engineer | Building scalable systems',
    company,
    profileData: {
      experience: [
        {
          title: 'Senior Software Engineer',
          company,
          duration: '2020 - Present',
        },
      ],
      education: [
        {
          school: 'University of Technology',
          degree: 'BS Computer Science',
        },
      ],
      skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'AWS'],
      summary: 'Experienced engineer passionate about building robust systems.',
    },
  };
}
