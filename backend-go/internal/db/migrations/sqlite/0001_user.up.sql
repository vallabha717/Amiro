CREATE TABLE "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT false,
    password TEXT,
    image TEXT,
    preferences TEXT DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    banned BOOLEAN,
    ban_reason TEXT,
    ban_expires TIMESTAMP,
    role TEXT NOT NULL DEFAULT 'user'
);
