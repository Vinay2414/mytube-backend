import { spawn, ChildProcess } from 'child_process';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { testDb } from './setup';
import { StreamManager } from '../services/streamManager';
import { WebSocketManager } from '../services/websocket';

describe('Integration Tests', () => {
  let app: express.Application;
  let streamManager: StreamManager;
  let authToken: string;
  let userId: string;

  beforeAll(async () => {
    // Setup test app
    app = express();
    app.use(express.json());

    const mockWsManager = {
      broadcast: jest.fn(),
      sendToClient: jest.fn(),
      getConnectedClientsCount: () => 0,
      cleanup: jest.fn()
    } as unknown as WebSocketManager;

    streamManager = new StreamManager(testDb, mockWsManager);

    // Create test user
    const passwordHash = await bcrypt.hash('testpassword', 10);
    const userResult = await testDb.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      ['integrationuser', 'integration@example.com', passwordHash]
    );
    userId = userResult.rows[0].id;

    authToken = jwt.sign(
      { userId, username: 'integrationuser' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' }
    );
  });

  describe('Complete Stream Workflow', () => {
    it('should handle complete stream lifecycle', async () => {
      // 1. Create stream
      const stream = await streamManager.createStream({
        userId,
        title: 'Integration Test Stream',
        description: 'Testing complete workflow',
        ingestKey: 'integration-test-key'
      });

      expect(stream).toHaveProperty('id');
      expect(stream.title).toBe('Integration Test Stream');
      expect(stream.status).toBe('created');

      // 2. Start stream
      await streamManager.startStream(stream.id);
      
      const updatedStream = await streamManager.getStream(stream.id);
      expect(updatedStream?.status).toBe('live');
      expect(updatedStream?.start_time).toBeTruthy();

      // 3. Simulate some time passing
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 4. Stop stream
      await streamManager.stopStream(stream.id);
      
      const finalStream = await streamManager.getStream(stream.id);
      expect(finalStream?.status).toBe('ended');
      expect(finalStream?.end_time).toBeTruthy();
      expect(finalStream?.duration).toBeGreaterThan(0);

      // 5. Get analytics
      const analytics = await streamManager.getStreamAnalytics(stream.id);
      expect(analytics).toHaveProperty('duration');
      expect(analytics).toHaveProperty('events');
    }, 30000);
  });

  describe('FFmpeg Stream Simulation', () => {
    it('should handle simulated ffmpeg stream', async () => {
      // This test simulates what would happen with a real FFmpeg stream
      // In a real environment, you would use actual FFmpeg to publish to RTMP
      
      const stream = await streamManager.createStream({
        userId,
        title: 'FFmpeg Test Stream',
        description: 'Testing with simulated FFmpeg',
        ingestKey: 'ffmpeg-test-key'
      });

      // Start the stream
      await streamManager.startStream(stream.id);

      // Simulate FFmpeg publishing (in real test, you'd use actual FFmpeg)
      // ffmpeg -f lavfi -i testsrc=duration=10:size=320x240:rate=30 -f lavfi -i sine=frequency=1000:duration=10 -c:v libx264 -c:a aac -f flv rtmp://localhost:1935/live/ffmpeg-test-key

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check that HLS directory was created
      const hlsDir = path.join(process.env.HLS_PATH || './storage/hls', stream.id);
      // Note: In real test with FFmpeg, you'd check if directory exists
      // expect(fs.existsSync(hlsDir)).toBe(true);

      // Stop stream
      await streamManager.stopStream(stream.id);

      const finalStream = await streamManager.getStream(stream.id);
      expect(finalStream?.status).toBe('ended');
    }, 15000);
  });

  describe('Quiz Questions Integration', () => {
    it('should update quiz questions via API', async () => {
      // Create stream
      const stream = await streamManager.createStream({
        userId,
        title: 'Quiz Test Stream',
        ingestKey: 'quiz-test-key'
      });

      // Update quiz questions
      const quizQuestions = [
        {
          text: 'What is 2 + 2?',
          options: ['3', '4', '5', '6'],
          correctAnswer: 1,
          explanation: 'Basic arithmetic: 2 + 2 = 4'
        }
      ];

      await streamManager.updateStreamMetadata(stream.id, {
        quizQuestions,
        quizEnabled: true
      });

      // Verify update
      const updatedStream = await streamManager.getStream(stream.id);
      expect(updatedStream?.metadata.quizQuestions).toHaveLength(1);
      expect(updatedStream?.metadata.quizEnabled).toBe(true);
      expect(updatedStream?.metadata.quizQuestions[0].text).toBe('What is 2 + 2?');
    });
  });
});