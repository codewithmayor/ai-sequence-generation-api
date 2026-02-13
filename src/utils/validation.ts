import { z } from 'zod';

export const generateSequenceSchema = z.object({
  prospect_url: z.string().url('Invalid prospect URL'),
  tov_config: z.object({
    formality: z.number().min(0).max(1),
    warmth: z.number().min(0).max(1),
    directness: z.number().min(0).max(1),
  }),
  company_context: z.string().min(1, 'Company context is required'),
  sequence_length: z.number().int().min(1).max(10),
});

export type GenerateSequenceInput = z.infer<typeof generateSequenceSchema>;
