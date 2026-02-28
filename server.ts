import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { initializeDatabase } from './database/init';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter } from './middleware/rateLimiter';
import streamRoutes from './routes/streams';
import authRoutes from './routes/auth';
import playbackRoutes from './routes/playback';
import trendingRoutes from './routes/trending';
import rtmpRoutes from './routes/rtmp';
import { WebSocketManager } from './services/websocket';
import { StreamManager } from './services/streamManager';
import { TrendingService } from './services/trendingService';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Database connection
export const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/livestream_db',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize services
const wsManager = new WebSocketManager(wss);
const streamManager = new StreamManager(db, wsManager);
const trendingService = new TrendingService(db);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true
}));
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
app.use('/api', rateLimiter);

// Static files for HLS and recordings
app.use('/hls', express.static(process.env.HLS_PATH || './storage/hls'));
app.use('/recordings', express.static(process.env.RECORDINGS_PATH || './storage/recordings'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/streams', authMiddleware, streamRoutes(streamManager));
app.use('/api/trending', trendingRoutes);
app.use('/api/streams/rtmp', rtmpRoutes);
app.use('/play', playbackRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Error handling
app.use(errorHandler);

// Initialize database and start server
const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    await initializeDatabase(db);
    console.log('✅ Database initialized');
    
    // Start trending score calculation job
    setInterval(async () => {
      try {
        await trendingService.batchUpdateTrendingScores();
      } catch (error) {
        console.error('❌ Failed to update trending scores:', error);
      }
    }, 5 * 60 * 1000); // Update every 5 minutes
    
    server.listen(PORT, () => {
      console.log(`🚀 Livestream backend running on port ${PORT}`);
      console.log(`📡 WebSocket server ready`);
      console.log(`🎥 RTMP ingest: rtmp://localhost:1935/live`);
      console.log(`📺 HLS playback: http://localhost:${PORT}/hls`);
      console.log(`🎬 Recordings: http://localhost:${PORT}/recordings`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down gracefully...');
  await streamManager.cleanup();
  await db.end();
  server.close();
  process.exit(0);
});

export { streamManager, wsManager, trendingService };