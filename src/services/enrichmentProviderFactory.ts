import {
  ProspectEnrichmentProvider,
  MockLinkedInProvider,
} from '../utils/linkedinParser';

let cachedProvider: ProspectEnrichmentProvider | null = null;

/**
 * Resolves the enrichment provider from configuration.
 *
 * The generation pipeline depends only on ProspectEnrichmentProvider — it never
 * knows which concrete implementation is active. To add a real LinkedIn provider:
 *   1. Implement ProspectEnrichmentProvider (map API response → ProspectProfile).
 *   2. Add a case here for the provider name.
 *   3. Set ENRICHMENT_PROVIDER=<name> in your environment.
 */
export function getEnrichmentProvider(): ProspectEnrichmentProvider {
  if (cachedProvider) {
    return cachedProvider;
  }

  const configuredProvider = (process.env.ENRICHMENT_PROVIDER || 'mock')
    .trim()
    .toLowerCase();

  switch (configuredProvider) {
    case 'mock':
      cachedProvider = new MockLinkedInProvider();
      break;
    default:
      console.warn(
        `Unknown ENRICHMENT_PROVIDER "${configuredProvider}". Falling back to "mock".`
      );
      cachedProvider = new MockLinkedInProvider();
      break;
  }

  return cachedProvider;
}

/**
 * Optional test hook for injecting a provider implementation.
 */
export function setEnrichmentProvider(provider: ProspectEnrichmentProvider): void {
  cachedProvider = provider;
}
