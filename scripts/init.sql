-- PostgreSQL initialization script
-- This runs only on first DB creation

-- Enable useful extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for fuzzy text search

-- Set timezone
SET timezone = 'Europe/Warsaw';
