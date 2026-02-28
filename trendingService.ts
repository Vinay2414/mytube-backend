import { Pool } from 'pg';

export interface TrendingMetrics {
  videoId: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  watchTime: number;
  timestamp: string;
}

export class TrendingService {
  private db: Pool;

  constructor(db: Pool) {
    this.db = db;
  }

  // Record view event for trending calculation
  async recordView(videoId: string, userId?: string, watchTime?: number) {
    try {
      // Insert view record
      await this.db.query(
        `INSERT INTO video_views (video_id, user_id, watch_time, timestamp) 
         VALUES ($1, $2, $3, NOW())`,
        [videoId, userId, watchTime || 0]
      );

      // Update video view count
      await this.db.query(
        'UPDATE videos SET views = views + 1, updated_at = NOW() WHERE id = $1',
        [videoId]
      );

      // Update trending metrics
      await this.updateTrendingMetrics(videoId);
      
      console.log(`📈 View recorded for video ${videoId}`);
    } catch (error) {
      console.error('Failed to record view:', error);
    }
  }

  // Update trending metrics for a video
  private async updateTrendingMetrics(videoId: string) {
    const query = `
      WITH video_metrics AS (
        SELECT 
          v.id,
          v.views,
          v.likes,
          v.comments_count,
          v.created_at,
          EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 as age_hours,
          -- Calculate views in last 24 hours
          (
            SELECT COUNT(*) 
            FROM video_views vv 
            WHERE vv.video_id = v.id 
              AND vv.timestamp >= NOW() - INTERVAL '24 hours'
          ) as recent_views,
          -- Calculate average watch time
          (
            SELECT AVG(watch_time) 
            FROM video_views vv 
            WHERE vv.video_id = v.id 
              AND vv.watch_time > 0
          ) as avg_watch_time
        FROM videos v
        WHERE v.id = $1
      )
      INSERT INTO trending_metrics (
        video_id, 
        trending_score, 
        view_velocity, 
        engagement_rate,
        calculated_at
      )
      SELECT 
        id,
        -- Advanced trending score
        (
          (views * (1 + (1 / (age_hours + 1)))) +
          (likes * 10) +
          (comments_count * 15) +
          (recent_views * 20) +
          (COALESCE(avg_watch_time, 0) / 60 * 5) +
          CASE 
            WHEN age_hours < 1 THEN 1000
            WHEN age_hours < 6 THEN 500
            WHEN age_hours < 24 THEN 200
            ELSE 0
          END -
          (age_hours * 2)
        ) as trending_score,
        -- View velocity (views per hour)
        CASE 
          WHEN age_hours > 0 THEN views / age_hours
          ELSE views 
        END as view_velocity,
        -- Engagement rate
        CASE 
          WHEN views > 0 THEN ((likes + comments_count) * 100.0 / views)
          ELSE 0 
        END as engagement_rate,
        NOW()
      FROM video_metrics
      ON CONFLICT (video_id, DATE(calculated_at))
      DO UPDATE SET
        trending_score = EXCLUDED.trending_score,
        view_velocity = EXCLUDED.view_velocity,
        engagement_rate = EXCLUDED.engagement_rate,
        calculated_at = EXCLUDED.calculated_at
    `;

    await this.db.query(query, [videoId]);
  }

  // Get trending videos with caching
  async getTrendingVideos(timeRange: string, category: string, limit: number, offset: number) {
    const cacheKey = `trending:${timeRange}:${category}:${limit}:${offset}`;
    
    // In production, you'd use Redis for caching
    // For now, we'll calculate fresh each time
    
    const timeCutoff = this.getTimeCutoff(timeRange);
    
    let categoryFilter = '';
    let params = [timeCutoff.toISOString(), limit, offset];
    
    if (category !== 'all') {
      categoryFilter = `AND (
        LOWER(v.title) LIKE LOWER($4) OR 
        EXISTS (
          SELECT 1 FROM unnest(v.keywords) AS keyword 
          WHERE LOWER(keyword) LIKE LOWER($4)
        )
      )`;
      params.push(`%${category}%`);
    }

    const query = `
      WITH trending_videos AS (
        SELECT 
          v.*,
          u.username as uploader_username,
          u.avatar as uploader_avatar,
          u.subscribers as uploader_subscribers,
          tm.trending_score,
          tm.view_velocity,
          tm.engagement_rate,
          ROW_NUMBER() OVER (ORDER BY tm.trending_score DESC, v.views DESC) as rank
        FROM videos v
        JOIN users u ON v.uploader_id = u.id
        LEFT JOIN trending_metrics tm ON v.id = tm.video_id 
          AND DATE(tm.calculated_at) = CURRENT_DATE
        WHERE v.created_at >= $1
          AND v.status = 'published'
          ${categoryFilter}
        ORDER BY COALESCE(tm.trending_score, 0) DESC, v.views DESC
        LIMIT $2 OFFSET $3
      )
      SELECT * FROM trending_videos
    `;

    const result = await this.db.query(query, params);
    return result.rows;
  }

  // Get trending statistics
  async getTrendingStats(timeRange: string, category: string) {
    const timeCutoff = this.getTimeCutoff(timeRange);
    
    let categoryFilter = '';
    let params = [timeCutoff.toISOString()];
    
    if (category !== 'all') {
      categoryFilter = `AND (
        LOWER(v.title) LIKE LOWER($2) OR 
        EXISTS (
          SELECT 1 FROM unnest(v.keywords) AS keyword 
          WHERE LOWER(keyword) LIKE LOWER($2)
        )
      )`;
      params.push(`%${category}%`);
    }

    const query = `
      SELECT 
        COUNT(*) as total_videos,
        SUM(v.views) as total_views,
        SUM(v.likes) as total_likes,
        AVG(v.views) as avg_views,
        MAX(v.views) as max_views,
        COUNT(CASE WHEN v.is_short THEN 1 END) as shorts_count,
        COUNT(CASE WHEN NOT v.is_short THEN 1 END) as regular_count
      FROM videos v
      WHERE v.created_at >= $1
        AND v.status = 'published'
        ${categoryFilter}
    `;

    const result = await this.db.query(query, params);
    return result.rows[0];
  }

  private getTimeCutoff(timeRange: string): Date {
    const now = new Date();
    
    switch (timeRange) {
      case 'hour':
        return new Date(now.getTime() - 60 * 60 * 1000);
      case 'today':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case 'week':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case 'month':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case 'year':
        return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      case 'all':
      default:
        return new Date(0);
    }
  }

  // Batch update trending scores (run periodically)
  async batchUpdateTrendingScores() {
    console.log('🔄 Updating trending scores for all videos...');
    
    const query = `
      WITH video_metrics AS (
        SELECT 
          v.id,
          v.views,
          v.likes,
          v.comments_count,
          v.created_at,
          EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 as age_hours,
          (
            SELECT COUNT(*) 
            FROM video_views vv 
            WHERE vv.video_id = v.id 
              AND vv.timestamp >= NOW() - INTERVAL '24 hours'
          ) as recent_views,
          (
            SELECT AVG(watch_time) 
            FROM video_views vv 
            WHERE vv.video_id = v.id 
              AND vv.watch_time > 0
          ) as avg_watch_time
        FROM videos v
        WHERE v.status = 'published'
          AND v.created_at >= NOW() - INTERVAL '30 days'
      )
      INSERT INTO trending_metrics (
        video_id, 
        trending_score, 
        view_velocity, 
        engagement_rate,
        calculated_at
      )
      SELECT 
        id,
        (
          (views * (1 + (1 / (age_hours + 1)))) +
          (likes * 10) +
          (comments_count * 15) +
          (recent_views * 20) +
          (COALESCE(avg_watch_time, 0) / 60 * 5) +
          CASE 
            WHEN age_hours < 1 THEN 1000
            WHEN age_hours < 6 THEN 500
            WHEN age_hours < 24 THEN 200
            ELSE 0
          END -
          (age_hours * 2)
        ) as trending_score,
        CASE 
          WHEN age_hours > 0 THEN views / age_hours
          ELSE views 
        END as view_velocity,
        CASE 
          WHEN views > 0 THEN ((likes + comments_count) * 100.0 / views)
          ELSE 0 
        END as engagement_rate,
        NOW()
      FROM video_metrics
      ON CONFLICT (video_id, DATE(calculated_at))
      DO UPDATE SET
        trending_score = EXCLUDED.trending_score,
        view_velocity = EXCLUDED.view_velocity,
        engagement_rate = EXCLUDED.engagement_rate,
        calculated_at = EXCLUDED.calculated_at
    `;

    const result = await this.db.query(query);
    console.log(`✅ Updated trending scores for videos`);
    
    return result.rowCount;
  }
}