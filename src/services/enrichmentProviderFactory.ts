import {
  EnrichmentProvider,
  MockEnrichmentProvider,
} from '../utils/linkedinParser';

let cachedProvider: EnrichmentProvider | null = null;

/**
 * Resolves the enrichment provider from configuration.
 * This keeps the generation pipeline stable while allowing provider swaps.
 */
export function getEnrichmentProvider(): EnrichmentProvider {
  if (cachedProvider) {
    return cachedProvider;
  }

  const configuredProvider = (process.env.ENRICHMENT_PROVIDER || 'mock')
    .trim()
    .toLowerCase();

  switch (configuredProvider) {
    case 'mock':
      cachedProvider = new MockEnrichmentProvider();
      break;
    default:
      console.warn(
        `Unknown ENRICHMENT_PROVIDER "${configuredProvider}". Falling back to "mock".`
      );
      cachedProvider = new MockEnrichmentProvider();
      break;
  }

  return cachedProvider;
}

/**
 * Optional test hook for injecting a provider implementation.
 */
export function setEnrichmentProvider(provider: EnrichmentProvider): void {
  cachedProvider = provider;
}
