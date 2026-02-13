import { Request, Response, NextFunction } from 'express';
import { generateSequenceService } from '../services/sequenceService';
import { generateSequenceSchema } from '../utils/validation';
import { ZodError } from 'zod';

export const generateSequenceController = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Validation is handled in service, but we can also validate here for early rejection
    const validatedInput = generateSequenceSchema.parse(req.body);
    const result = await generateSequenceService(validatedInput);
    res.json(result);
  } catch (error) {
    next(error);
  }
};
