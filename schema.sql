CREATE TABLE links(
    id SERIAL PRIMARY KEY,
    short_code VARCHAR(10) UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);

CREATE TABLE clicks(
 id SERIAL PRIMARY KEY,
 link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
 clicked_at TIMESTAMP DEFAULT NOW(),
 user_agent TEXT,
 referrer TEXT
);

