import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/auth';
import { testDb } from './setup';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);

// Mock the db import
jest.mock('../server', () => ({
  db: testDb
}));

describe('Authentication API', () => {
  describe('POST /auth/register', () => {
    it('should register a new user', async () => {
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      };

      const response = await request(app)
        .post('/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body.message).toBe('User created successfully');
      expect(response.body.user).toHaveProperty('id');
      expect(response.body.user.username).toBe(userData.username);
      expect(response.body.user.email).toBe(userData.email);
      expect(response.body).toHaveProperty('token');
    });

    it('should reject duplicate users', async () => {
      const userData = {
        username: 'duplicateuser',
        email: 'duplicate@example.com',
        password: 'password123'
      };

      // First registration should succeed
      await request(app)
        .post('/auth/register')
        .send(userData)
        .expect(201);

      // Second registration should fail
      await request(app)
        .post('/auth/register')
        .send(userData)
        .expect(409);
    });

    it('should validate input data', async () => {
      const invalidData = {
        username: 'ab', // Too short
        email: 'invalid-email',
        password: '123' // Too short
      };

      await request(app)
        .post('/auth/register')
        .send(invalidData)
        .expect(400);
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      // Create test user
      const userData = {
        username: 'loginuser',
        email: 'login@example.com',
        password: 'password123'
      };

      await request(app)
        .post('/auth/register')
        .send(userData);
    });

    it('should login with valid credentials', async () => {
      const loginData = {
        email: 'login@example.com',
        password: 'password123'
      };

      const response = await request(app)
        .post('/auth/login')
        .send(loginData)
        .expect(200);

      expect(response.body.message).toBe('Login successful');
      expect(response.body.user).toHaveProperty('id');
      expect(response.body).toHaveProperty('token');
    });

    it('should reject invalid credentials', async () => {
      const loginData = {
        email: 'login@example.com',
        password: 'wrongpassword'
      };

      await request(app)
        .post('/auth/login')
        .send(loginData)
        .expect(401);
    });
  });

  describe('GET /auth/verify', () => {
    let validToken: string;

    beforeEach(async () => {
      const userData = {
        username: 'verifyuser',
        email: 'verify@example.com',
        password: 'password123'
      };

      const response = await request(app)
        .post('/auth/register')
        .send(userData);

      validToken = response.body.token;
    });

    it('should verify valid token', async () => {
      const response = await request(app)
        .get('/auth/verify')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body.valid).toBe(true);
      expect(response.body.user).toHaveProperty('id');
    });

    it('should reject invalid token', async () => {
      await request(app)
        .get('/auth/verify')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);
    });

    it('should reject missing token', async () => {
      await request(app)
        .get('/auth/verify')
        .expect(401);
    });
  });
});