import express from 'express';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { StreamManager } from '../services/streamManager';

const createStreamSchema = Joi.object({
  title: Joi.string().min(1).max(500).required(),
  description: Joi.string().max(2000).optional(),
  metadata: Joi.object().optional()
});

const updateQuizSchema = Joi.object({
  questions: Joi.array().items(
    Joi.object({
      id: Joi.string().optional(),
      text: Joi.string().min(1).max(500).required(),
      options: Joi.array().items(Joi.string().min(1).max(200)).min(2).max(6).required(),
      correctAnswer: Joi.number().integer().min(0).required(),
      explanation: Joi.string().max(1000).optional()
    })
  ).max(10).required()
});

export default function streamRoutes(streamManager: StreamManager) {
  const router = express.Router();

  // Create new stream
  router.post('/', asyncHandler(async (req: AuthRequest, res) => {
    const { error, value } = createStreamSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { title, description, metadata } = value;
    const ingestKey = uuidv4();

    const result = await streamManager.createStream({
      userId: req.user!.id,
      title,
      description,
      ingestKey,
      metadata
    });

    res.status(201).json({
      message: 'Stream created successfully',
      stream: result,
      ingestUrl: `rtmp://localhost:1935/live/${ingestKey}`,
      playbackUrl: `http://localhost:${process.env.PORT || 3001}/hls/${result.id}/index.m3u8`
    });
  }));

  // Start stream
  router.post('/:id/start', asyncHandler(async (req: AuthRequest, res) => {
    const streamId = req.params.id;
    
    const stream = await streamManager.getStream(streamId);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (stream.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await streamManager.startStream(streamId);
    
    res.json({
      message: 'Stream started successfully',
      streamId,
      status: 'live'
    });
  }));

  // Stop stream
  router.post('/:id/stop', asyncHandler(async (req: AuthRequest, res) => {
    const streamId = req.params.id;
    
    const stream = await streamManager.getStream(streamId);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (stream.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await streamManager.stopStream(streamId);
    
    res.json({
      message: 'Stream stopped successfully',
      streamId,
      status: 'ended'
    });
  }));

  // Get all streams for user
  router.get('/', asyncHandler(async (req: AuthRequest, res) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;

    const result = await streamManager.getUserStreams(req.user!.id, limit, offset);
    
    res.json({
      streams: result.streams,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.ceil(result.total / limit)
      }
    });
  }));

  // Get specific stream
  router.get('/:id', asyncHandler(async (req: AuthRequest, res) => {
    const streamId = req.params.id;
    
    const stream = await streamManager.getStream(streamId);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (stream.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ stream });
  }));

  // Update quiz questions for stream/ad
  router.put('/:id/quiz-questions', asyncHandler(async (req: AuthRequest, res) => {
    const streamId = req.params.id;
    const { error, value } = updateQuizSchema.validate(req.body);
    
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { questions } = value;

    // Verify stream ownership
    const stream = await streamManager.getStream(streamId);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (stream.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update quiz questions in metadata
    const updatedMetadata = {
      ...stream.metadata,
      quizQuestions: questions,
      quizEnabled: questions.length > 0,
      quizUpdatedAt: new Date().toISOString()
    };

    await streamManager.updateStreamMetadata(streamId, updatedMetadata);

    res.json({
      message: 'Quiz questions updated successfully',
      streamId,
      questionsCount: questions.length,
      quizEnabled: questions.length > 0
    });
  }));

  // Delete stream
  router.delete('/:id', asyncHandler(async (req: AuthRequest, res) => {
    const streamId = req.params.id;
    
    const stream = await streamManager.getStream(streamId);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (stream.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await streamManager.deleteStream(streamId);
    
    res.json({
      message: 'Stream deleted successfully',
      streamId
    });
  }));

  // Get stream analytics
  router.get('/:id/analytics', asyncHandler(async (req: AuthRequest, res) => {
    const streamId = req.params.id;
    
    const stream = await streamManager.getStream(streamId);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (stream.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const analytics = await streamManager.getStreamAnalytics(streamId);
    
    res.json({ analytics });
  }));

  return router;
}