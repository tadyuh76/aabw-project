-- ScamDNA hackathon data module schema.
-- Intentionally service-role only: the local Streamlit app and worker are the
-- only clients. Auth, RLS, multi-tenancy, and deployment concerns are deferred.

begin;

create table if not exists public.crawl_jobs (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    mode text not null default 'backfill',
    status text not null default 'queued',
    current_stage text not null default 'queued',
    parameters jsonb not null default '{}'::jsonb,

    total_items integer not null default 0 check (total_items >= 0),
    discovered_count integer not null default 0 check (discovered_count >= 0),
    deduplicated_count integer not null default 0 check (deduplicated_count >= 0),
    fetched_count integer not null default 0 check (fetched_count >= 0),
    agent_count integer not null default 0 check (agent_count >= 0),
    classified_count integer not null default 0 check (classified_count >= 0),
    failed_count integer not null default 0 check (failed_count >= 0),

    agent_budget integer not null default 50 check (agent_budget >= 0),
    agent_used integer not null default 0 check (agent_used >= 0),
    pause_requested boolean not null default false,
    cancel_requested boolean not null default false,

    last_heartbeat timestamptz,
    last_error text,
    next_run_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint crawl_jobs_parameters_object
        check (jsonb_typeof(parameters) = 'object')
);

create table if not exists public.documents (
    id uuid primary key default gen_random_uuid(),
    canonical_url text not null,
    url_hash text not null,
    platform text,
    author_display_name text,
    title text,
    body text,
    language text,
    published_at timestamptz,

    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    fetched_at timestamptz,
    fetch_status text not null default 'pending',

    search_title text,
    search_snippet text,
    search_rank integer,
    search_query text,
    raw_metadata jsonb not null default '{}'::jsonb,
    content_hash text,

    agent_enriched boolean not null default false,
    classification_status text not null default 'pending',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint documents_url_hash_unique unique (url_hash),
    constraint documents_raw_metadata_object
        check (jsonb_typeof(raw_metadata) = 'object')
);

create table if not exists public.crawl_items (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.crawl_jobs(id) on delete cascade,
    item_type text not null,
    idempotency_key text not null,
    query_text text,
    source_url text,
    document_id uuid references public.documents(id) on delete set null,
    stage text not null default 'queued',
    status text not null default 'queued',
    attempts integer not null default 0 check (attempts >= 0),
    last_error text,
    checkpoint jsonb not null default '{}'::jsonb,
    last_heartbeat timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint crawl_items_job_idempotency_unique
        unique (job_id, idempotency_key),
    constraint crawl_items_checkpoint_object
        check (jsonb_typeof(checkpoint) = 'object')
);

create table if not exists public.crawl_events (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.crawl_jobs(id) on delete cascade,
    item_id uuid references public.crawl_items(id) on delete set null,
    document_id uuid references public.documents(id) on delete set null,
    stage text,
    severity text not null default 'info',
    message text not null,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),

    constraint crawl_events_severity_valid
        check (severity in ('debug', 'info', 'warning', 'error')),
    constraint crawl_events_details_object
        check (jsonb_typeof(details) = 'object')
);

create table if not exists public.document_comments (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    external_comment_id text not null,
    author_display_name text,
    body text not null,
    published_at timestamptz,
    published_at_text text,
    source_url text,
    raw_metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),

    constraint document_comments_document_external_unique
        unique (document_id, external_comment_id),
    constraint document_comments_raw_metadata_object
        check (jsonb_typeof(raw_metadata) = 'object')
);

create table if not exists public.media_evidence (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    media_key text not null,
    source_url text,
    media_type text not null default 'image',
    visual_description text,
    media_hash text,
    qr_present boolean not null default false,
    qr_payload text,
    qr_confidence numeric(5,4),
    qr_confidence_text text,
    agent_run_id text,
    raw_metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),

    constraint media_evidence_document_key_unique
        unique (document_id, media_key),
    constraint media_evidence_qr_confidence_range
        check (qr_confidence is null or qr_confidence between 0 and 1),
    constraint media_evidence_raw_metadata_object
        check (jsonb_typeof(raw_metadata) = 'object')
);

create table if not exists public.classifications (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    job_id uuid references public.crawl_jobs(id) on delete set null,
    provider text not null default 'openai',
    model text not null,
    prompt_version text not null default 'v1',
    primary_category text not null,
    scam_types text[] not null default '{}'::text[],
    bank_roles text[] not null default '{}'::text[],
    specific_case boolean not null default false,
    first_person_report boolean not null default false,
    summary text,
    severity smallint not null default 0,
    confidence numeric(5,4) not null default 0,
    evidence jsonb not null default '[]'::jsonb,
    raw_output jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint classifications_document_unique unique (document_id),
    constraint classifications_primary_category_valid check (
        primary_category in (
            'scam_report',
            'impersonation_abuse',
            'customer_feedback',
            'news_pr',
            'noise'
        )
    ),
    constraint classifications_severity_range
        check (severity between 0 and 5),
    constraint classifications_confidence_range
        check (confidence between 0 and 1),
    constraint classifications_raw_output_object
        check (jsonb_typeof(raw_output) = 'object')
);

create table if not exists public.indicators (
    id uuid primary key default gen_random_uuid(),
    kind text not null,
    normalized_value text not null,
    display_value text not null,
    raw_metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint indicators_kind_normalized_unique
        unique (kind, normalized_value),
    constraint indicators_kind_valid check (
        kind in (
            'bank_account',
            'phone',
            'email',
            'domain',
            'url',
            'social_account',
            'person_alias',
            'organization_alias',
            'qr_payload',
            'transaction_reference',
            'payment_method',
            'money_amount',
            'media_hash',
            'message_template'
        )
    ),
    constraint indicators_normalized_value_not_blank
        check (btrim(normalized_value) <> ''),
    constraint indicators_raw_metadata_object
        check (jsonb_typeof(raw_metadata) = 'object')
);

create table if not exists public.document_indicators (
    document_id uuid not null references public.documents(id) on delete cascade,
    indicator_id uuid not null references public.indicators(id) on delete cascade,
    classification_id uuid references public.classifications(id) on delete set null,
    evidence_source text not null default 'ai',
    evidence_quote text,
    confidence numeric(5,4) not null default 1,
    created_at timestamptz not null default now(),

    primary key (document_id, indicator_id, evidence_source),
    constraint document_indicators_confidence_range
        check (confidence between 0 and 1)
);

create table if not exists public.provider_usage (
    id uuid primary key default gen_random_uuid(),
    job_id uuid references public.crawl_jobs(id) on delete set null,
    item_id uuid references public.crawl_items(id) on delete set null,
    document_id uuid references public.documents(id) on delete set null,
    provider text not null,
    operation text not null,
    status text not null default 'completed',
    model text,
    request_id text,
    request_count integer not null default 1 check (request_count >= 0),
    units numeric(12,4) not null default 1 check (units >= 0),
    agent_run_id text,
    steps integer check (steps is null or steps >= 0),
    duration_ms integer check (duration_ms is null or duration_ms >= 0),
    input_tokens integer check (input_tokens is null or input_tokens >= 0),
    output_tokens integer check (output_tokens is null or output_tokens >= 0),
    total_tokens integer check (total_tokens is null or total_tokens >= 0),
    cost_usd numeric(12,6) check (cost_usd is null or cost_usd >= 0),
    error text,
    details jsonb not null default '{}'::jsonb,
    raw_metadata jsonb not null default '{}'::jsonb,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now(),

    constraint provider_usage_details_object
        check (jsonb_typeof(details) = 'object'),
    constraint provider_usage_raw_metadata_object
        check (jsonb_typeof(raw_metadata) = 'object')
);

-- Queue, dashboard, preview, and graph traversal indexes used by the MVP.
create index if not exists crawl_jobs_work_queue_idx
    on public.crawl_jobs (status, next_run_at, created_at);

create index if not exists crawl_items_work_queue_idx
    on public.crawl_items (job_id, status, stage, updated_at);

create index if not exists crawl_items_document_id_idx
    on public.crawl_items (document_id)
    where document_id is not null;

create index if not exists crawl_events_job_created_at_idx
    on public.crawl_events (job_id, created_at desc);

create index if not exists crawl_events_severity_created_at_idx
    on public.crawl_events (severity, created_at desc);

create index if not exists documents_published_at_idx
    on public.documents (published_at desc)
    where published_at is not null;

create index if not exists documents_last_seen_at_idx
    on public.documents (last_seen_at desc);

create index if not exists document_comments_document_id_idx
    on public.document_comments (document_id, created_at);

create index if not exists media_evidence_document_id_idx
    on public.media_evidence (document_id, created_at);

create index if not exists classifications_category_confidence_idx
    on public.classifications (primary_category, confidence desc);

create index if not exists document_indicators_indicator_id_idx
    on public.document_indicators (indicator_id, document_id);

create index if not exists provider_usage_job_created_at_idx
    on public.provider_usage (job_id, created_at desc)
    where job_id is not null;

create index if not exists provider_usage_document_id_idx
    on public.provider_usage (document_id)
    where document_id is not null;

-- Keep operational records current without requiring every caller to set it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists crawl_jobs_set_updated_at on public.crawl_jobs;
create trigger crawl_jobs_set_updated_at
before update on public.crawl_jobs
for each row execute function public.set_updated_at();

drop trigger if exists crawl_items_set_updated_at on public.crawl_items;
create trigger crawl_items_set_updated_at
before update on public.crawl_items
for each row execute function public.set_updated_at();

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
before update on public.documents
for each row execute function public.set_updated_at();

drop trigger if exists classifications_set_updated_at on public.classifications;
create trigger classifications_set_updated_at
before update on public.classifications
for each row execute function public.set_updated_at();

drop trigger if exists indicators_set_updated_at on public.indicators;
create trigger indicators_set_updated_at
before update on public.indicators
for each row execute function public.set_updated_at();

-- Supabase's 2026 Data API defaults no longer expose new tables automatically.
-- The hackathon app uses only the server-side service key, so anon and
-- authenticated are deliberately not granted table access.
grant usage on schema public to service_role;

grant select, insert, update, delete on table
    public.crawl_jobs,
    public.crawl_items,
    public.crawl_events,
    public.documents,
    public.document_comments,
    public.media_evidence,
    public.classifications,
    public.indicators,
    public.document_indicators,
    public.provider_usage
to service_role;

revoke all privileges on table
    public.crawl_jobs,
    public.crawl_items,
    public.crawl_events,
    public.documents,
    public.document_comments,
    public.media_evidence,
    public.classifications,
    public.indicators,
    public.document_indicators,
    public.provider_usage
from anon, authenticated;

revoke execute on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.set_updated_at() to service_role;

commit;
