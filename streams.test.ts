import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { testDb } from './setup';
import streamRoutes from '../routes/streams';
import { authMiddleware } from '../middleware/auth';
import { StreamManager } from '../services/streamManager';
import { WebSocketManager } from '../services/websocket';

const app = express();
app.use(express.json());

// Mock WebSocket manager for tests
const mockWsManager = {
  broadcast: jest.fn(),
  sendToClient: jest.fn(),
  getConnectedClientsCount: () => 0,
  cleanup: jest.fn()
} as unknown as WebSocketManager;

const streamManager = new StreamManager(testDb, mockWsManager);
app.use('/api/streams', authMiddleware, streamRoutes(streamManager));

describe('Stream API', () => {
  let authToken: string;
  let userId: string;

  beforeEach(async () => {
    // Create test user
    const passwordHash = await bcrypt.hash('testpassword', 10);
    const userResult = await testDb.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      ['testuser', 'test@example.com', passwordHash]
    );
    userId = userResult.rows[0].id;

    // Generate auth token
    authToken = jwt.sign(
      { userId, username: 'testuser' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' }
    );
  });

  describe('POST /api/streams', () => {
    it('should create a new stream', async () => {
      const streamData = {
        title: 'Test Stream',
        description: 'A test livestream',
        metadata: { category: 'gaming' }
      };

      const response = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${authToken}`)
        .send(streamData)
        .expect(201);

      expect(response.body.message).toBe('Stream created successfully');
      expect(response.body.stream).toHaveProperty('id');
      expect(response.body.stream.title).toBe(streamData.title);
      expect(response.body).toHaveProperty('ingestUrl');
      expect(response.body).toHaveProperty('playbackUrl');
    });

    it('should reject invalid stream data', async () => {
      const invalidData = {
        title: '', // Empty title
        description: 'A test stream'
      };

      await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invalidData)
        .expect(400);
    });

    it('should reject unauthenticated requests', async () => {
      const streamData = {
        title: 'Test Stream',
        description: 'A test livestream'
      };

      await request(app)
        .post('/api/streams')
        .send(streamData)
        .expect(401);
    });
  });

  describe('PUT /api/streams/:id/quiz-questions', () => {
    let streamId: string;

    beforeEach(async () => {
      // Create a test stream
      const stream = await streamManager.createStream({
        userId,
        title: 'Test Stream',
        description: 'Test description',
        ingestKey: 'test-key-123'
      });
      streamId = stream.id;
    });

    it('should update quiz questions successfully', async () => {
      const quizData = {
        questions: [
          {
            text: 'What is the capital of France?',
            options: ['London', 'Berlin', 'Paris', 'Madrid'],
            correctAnswer: 2,
            explanation: 'Paris is the capital and largest city of France.'
          },
          {
            text: 'Which planet is closest to the Sun?',
            options: ['Venus', 'Mercury', 'Earth'],
            correctAnswer: 1
          }
        ]
      };

      const response = await request(app)
        .put(`/api/streams/${streamId}/quiz-questions`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(quizData)
        .expect(200);

      expect(response.body.message).toBe('Quiz questions updated successfully');
      expect(response.body.questionsCount).toBe(2);
      expect(response.body.quizEnabled).toBe(true);
    });

    it('should reject invalid quiz questions', async () => {
      const invalidQuizData = {
        questions: [
          {
            text: 'Invalid question',
            options: ['Only one option'], // Too few options
            correctAnswer: 0
          }
        ]
      };

      await request(app)
        .put(`/api/streams/${streamId}/quiz-questions`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(invalidQuizData)
        .expect(400);
    });

    it('should reject access to other users streams', async () => {
      // Create another user
      const otherPasswordHash = await bcrypt.hash('otherpassword', 10);
      const otherUserResult = await testDb.query(
        'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
        ['otheruser', 'other@example.com', otherPasswordHash]
      );
      const otherUserId = otherUserResult.rows[0].id;

      const otherAuthToken = jwt.sign(
        { userId: otherUserId, username: 'otheruser' },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '1h' }
      );

      const quizData = {
        questions: [
          {
            text: 'Test question',
            options: ['A', 'B', 'C'],
            correctAnswer: 0
          }
        ]
      };

      await request(app)
        .put(`/api/streams/${streamId}/quiz-questions`)
        .set('Authorization', `Bearer ${otherAuthToken}`)
        .send(quizData)
        .expect(403);
    });
  });

  describe('GET /api/streams', () => {
    it('should return user streams', async () => {
      // Create test streams
      await streamManager.createStream({
        userId,
        title: 'Stream 1',
        ingestKey: 'key1'
      });
      
      await streamManager.createStream({
        userId,
        title: 'Stream 2',
        ingestKey: 'key2'
      });

      const response = await request(app)
        .get('/api/streams')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.streams).toHaveLength(2);
      expect(response.body.pagination).toHaveProperty('total', 2);
    });
  });
});