import { Router } from 'express';
import { generateSequenceController } from '../controllers/sequenceController';

export const sequenceRoutes = Router();

sequenceRoutes.post('/generate-sequence', generateSequenceController);
