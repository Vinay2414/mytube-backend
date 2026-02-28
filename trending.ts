import express from 'express';
import { db } from '../server';
import { asyncHandler } from '../middleware/errorHandler';
import { optionalAuth, AuthRequest } from '../middleware/auth';

const router = express.Router();

interface TrendingVideo {
  id: string;
  title: string;
  description: string;
  thumbnail_url: string;
  video_url: string;
  duration: number;
  views: number;
  likes: number;
  dislikes: number;
  is_short: boolean;
  created_at: string;
  keywords: string[];
  uploader: {
    id: string;
    username: string;
    avatar: string;
    subscribers: number;
  };
  trending_score: number;
  view_velocity: number;
  engagement_rate: number;
}

// Get trending videos with advanced algorithm
router.get('/', optionalAuth, asyncHandler(async (req: AuthRequest, res) => {
  const timeRange = req.query.time_range as string || 'week';
  const category = req.query.category as string || 'all';
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  // Calculate time cutoff based on range
  const now = new Date();
  let timeCutoff: Date;
  
  switch (timeRange) {
    case 'hour':
      timeCutoff = new Date(now.getTime() - 60 * 60 * 1000);
      break;
    case 'today':
      timeCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case 'week':
      timeCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      timeCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'year':
      timeCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case 'all':
    default:
      timeCutoff = new Date(0);
      break;
  }

  // Advanced trending algorithm query
  let categoryFilter = '';
  if (category !== 'all') {
    categoryFilter = `AND (
      LOWER(v.title) LIKE LOWER($3) OR 
      EXISTS (
        SELECT 1 FROM unnest(v.keywords) AS keyword 
        WHERE LOWER(keyword) LIKE LOWER($3)
      )
    )`;
  }

  const query = `
    WITH video_stats AS (
      SELECT 
        v.*,
        u.username as uploader_username,
        u.avatar as uploader_avatar,
        u.subscribers as uploader_subscribers,
        -- Calculate age in hours
        EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 as age_hours,
        -- Calculate view velocity (views per hour)
        CASE 
          WHEN EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 > 0 
          THEN v.views / (EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600)
          ELSE v.views 
        END as view_velocity,
        -- Calculate engagement rate
        CASE 
          WHEN v.views > 0 
          THEN ((v.likes + v.comments_count) * 100.0 / v.views)
          ELSE 0 
        END as engagement_rate
      FROM videos v
      JOIN users u ON v.uploader_id = u.id
      WHERE v.created_at >= $1
        AND v.status = 'published'
        ${categoryFilter}
    ),
    trending_scores AS (
      SELECT *,
        -- Advanced trending score algorithm
        (
          -- Base score from views with recency boost
          (views * (1 + (1 / (age_hours + 1)))) +
          -- Engagement boost
          (likes * 10) +
          (comments_count * 15) +
          -- View velocity boost (trending up)
          (view_velocity * 5) +
          -- Engagement rate boost
          (engagement_rate * 20) +
          -- Recency bonus for new content
          CASE 
            WHEN age_hours < 1 THEN 1000
            WHEN age_hours < 6 THEN 500
            WHEN age_hours < 24 THEN 200
            ELSE 0
          END -
          -- Age penalty (diminishing returns)
          (age_hours * 2)
        ) as trending_score
      FROM video_stats
    )
    SELECT 
      id,
      title,
      description,
      thumbnail_url,
      video_url,
      duration,
      views,
      likes,
      dislikes,
      is_short,
      created_at,
      keywords,
      uploader_username,
      uploader_avatar,
      uploader_subscribers,
      trending_score,
      view_velocity,
      engagement_rate,
      age_hours
    FROM trending_scores
    WHERE trending_score > 0
    ORDER BY trending_score DESC, views DESC
    LIMIT $2 OFFSET ${offset}
  `;

  const params = category === 'all' 
    ? [timeCutoff.toISOString(), limit]
    : [timeCutoff.toISOString(), limit, `%${category}%`];

  const result = await db.query(query, params);

  // Transform results to match frontend format
  const trendingVideos: TrendingVideo[] = result.rows.map((row, index) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    thumbnail_url: row.thumbnail_url,
    video_url: row.video_url,
    duration: row.duration,
    views: row.views,
    likes: row.likes,
    dislikes: row.dislikes,
    is_short: row.is_short,
    created_at: row.created_at,
    keywords: row.keywords || [],
    uploader: {
      id: row.uploader_id,
      username: row.uploader_username,
      avatar: row.uploader_avatar,
      subscribers: row.uploader_subscribers || 0
    },
    trending_score: Math.round(row.trending_score),
    view_velocity: Math.round(row.view_velocity * 100) / 100,
    engagement_rate: Math.round(row.engagement_rate * 100) / 100,
    rank: index + 1 + offset
  }));

  // Get trending statistics
  const statsQuery = `
    SELECT 
      COUNT(*) as total_trending,
      SUM(views) as total_views,
      SUM(likes) as total_likes,
      AVG(views) as avg_views,
      MAX(views) as max_views
    FROM videos v
    WHERE v.created_at >= $1 AND v.status = 'published'
  `;

  const statsResult = await db.query(statsQuery, [timeCutoff.toISOString()]);
  const stats = statsResult.rows[0];

  res.json({
    videos: trendingVideos,
    pagination: {
      limit,
      offset,
      total: parseInt(stats.total_trending),
      hasMore: trendingVideos.length === limit
    },
    timeRange,
    category,
    statistics: {
      totalTrending: parseInt(stats.total_trending),
      totalViews: parseInt(stats.total_views || 0),
      totalLikes: parseInt(stats.total_likes || 0),
      averageViews: Math.round(parseFloat(stats.avg_views || 0)),
      maxViews: parseInt(stats.max_views || 0)
    },
    algorithm: {
      description: 'Advanced trending algorithm considering views, engagement, velocity, and recency',
      factors: [
        'View count with recency multiplier',
        'Engagement rate (likes + comments / views)',
        'View velocity (views per hour)',
        'Recency bonus for new content',
        'Age penalty for older content'
      ]
    }
  });
}));

// Get trending categories
router.get('/categories', asyncHandler(async (req, res) => {
  const query = `
    SELECT 
      UNNEST(keywords) as category,
      COUNT(*) as video_count,
      SUM(views) as total_views
    FROM videos 
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND status = 'published'
      AND keywords IS NOT NULL
    GROUP BY UNNEST(keywords)
    HAVING COUNT(*) >= 3
    ORDER BY total_views DESC
    LIMIT 20
  `;

  const result = await db.query(query);
  
  res.json({
    categories: result.rows.map(row => ({
      name: row.category,
      videoCount: parseInt(row.video_count),
      totalViews: parseInt(row.total_views),
      displayName: row.category.charAt(0).toUpperCase() + row.category.slice(1)
    }))
  });
}));

// Get trending insights for a specific video
router.get('/insights/:videoId', optionalAuth, asyncHandler(async (req: AuthRequest, res) => {
  const { videoId } = req.params;

  const query = `
    SELECT 
      v.*,
      u.username as uploader_username,
      u.avatar as uploader_avatar,
      EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 as age_hours,
      CASE 
        WHEN EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 > 0 
        THEN v.views / (EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600)
        ELSE v.views 
      END as view_velocity,
      CASE 
        WHEN v.views > 0 
        THEN ((v.likes + v.comments_count) * 100.0 / v.views)
        ELSE 0 
      END as engagement_rate
    FROM videos v
    JOIN users u ON v.uploader_id = u.id
    WHERE v.id = $1
  `;

  const result = await db.query(query, [videoId]);
  
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const video = result.rows[0];
  
  // Calculate trending potential
  const trendingScore = (
    (video.views * (1 + (1 / (video.age_hours + 1)))) +
    (video.likes * 10) +
    (video.comments_count * 15) +
    (video.view_velocity * 5) +
    (video.engagement_rate * 20)
  );

  res.json({
    video: {
      id: video.id,
      title: video.title,
      views: video.views,
      likes: video.likes,
      ageHours: Math.round(video.age_hours * 100) / 100,
      viewVelocity: Math.round(video.view_velocity * 100) / 100,
      engagementRate: Math.round(video.engagement_rate * 100) / 100,
      trendingScore: Math.round(trendingScore),
      trendingPotential: trendingScore > 1000 ? 'High' : trendingScore > 500 ? 'Medium' : 'Low'
    },
    insights: {
      isNewContent: video.age_hours < 24,
      isViralCandidate: video.view_velocity > 100,
      hasHighEngagement: video.engagement_rate > 5,
      recommendedActions: [
        video.view_velocity > 50 ? 'Promote on social media' : null,
        video.engagement_rate < 2 ? 'Improve thumbnail and title' : null,
        video.age_hours < 6 ? 'Share with your community' : null
      ].filter(Boolean)
    }
  });
}));

export default router;