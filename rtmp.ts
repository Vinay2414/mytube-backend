import express from 'express';
import { db } from '../server';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

// RTMP publish callback
router.post('/publish', asyncHandler(async (req, res) => {
  const { name: ingestKey } = req.body;
  
  console.log(`📡 RTMP publish started: ${ingestKey}`);
  
  // Find stream by ingest key
  const result = await db.query(
    'SELECT id FROM streams WHERE ingest_key = $1',
    [ingestKey]
  );

  if (result.rows.length === 0) {
    console.log(`❌ Invalid ingest key: ${ingestKey}`);
    return res.status(403).send('Invalid ingest key');
  }

  const streamId = result.rows[0].id;
  
  // Update stream status to live
  await db.query(
    'UPDATE streams SET status = $1, start_time = NOW() WHERE id = $2',
    ['live', streamId]
  );

  // Log event
  await db.query(
    'INSERT INTO stream_events (stream_id, event_type, event_data) VALUES ($1, $2, $3)',
    [streamId, 'rtmp_publish_started', JSON.stringify({ ingestKey })]
  );

  console.log(`✅ Stream ${streamId} is now live`);
  res.status(200).send('OK');
}));

// RTMP unpublish callback
router.post('/unpublish', asyncHandler(async (req, res) => {
  const { name: ingestKey } = req.body;
  
  console.log(`📡 RTMP publish stopped: ${ingestKey}`);
  
  // Find stream by ingest key
  const result = await db.query(
    'SELECT id, start_time FROM streams WHERE ingest_key = $1',
    [ingestKey]
  );

  if (result.rows.length > 0) {
    const stream = result.rows[0];
    const duration = stream.start_time 
      ? Math.floor((Date.now() - new Date(stream.start_time).getTime()) / 1000)
      : 0;

    // Update stream status
    await db.query(
      'UPDATE streams SET status = $1, end_time = NOW(), duration = $2 WHERE id = $3',
      ['ended', duration, stream.id]
    );

    // Log event
    await db.query(
      'INSERT INTO stream_events (stream_id, event_type, event_data) VALUES ($1, $2, $3)',
      [stream.id, 'rtmp_publish_stopped', JSON.stringify({ ingestKey, duration })]
    );

    console.log(`⏹️ Stream ${stream.id} ended (${duration}s)`);
  }

  res.status(200).send('OK');
}));

export default router;