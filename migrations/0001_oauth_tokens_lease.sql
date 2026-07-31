-- ===========================================================================
-- 0001_oauth_tokens_lease.sql
-- Tabla de tokens OAuth de Mercado Libre + columnas de lease para el refresh
-- SERIALIZADO cross-proceso (modo standalone con Supabase, ver src/auth.ts).
--
-- En producción esta tabla normalmente la crea/owna n8n (que hace el refresh).
-- Este archivo es IDEMPOTENTE: crea la tabla si no existe y agrega las columnas
-- de lease si faltan, sin pisar datos.
--
-- CÓMO APLICARLA (una sola vez, contra la DB de Supabase del proyecto):
--   - Supabase SQL editor: pegar este archivo y ejecutar.
--   - psql:  psql "$SUPABASE_DB_URL" -f migrations/0001_oauth_tokens_lease.sql
--   - CLI:   supabase db execute --file migrations/0001_oauth_tokens_lease.sql
--   Requiere una conexión con rol service_role / owner (bypassa RLS). Si la tabla
--   ya existe (creada por n8n), solo agrega las 2 columnas de lease.
--
-- SIN esta migración: el modo standalone auto-refresh SIGUE funcionando con el
-- single-flight in-process (una sola promesa de refresh por proceso). El lease CAS
-- es la mejora que además serializa el refresh ENTRE procesos (varias réplicas).
--
-- SEGURIDAD (regla TRAID): oauth_tokens NO tiene tenant_id ⇒ es service_role-only.
-- Se habilita RLS y NO se crea ninguna policy permisiva: con RLS activo y sin
-- policy, ningún rol anon/authenticated puede leer ni escribir; solo service_role
-- (que bypassea RLS) accede. Esto previene la clase CVE-2025-48757 (tabla con
-- secretos expuesta por falta de RLS).
-- rls-skip: tabla sin tenant_id, service_role-only (ENABLE RLS sin policy a propósito).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_label       text PRIMARY KEY,
  access_token        text,
  refresh_token       text,
  expires_at          timestamptz,
  -- Lease CAS para serializar el refresh entre procesos (no se usa pg_advisory_lock:
  -- PostgREST poolea conexiones y el advisory lock no sobrevive el pooling).
  refresh_in_progress boolean      NOT NULL DEFAULT false,
  locked_until        timestamptz,
  updated_at          timestamptz  NOT NULL DEFAULT now()
);

-- Columnas de lease para tablas oauth_tokens preexistentes (creadas por n8n).
ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS refresh_in_progress boolean NOT NULL DEFAULT false;
ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- RLS: habilitado, sin policy ⇒ solo service_role (bypass) accede.
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens FORCE ROW LEVEL SECURITY;
