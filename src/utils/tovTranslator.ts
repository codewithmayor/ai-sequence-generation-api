/**
 * Translates numeric tone-of-voice values (0-1) into natural language instructions
 * for AI prompt generation.
 */
export function translateTovToDescription(
  formality: number,
  warmth: number,
  directness: number
): string {
  const formalityDesc = getFormalityDescription(formality);
  const warmthDesc = getWarmthDescription(warmth);
  const directnessDesc = getDirectnessDescription(directness);

  return `${formalityDesc}, ${warmthDesc}, and ${directnessDesc}`;
}

function getFormalityDescription(value: number): string {
  if (value >= 0.9) return 'very formal and professional';
  if (value >= 0.7) return 'formal but not stiff';
  if (value >= 0.5) return 'moderately formal';
  if (value >= 0.3) return 'casual but professional';
  return 'very casual and conversational';
}

function getWarmthDescription(value: number): string {
  if (value >= 0.8) return 'very warm and friendly';
  if (value >= 0.6) return 'moderately warm and approachable';
  if (value >= 0.4) return 'neutral tone';
  if (value >= 0.2) return 'slightly reserved';
  return 'professional and reserved';
}

function getDirectnessDescription(value: number): string {
  if (value >= 0.8) return 'very direct and to-the-point';
  if (value >= 0.6) return 'direct but not abrupt';
  if (value >= 0.4) return 'balanced directness';
  if (value >= 0.2) return 'subtle and indirect';
  return 'very subtle and indirect';
}
