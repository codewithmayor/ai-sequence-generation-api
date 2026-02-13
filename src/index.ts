import 'dotenv/config';
import express from 'express';
import { errorHandler } from './utils/errorHandler';
import { sequenceRoutes } from './routes/sequenceRoutes';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Root info endpoint for browsers
app.get('/', (req, res) => {
  res.send(
    'AI Sequence Generation API is running. Use GET /health or POST /api/generate-sequence to interact with the service.'
  );
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Routes
app.use('/api', sequenceRoutes);

// Global error handler
app.use(errorHandler);

// Start server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
