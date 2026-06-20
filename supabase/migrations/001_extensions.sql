-- Migration 001 — Enable required Postgres extensions.
-- Run once per Supabase project.

create extension if not exists "uuid-ossp";
create extension if not exists vector;
