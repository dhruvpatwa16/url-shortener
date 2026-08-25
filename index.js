const express = require('express');
const app = express();

const PORT = 3000;

app.get('/', (req, res)=>{
    res.send('URL Shortner is alive');
});

const pool = require('./db');

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('DB connection failed:', err);
  } else {
    console.log('DB connected, server time:', res.rows[0].now);
  }
});
const { nanoid } = require('nanoid');

app.use(express.json());

app.post('/shorten', async (req, res) => {
  const { originalUrl, customAlias } = req.body;

  if (!originalUrl) {
    return res.status(400).json({ error: 'originalUrl is required' });
  }

  try {
    new URL(originalUrl); // throws if not a valid URL
  } catch {
    return res.status(400).json({ error: 'originalUrl must be a valid URL' });
  }

  const shortCode = customAlias || nanoid(7);

  try {
    const result = await pool.query(
      'INSERT INTO links (short_code, original_url) VALUES ($1, $2) RETURNING *',
      [shortCode, originalUrl]
    );

    res.status(201).json({
      shortCode: result.rows[0].short_code,
      shortUrl: `http://localhost:${PORT}/${result.rows[0].short_code}`,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That short code is already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/stats/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const linkResult = await pool.query(
      'SELECT * FROM links WHERE short_code = $1',
      [shortCode]
    );

    if (linkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Short URL not found' });
    }

    const link = linkResult.rows[0];

    const totalClicksResult = await pool.query(
      'SELECT COUNT(*) FROM clicks WHERE link_id = $1',
      [link.id]
    );

    const recentClicksResult = await pool.query(
      'SELECT clicked_at, user_agent, referrer FROM clicks WHERE link_id = $1 ORDER BY clicked_at DESC LIMIT 10',
      [link.id]
    );

    const clicksPerDayResult = await pool.query(
      `SELECT DATE(clicked_at) AS day, COUNT(*) AS count
       FROM clicks
       WHERE link_id = $1
       GROUP BY DATE(clicked_at)
       ORDER BY day DESC
       LIMIT 7`,
      [link.id]
    );

    res.json({
      shortCode: link.short_code,
      originalUrl: link.original_url,
      createdAt: link.created_at,
      totalClicks: parseInt(totalClicksResult.rows[0].count, 10),
      recentClicks: recentClicksResult.rows,
      clicksPerDay: clicksPerDayResult.rows,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM links WHERE short_code = $1',
      [shortCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Short URL not found' });
    }

    const link = result.rows[0];

    res.redirect(302, link.original_url);

    pool.query(
      'INSERT INTO clicks (link_id, user_agent, referrer) VALUES ($1, $2, $3)',
      [link.id, req.headers['user-agent'] || null, req.headers['referer'] || null]
    ).catch(err => console.error('Click logging failed:', err));

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.listen(PORT, ()=>{
    console.log(`Server running on http://localhost:${PORT}`);
});