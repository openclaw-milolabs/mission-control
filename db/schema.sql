create extension if not exists pgcrypto;

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  email text,
  name text,
  avatar_url text,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists app_settings (
  id integer primary key default 1,
  gateway_token text not null default '',
  setup_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_settings_single_row check (id = 1)
);

insert into app_settings (id, gateway_token, setup_completed)
values (1, '', false)
on conflict (id) do nothing;

create table if not exists boards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists columns (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards(id) on delete cascade,
  title text not null,
  color_key text not null default 'slate',
  is_default boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  board_id uuid not null references boards(id) on delete cascade,
  column_id uuid not null references columns(id) on delete cascade,
  title text not null,
  description text,
  priority text not null default 'low',
  due_date date,
  tags text[] not null default '{}'::text[],
  assignee_ids text[] not null default '{}'::text[],
  assigned_agent_id text not null default '',
  auto_approve boolean not null default false,
  scheduled_for timestamptz,
  execution_state text not null default 'pending',
  execution_mode text not null default 'auto',
  lifecycle_status text not null default 'open',
  plan_text text,
  plan_approved boolean not null default false,
  checklist_done integer not null default 0,
  checklist_total integer not null default 0,
  comments_count integer not null default 0,
  attachments_count integer not null default 0,
  position integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tickets alter column assignee_ids type text[] using assignee_ids::text[];
alter table tickets add column if not exists assigned_agent_id text not null default '';
alter table tickets add column if not exists auto_approve boolean not null default false;
alter table tickets add column if not exists scheduled_for timestamptz;
alter table tickets add column if not exists execution_state text not null default 'pending';
alter table tickets add column if not exists execution_mode text not null default 'auto';
alter table tickets add column if not exists lifecycle_status text not null default 'open';
alter table tickets add column if not exists plan_text text;
alter table tickets add column if not exists plan_approved boolean not null default false;
alter table tickets add column if not exists approved_at timestamptz;
alter table tickets add column if not exists created_by text;
alter table tickets add column if not exists telegram_chat_id text;
alter table tickets add column if not exists queue_name text not null default 'default';
alter table tickets add column if not exists approval_state text not null default 'none';
alter table tickets add column if not exists plan_generated_at timestamptz;
alter table tickets add column if not exists approved_by text;
update tickets set queue_name = 'default' where queue_name is null;

create table if not exists ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  name text not null,
  url text not null,
  mime_type text not null default 'application/octet-stream',
  size integer not null default 0,
  path text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists ticket_subtasks (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  title text not null,
  completed boolean not null default false,
  position integer not null default 0,
  checklist_name text not null default 'Checklist',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ticket_comments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  author_id text,
  author_name text not null default 'Operator',
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists ticket_activity (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  source text not null default 'Tasks',
  event text not null,
  details text not null default '',
  level text not null default 'info',
  actor_name text,
  actor_email text,
  occurred_at timestamptz not null default now()
);
alter table ticket_activity add column if not exists actor_name text;
alter table ticket_activity add column if not exists actor_email text;

create table if not exists board_assignees (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards(id) on delete cascade,
  name text not null,
  color text not null default '#94a3b8',
  initials text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (board_id, name)
);
create index if not exists board_assignees_board_id_idx on board_assignees(board_id);
alter table board_assignees add column if not exists email text;
create index if not exists board_assignees_email_idx on board_assignees(lower(email)) where email is not null;

-- In-app bell notifications. Lookup is by recipient_email so it ties to the
-- session user's email; recipient_sub may be filled in later as users log in.
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  recipient_email text not null,
  recipient_sub text,
  kind text not null default 'mention',
  actor_name text,
  actor_email text,
  board_id uuid references boards(id) on delete cascade,
  ticket_id uuid references tickets(id) on delete cascade,
  comment_id uuid references ticket_comments(id) on delete cascade,
  preview text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_unread_idx
  on notifications(lower(recipient_email), created_at desc)
  where read_at is null;
create index if not exists notifications_recipient_recent_idx
  on notifications(lower(recipient_email), created_at desc);

-- One-shot data migration: clear legacy runtime-agent assignee_ids on tickets.
-- Tickets used to reference runtime agent IDs; switching to board-scoped custom
-- assignees would leave orphans. The flag column makes this idempotent.
alter table app_settings add column if not exists board_assignees_migrated_at timestamptz;
do $$
begin
  if not exists (select 1 from app_settings where id = 1 and board_assignees_migrated_at is not null) then
    update tickets set assignee_ids = '{}'::text[], updated_at = now() where assignee_ids <> '{}'::text[];
    update app_settings set board_assignees_migrated_at = now() where id = 1;
  end if;
end $$;

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  openclaw_agent_id text,
  status text not null default 'idle',
  model text,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, openclaw_agent_id)
);

create table if not exists agent_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  telegram_chat_id text not null,
  openclaw_session_key text not null,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, agent_id, telegram_chat_id)
);

create table if not exists agent_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  runtime_agent_id text,
  occurred_at timestamptz not null default now(),
  level text not null default 'info',
  type text not null default 'system',
  run_id text,
  message text,
  event_id text,
  event_type text,
  direction text,
  channel_type text,
  session_key text,
  source_message_id text,
  correlation_id text,
  status text,
  retry_count integer,
  message_preview text,
  is_json boolean,
  contains_pii boolean,
  memory_source text,
  memory_key text,
  collection text,
  query_text text,
  result_count integer,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists activity_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  source text not null default 'System',
  event text not null,
  details text not null default '',
  level text not null default 'info',
  actor_name text,
  actor_email text,
  created_at timestamptz not null default now()
);
alter table activity_logs add column if not exists actor_name text;
alter table activity_logs add column if not exists actor_email text;

create table if not exists notification_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,
  provider text not null,
  target text not null,
  enabled boolean not null default false,
  events text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, provider, target)
);

create table if not exists worker_settings (
  id integer primary key default 1,
  enabled boolean not null default true,
  poll_interval_seconds integer not null default 20,
  max_concurrency integer not null default 3,
  last_tick_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worker_settings_single_row check (id = 1),
  constraint worker_settings_poll_range check (poll_interval_seconds between 5 and 300),
  constraint worker_settings_concurrency_range check (max_concurrency between 1 and 20)
);

insert into worker_settings (id, enabled, poll_interval_seconds, max_concurrency)
values (1, true, 20, 3)
on conflict (id) do nothing;

alter table worker_settings add column if not exists last_tick_at timestamptz;
alter table worker_settings add column if not exists agenda_concurrency integer not null default 5;
alter table worker_settings add column if not exists default_execution_window_minutes integer not null default 30;
alter table worker_settings add column if not exists auto_retry_after_minutes integer not null default 0;
alter table worker_settings add column if not exists instance_name text not null default 'Mission Control';

-- ─── Phase 2: Processes ──────────────────────────────────────────────────────

create table if not exists processes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_processes_workspace on processes(workspace_id);
create index if not exists idx_processes_status on processes(status);

create table if not exists process_versions (
  id uuid primary key default gen_random_uuid(),
  process_id uuid not null references processes(id) on delete cascade,
  version_number integer not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (process_id, version_number)
);

create index if not exists idx_process_versions_process on process_versions(process_id);

create table if not exists process_steps (
  id uuid primary key default gen_random_uuid(),
  process_version_id uuid not null references process_versions(id) on delete cascade,
  step_order integer not null,
  title text not null default '',
  instruction text not null default '',
  skill_key text,
  agent_id text,
  timeout_seconds integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_process_steps_version on process_steps(process_version_id);

-- ─── Phase 2: Agenda ──────────────────────────────────────────────────────────

create table if not exists agenda_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  free_prompt text,
  default_agent_id text,
  timezone text not null default 'Europe/Amsterdam',
  starts_at timestamptz not null,
  ends_at timestamptz,
  recurrence_rule text,
  recurrence_until timestamptz,
  depends_on_event_id uuid references agenda_events(id),
  dependency_timeout_hours integer not null default 24,
  status text not null default 'draft' check (status in ('draft', 'active')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agenda_events_workspace on agenda_events(workspace_id);
create index if not exists idx_agenda_events_status on agenda_events(status);

create table if not exists agenda_event_processes (
  id uuid primary key default gen_random_uuid(),
  agenda_event_id uuid not null references agenda_events(id) on delete cascade,
  process_version_id uuid not null references process_versions(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_agenda_event_processes_event on agenda_event_processes(agenda_event_id);

create table if not exists agenda_occurrences (
  id uuid primary key default gen_random_uuid(),
  agenda_event_id uuid not null references agenda_events(id) on delete cascade,
  scheduled_for timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
  latest_attempt_no integer not null default 0,
  locked_at timestamptz,
  queue_job_id text,              -- legacy BullMQ era column, kept for compatibility
  queued_at timestamptz,
  retry_requested_at timestamptz,
  last_retry_reason text,
  skip_reason text,
  created_at timestamptz not null default now(),
  unique (agenda_event_id, scheduled_for)
);

create index if not exists idx_agenda_occurrences_event on agenda_occurrences(agenda_event_id);
create index if not exists idx_agenda_occurrences_status on agenda_occurrences(status);
create index if not exists idx_agenda_occurrences_scheduled on agenda_occurrences(scheduled_for);

create table if not exists agenda_occurrence_overrides (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references agenda_occurrences(id) on delete cascade,
  overridden_title text,
  overridden_free_prompt text,
  overridden_agent_id text,
  overridden_status text,
  overridden_starts_at timestamptz,
  overridden_ends_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_agenda_occurrence_overrides_occurrence on agenda_occurrence_overrides(occurrence_id);

create table if not exists agenda_run_attempts (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references agenda_occurrences(id) on delete cascade,
  attempt_no integer not null,
  cron_job_id text, -- openclaw cron job id that produced this attempt
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary text,
  error_message text
);

create index if not exists idx_agenda_run_attempts_occurrence on agenda_run_attempts(occurrence_id);

-- Phase 4: Cleanup system for failed agenda attempts
ALTER TABLE agenda_run_attempts ADD COLUMN IF NOT EXISTS session_snapshots jsonb;
ALTER TABLE agenda_run_attempts ADD COLUMN IF NOT EXISTS cleanup_status text;
ALTER TABLE agenda_run_attempts ADD COLUMN IF NOT EXISTS cleanup_details jsonb;

CREATE TABLE IF NOT EXISTS agent_execution_locks (
  agent_id TEXT PRIMARY KEY,
  occurrence_id UUID,
  locked_at TIMESTAMPTZ DEFAULT now()
);

create table if not exists agenda_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_attempt_id uuid not null references agenda_run_attempts(id) on delete cascade,
  process_version_id uuid references process_versions(id) on delete set null,
  process_step_id uuid,
  step_order integer not null default 0,
  agent_id text,
  skill_key text,
  input_payload jsonb not null default '{}',
  output_payload jsonb,
  artifact_payload jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);

create index if not exists idx_agenda_run_steps_attempt on agenda_run_steps(run_attempt_id);

-- Ticket scheduling v2
alter table tickets add column if not exists task_type text not null default 'one_time';
alter table tickets add column if not exists frequency text;
alter table tickets add column if not exists weekdays text[] not null default '{}'::text[];
alter table tickets add column if not exists start_time text;
alter table tickets add column if not exists start_date_mode text not null default 'now';
alter table tickets add column if not exists end_date_mode text not null default 'forever';
alter table tickets add column if not exists end_date date;
alter table tickets add column if not exists model_override text not null default '';

-- Agenda event model override
alter table agenda_events add column if not exists model_override text not null default '';

-- Process version label + step model override
alter table process_versions add column if not exists version_label text not null default '';
alter table process_steps add column if not exists model_override text not null default '';

-- ─── Phase 3: Resilient Job Orchestration ─────────────────────────────────────

-- Expand occurrence statuses to include needs_retry and expired
ALTER TABLE agenda_occurrences DROP CONSTRAINT IF EXISTS agenda_occurrences_status_check;
ALTER TABLE agenda_occurrences ADD CONSTRAINT agenda_occurrences_status_check
  CHECK (status IN ('scheduled', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_retry', 'expired'));

-- Execution window + fallback model on events
ALTER TABLE agenda_events ADD COLUMN IF NOT EXISTS execution_window_minutes integer NOT NULL DEFAULT 30;
ALTER TABLE agenda_events ADD COLUMN IF NOT EXISTS fallback_model text NOT NULL DEFAULT '';

-- Fallback model on process steps
ALTER TABLE process_steps ADD COLUMN IF NOT EXISTS fallback_model text NOT NULL DEFAULT '';

-- Service health monitoring
CREATE TABLE IF NOT EXISTS service_health (
  name text PRIMARY KEY,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('running', 'stopped', 'error', 'unknown')),
  pid integer,
  last_heartbeat_at timestamptz,
  last_error text,
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Phase 3b: Ticket Resilience v1.3 ─────────────────────────────────────────

-- Execution window + fallback model on tickets
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS execution_window_minutes integer NOT NULL DEFAULT 60;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fallback_model text NOT NULL DEFAULT '';

-- Note: execution_state is an unconstrained text column. The following are now valid:
-- needs_retry — manual intervention required after max retries exhausted
-- expired — missed the execution window

-- v1.5.0: Add max_retries and default_fallback_model to worker_settings
alter table worker_settings add column if not exists max_retries integer not null default 1;
alter table worker_settings add column if not exists default_fallback_model text not null default '';

-- v1.5.1: Configurable scheduling interval (0 = free time, no slot enforcement)
alter table worker_settings add column if not exists scheduling_interval_minutes integer not null default 15;


-- v2.0: cron-based execution engine
-- Replace BullMQ/worker with openclaw cron jobs
ALTER TABLE agenda_occurrences ADD COLUMN IF NOT EXISTS cron_job_id TEXT;
ALTER TABLE agenda_occurrences ADD COLUMN IF NOT EXISTS fallback_attempted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agenda_occurrences ADD COLUMN IF NOT EXISTS cron_synced_at TIMESTAMPTZ;

-- v2.0: cron-based execution engine (replaces BullMQ/agenda-worker)
ALTER TABLE agenda_occurrences ADD COLUMN IF NOT EXISTS cron_job_id TEXT;
ALTER TABLE agenda_occurrences ADD COLUMN IF NOT EXISTS fallback_attempted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agenda_occurrences ADD COLUMN IF NOT EXISTS cron_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_agenda_occurrences_cron_job ON agenda_occurrences(cron_job_id);

-- v2.1: rendered_prompt for retry accuracy
ALTER TABLE agenda_occurrences ADD COLUMN IF NOT EXISTS rendered_prompt TEXT;

-- v3.0: per-event session target (isolated | main) — controls how cron runs the agent
-- Defaults to 'isolated' (safe, no session pollution).
ALTER TABLE agenda_events ADD COLUMN IF NOT EXISTS session_target TEXT NOT NULL DEFAULT 'isolated'
  CHECK (session_target IN ('isolated', 'main'));

-- v3.0: sidebar activity count setting
ALTER TABLE worker_settings ADD COLUMN IF NOT EXISTS sidebar_activity_count INTEGER NOT NULL DEFAULT 8;

-- v4.0: rename queue_job_id → cron_job_id in agenda_run_attempts (phase 4)
-- The column held openclaw cron job IDs, not BullMQ queue job IDs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agenda_run_attempts' AND column_name = 'queue_job_id'
  ) THEN
    ALTER TABLE agenda_run_attempts RENAME COLUMN queue_job_id TO cron_job_id;
  END IF;
END $$;

-- v4.1: agenda correlation in agent_logs — enables agenda-specific log filtering
ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS agenda_occurrence_id UUID;
CREATE INDEX IF NOT EXISTS idx_agent_logs_occurrence ON agent_logs(agenda_occurrence_id) WHERE agenda_occurrence_id IS NOT NULL;

-- v4.2: session-line-offset for main-session task output isolation
-- Records the session file line count at the moment a main-session task is
-- scheduled. Bridge-logger uses this to scope output resolution to only
-- the lines written during this specific task, preventing cross-task
-- contamination in shared main sessions.
ALTER TABLE agenda_occurrences ADD COLUMN IF NOT EXISTS session_line_offset BIGINT;
CREATE INDEX IF NOT EXISTS idx_agenda_occurrences_session_line_offset
  ON agenda_occurrences(session_line_offset)
  WHERE session_line_offset IS NOT NULL;
