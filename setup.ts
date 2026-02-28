import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

// Test database connection
export const testDb = new Pool({
  connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres:password@localhost:5432/livestream_test_db'
});

// Setup and teardown for tests
beforeAll(async () => {
  // Create test tables
  await testDb.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS streams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      title VARCHAR(500) NOT NULL,
      description TEXT,
      ingest_key VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'created',
      start_time TIMESTAMP WITH TIME ZONE,
      end_time TIMESTAMP WITH TIME ZONE,
      duration INTEGER,
      viewer_count INTEGER DEFAULT 0,
      max_viewers INTEGER DEFAULT 0,
      recording_path VARCHAR(1000),
      hls_path VARCHAR(1000),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
});

afterAll(async () => {
  // Clean up test data
  await testDb.query('DROP TABLE IF EXISTS streams CASCADE');
  await testDb.query('DROP TABLE IF EXISTS users CASCADE');
  await testDb.end();
});

afterEach(async () => {
  // Clean up after each test
  await testDb.query('DELETE FROM streams');
  await testDb.query('DELETE FROM users');
});