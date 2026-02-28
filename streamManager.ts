import { Pool } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WebSocketManager } from './websocket';
import { StorageService } from './storage';

export interface StreamData {
  id?: string;
  userId: string;
  title: string;
  description?: string;
  ingestKey: string;
  metadata?: any;
}

export interface Stream {
  id: string;
  user_id: string;
  title: string;
  description?: string;
  ingest_key: string;
  status: string;
  start_time?: string;
  end_time?: string;
  duration?: number;
  viewer_count: number;
  max_viewers: number;
  recording_path?: string;
  hls_path?: string;
  thumbnail_path?: string;
  metadata: any;
  created_at: string;
  updated_at: string;
}

export class StreamManager {
  private db: Pool;
  private wsManager: WebSocketManager;
  private storageService: StorageService;
  private activeStreams: Map<string, ChildProcess> = new Map();
  private recordingProcesses: Map<string, ChildProcess> = new Map();

  constructor(db: Pool, wsManager: WebSocketManager) {
    this.db = db;
    this.wsManager = wsManager;
    this.storageService = new StorageService();
    
    // Ensure storage directories exist
    this.ensureDirectories();
  }

  private ensureDirectories() {
    const dirs = [
      process.env.HLS_PATH || './storage/hls',
      process.env.RECORDINGS_PATH || './storage/recordings',
      process.env.THUMBNAILS_PATH || './storage/thumbnails'
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
      }
    });
  }

  async createStream(streamData: StreamData): Promise<Stream> {
    const result = await this.db.query(
      `INSERT INTO streams (user_id, title, description, ingest_key, metadata) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [
        streamData.userId,
        streamData.title,
        streamData.description,
        streamData.ingestKey,
        JSON.stringify(streamData.metadata || {})
      ]
    );

    const stream = result.rows[0];
    console.log(`✅ Stream created: ${stream.id} - ${stream.title}`);
    
    return stream;
  }

  async startStream(streamId: string): Promise<void> {
    const stream = await this.getStream(streamId);
    if (!stream) {
      throw new Error('Stream not found');
    }

    if (stream.status === 'live') {
      throw new Error('Stream is already live');
    }

    // Update stream status
    await this.db.query(
      'UPDATE streams SET status = $1, start_time = NOW() WHERE id = $2',
      ['live', streamId]
    );

    // Start recording and HLS generation
    await this.startRecording(stream);

    // Log event
    await this.logStreamEvent(streamId, 'stream_started', {
      title: stream.title,
      ingest_key: stream.ingest_key
    });

    // Notify via WebSocket
    this.wsManager.broadcast('stream_started', {
      streamId,
      title: stream.title,
      status: 'live'
    });

    console.log(`🔴 Stream started: ${streamId}`);
  }

  async stopStream(streamId: string): Promise<void> {
    const stream = await this.getStream(streamId);
    if (!stream) {
      throw new Error('Stream not found');
    }

    // Stop recording processes
    await this.stopRecording(streamId);

    // Calculate duration
    const duration = stream.start_time 
      ? Math.floor((Date.now() - new Date(stream.start_time).getTime()) / 1000)
      : 0;

    // Update stream status
    await this.db.query(
      'UPDATE streams SET status = $1, end_time = NOW(), duration = $2 WHERE id = $3',
      ['ended', duration, streamId]
    );

    // Upload to cloud storage if configured
    if (stream.recording_path && (process.env.S3_BUCKET || process.env.MINIO_ENDPOINT)) {
      try {
        await this.storageService.uploadRecording(stream.recording_path, streamId);
        console.log(`☁️ Recording uploaded to cloud storage: ${streamId}`);
      } catch (error) {
        console.error(`❌ Failed to upload recording: ${error}`);
      }
    }

    // Log event
    await this.logStreamEvent(streamId, 'stream_ended', {
      duration,
      max_viewers: stream.max_viewers
    });

    // Notify via WebSocket
    this.wsManager.broadcast('stream_ended', {
      streamId,
      duration,
      status: 'ended'
    });

    console.log(`⏹️ Stream stopped: ${streamId} (${duration}s)`);
  }

  private async startRecording(stream: Stream): Promise<void> {
    const streamId = stream.id;
    const hlsDir = path.join(process.env.HLS_PATH || './storage/hls', streamId);
    const recordingPath = path.join(
      process.env.RECORDINGS_PATH || './storage/recordings',
      `${streamId}.mp4`
    );

    // Ensure HLS directory exists
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }

    // FFmpeg command for recording and HLS generation
    const ffmpegArgs = [
      '-i', `rtmp://localhost:1935/live/${stream.ingest_key}`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', 'veryfast',
      '-g', '50',
      '-sc_threshold', '0',
      
      // HLS output
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list',
      path.join(hlsDir, 'index.m3u8'),
      
      // MP4 recording
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'mp4',
      recordingPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    
    ffmpeg.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });

    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });

    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg process exited with code ${code}`);
      this.recordingProcesses.delete(streamId);
    });

    ffmpeg.on('error', (error) => {
      console.error(`FFmpeg error: ${error}`);
      this.recordingProcesses.delete(streamId);
    });

    this.recordingProcesses.set(streamId, ffmpeg);

    // Update database with file paths
    await this.db.query(
      'UPDATE streams SET recording_path = $1, hls_path = $2 WHERE id = $3',
      [recordingPath, path.join(hlsDir, 'index.m3u8'), streamId]
    );

    console.log(`🎬 Recording started for stream: ${streamId}`);
  }

  private async stopRecording(streamId: string): Promise<void> {
    const process = this.recordingProcesses.get(streamId);
    if (process) {
      process.kill('SIGTERM');
      this.recordingProcesses.delete(streamId);
      console.log(`⏹️ Recording stopped for stream: ${streamId}`);
    }
  }

  async getStream(streamId: string): Promise<Stream | null> {
    const result = await this.db.query(
      'SELECT * FROM streams WHERE id = $1',
      [streamId]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async getUserStreams(userId: string, limit: number = 20, offset: number = 0): Promise<{streams: Stream[], total: number}> {
    const [streamsResult, countResult] = await Promise.all([
      this.db.query(
        'SELECT * FROM streams WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [userId, limit, offset]
      ),
      this.db.query(
        'SELECT COUNT(*) FROM streams WHERE user_id = $1',
        [userId]
      )
    ]);

    return {
      streams: streamsResult.rows,
      total: parseInt(countResult.rows[0].count)
    };
  }

  async updateStreamMetadata(streamId: string, metadata: any): Promise<void> {
    await this.db.query(
      'UPDATE streams SET metadata = $1 WHERE id = $2',
      [JSON.stringify(metadata), streamId]
    );
  }

  async deleteStream(streamId: string): Promise<void> {
    const stream = await this.getStream(streamId);
    if (!stream) {
      throw new Error('Stream not found');
    }

    // Stop recording if active
    await this.stopRecording(streamId);

    // Delete files
    if (stream.recording_path && fs.existsSync(stream.recording_path)) {
      fs.unlinkSync(stream.recording_path);
    }

    if (stream.hls_path) {
      const hlsDir = path.dirname(stream.hls_path);
      if (fs.existsSync(hlsDir)) {
        fs.rmSync(hlsDir, { recursive: true, force: true });
      }
    }

    // Delete from database
    await this.db.query('DELETE FROM streams WHERE id = $1', [streamId]);
    
    console.log(`🗑️ Stream deleted: ${streamId}`);
  }

  async getStreamAnalytics(streamId: string): Promise<any> {
    const [eventsResult, streamResult] = await Promise.all([
      this.db.query(
        'SELECT event_type, COUNT(*) as count FROM stream_events WHERE stream_id = $1 GROUP BY event_type',
        [streamId]
      ),
      this.db.query(
        'SELECT duration, max_viewers, viewer_count FROM streams WHERE id = $1',
        [streamId]
      )
    ]);

    const events = eventsResult.rows.reduce((acc, row) => {
      acc[row.event_type] = parseInt(row.count);
      return acc;
    }, {});

    const stream = streamResult.rows[0];

    return {
      duration: stream?.duration || 0,
      maxViewers: stream?.max_viewers || 0,
      currentViewers: stream?.viewer_count || 0,
      events
    };
  }

  private async logStreamEvent(streamId: string, eventType: string, eventData: any): Promise<void> {
    await this.db.query(
      'INSERT INTO stream_events (stream_id, event_type, event_data) VALUES ($1, $2, $3)',
      [streamId, eventType, JSON.stringify(eventData)]
    );
  }

  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up stream manager...');
    
    // Stop all active recordings
    for (const [streamId, process] of this.recordingProcesses) {
      console.log(`⏹️ Stopping recording for stream: ${streamId}`);
      process.kill('SIGTERM');
    }
    
    this.recordingProcesses.clear();
    this.activeStreams.clear();
  }
}