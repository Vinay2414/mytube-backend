import { Pool } from 'pg';

export async function initializeDatabase(db: Pool) {
  const createTablesQuery = `
    -- Create users table for authentication
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    -- Create streams table for metadata
    CREATE TABLE IF NOT EXISTS streams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      ingest_key VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'created' CHECK (status IN ('created', 'live', 'ended', 'error')),
      start_time TIMESTAMP WITH TIME ZONE,
      end_time TIMESTAMP WITH TIME ZONE,
      duration INTEGER, -- in seconds
      viewer_count INTEGER DEFAULT 0,
      max_viewers INTEGER DEFAULT 0,
      recording_path VARCHAR(1000),
      hls_path VARCHAR(1000),
      thumbnail_path VARCHAR(1000),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    -- Create stream_events table for analytics
    CREATE TABLE IF NOT EXISTS stream_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stream_id UUID REFERENCES streams(id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      event_data JSONB DEFAULT '{}',
      timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams(user_id);
    CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
    CREATE INDEX IF NOT EXISTS idx_streams_created_at ON streams(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stream_events_stream_id ON stream_events(stream_id);
    CREATE INDEX IF NOT EXISTS idx_stream_events_timestamp ON stream_events(timestamp DESC);

    -- Create function to update updated_at timestamp
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ language 'plpgsql';

    -- Create triggers for updated_at
    DROP TRIGGER IF EXISTS update_users_updated_at ON users;
    CREATE TRIGGER update_users_updated_at 
      BEFORE UPDATE ON users 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_streams_updated_at ON streams;
    CREATE TRIGGER update_streams_updated_at 
      BEFORE UPDATE ON streams 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `;

  try {
    await db.query(createTablesQuery);
    console.log('✅ Database tables created/verified');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}