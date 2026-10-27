CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

COMMENT ON DATABASE astian_maps IS
  'Astian Maps account sync and privacy-preserving community traffic aggregates';
