-- ScamDNA live analytics extension for the existing hackathon schema.
-- Safe to rerun in the Supabase SQL editor.

begin;

alter table public.media_evidence
    add column if not exists extracted_text text,
    add column if not exists vision_status text not null default 'pending',
    add column if not exists vision_provider text,
    add column if not exists vision_model text,
    add column if not exists vision_confidence numeric(5,4),
    add column if not exists analyzed_at timestamptz;

alter table public.classifications alter column provider set default 'openai';

create table if not exists public.document_discoveries (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.crawl_jobs(id) on delete cascade,
    query_item_id uuid references public.crawl_items(id) on delete set null,
    document_id uuid not null references public.documents(id) on delete cascade,
    search_provider text not null,
    query_fingerprint text not null,
    query_text text not null,
    search_position integer,
    result_title text,
    result_snippet text,
    result_date_text text,
    raw_result jsonb not null default '{}'::jsonb,
    discovered_at timestamptz not null default now(),
    constraint document_discoveries_unique
        unique (job_id, query_fingerprint, document_id),
    constraint document_discoveries_raw_object
        check (jsonb_typeof(raw_result) = 'object')
);

create table if not exists public.analysis_metrics (
    id uuid primary key default gen_random_uuid(),
    job_id uuid references public.crawl_jobs(id) on delete set null,
    metric_scope text not null,
    metric_key text not null,
    metric_value jsonb not null default '{}'::jsonb,
    evidence_document_ids uuid[] not null default '{}'::uuid[],
    evidence_indicator_keys text[] not null default '{}'::text[],
    refreshed_at timestamptz not null default now(),
    constraint analysis_metrics_scope_key_unique unique (metric_scope, metric_key),
    constraint analysis_metrics_value_object
        check (jsonb_typeof(metric_value) = 'object')
);

create table if not exists public.campaign_clusters (
    id uuid primary key default gen_random_uuid(),
    job_id uuid references public.crawl_jobs(id) on delete set null,
    cluster_key text not null unique,
    algorithm text not null default 'strong_indicator_components_v1',
    label text,
    is_active boolean not null default true,
    risk_score numeric(8,4) not null default 0,
    document_count integer not null default 0,
    indicator_count integer not null default 0,
    maximum_severity smallint not null default 0,
    average_confidence numeric(5,4) not null default 0,
    category_counts jsonb not null default '[]'::jsonb,
    scam_types text[] not null default '{}'::text[],
    bank_roles text[] not null default '{}'::text[],
    indicator_keys text[] not null default '{}'::text[],
    shared_indicator_keys text[] not null default '{}'::text[],
    first_seen_at timestamptz,
    last_seen_at timestamptz,
    metrics jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint campaign_clusters_category_counts_array
        check (jsonb_typeof(category_counts) = 'array'),
    constraint campaign_clusters_metrics_object
        check (jsonb_typeof(metrics) = 'object')
);

create table if not exists public.campaign_cluster_documents (
    cluster_id uuid not null references public.campaign_clusters(id) on delete cascade,
    document_id uuid not null references public.documents(id) on delete cascade,
    membership_score numeric(5,4) not null default 1,
    reasons jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    primary key (cluster_id, document_id),
    constraint campaign_cluster_documents_reasons_array
        check (jsonb_typeof(reasons) = 'array')
);

create table if not exists public.anomalies (
    id uuid primary key default gen_random_uuid(),
    job_id uuid references public.crawl_jobs(id) on delete set null,
    cluster_id uuid references public.campaign_clusters(id) on delete set null,
    anomaly_key text not null unique,
    anomaly_type text not null,
    is_active boolean not null default true,
    score numeric(10,4) not null default 0,
    severity smallint not null default 1,
    reason text,
    metrics jsonb not null default '{}'::jsonb,
    evidence_document_ids uuid[] not null default '{}'::uuid[],
    evidence_indicator_keys text[] not null default '{}'::text[],
    detected_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint anomalies_metrics_object check (jsonb_typeof(metrics) = 'object')
);

create table if not exists public.grounded_insights (
    id uuid primary key default gen_random_uuid(),
    job_id uuid references public.crawl_jobs(id) on delete set null,
    cluster_id uuid references public.campaign_clusters(id) on delete set null,
    insight_key text not null unique,
    insight_type text not null default 'campaign_summary',
    title text not null,
    summary text not null,
    severity smallint not null default 1,
    confidence numeric(5,4) not null default 0,
    model text not null,
    prompt_version text not null,
    metrics jsonb not null default '{}'::jsonb,
    evidence_document_ids uuid[] not null default '{}'::uuid[],
    evidence_links jsonb not null default '[]'::jsonb,
    raw_output jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint grounded_insights_metrics_object check (jsonb_typeof(metrics) = 'object'),
    constraint grounded_insights_links_array check (jsonb_typeof(evidence_links) = 'array'),
    constraint grounded_insights_raw_object check (jsonb_typeof(raw_output) = 'object')
);

create index if not exists document_discoveries_document_idx
    on public.document_discoveries (document_id, discovered_at desc);
create index if not exists analysis_metrics_scope_idx
    on public.analysis_metrics (metric_scope, refreshed_at desc);
create index if not exists campaign_clusters_active_risk_idx
    on public.campaign_clusters (is_active, risk_score desc, document_count desc);
create index if not exists campaign_cluster_documents_document_idx
    on public.campaign_cluster_documents (document_id, cluster_id);
create index if not exists anomalies_active_score_idx
    on public.anomalies (is_active, score desc, detected_at desc);
create index if not exists grounded_insights_created_idx
    on public.grounded_insights (created_at desc);

drop trigger if exists campaign_clusters_set_updated_at on public.campaign_clusters;
create trigger campaign_clusters_set_updated_at before update on public.campaign_clusters
for each row execute function public.set_updated_at();
drop trigger if exists anomalies_set_updated_at on public.anomalies;
create trigger anomalies_set_updated_at before update on public.anomalies
for each row execute function public.set_updated_at();
drop trigger if exists grounded_insights_set_updated_at on public.grounded_insights;
create trigger grounded_insights_set_updated_at before update on public.grounded_insights
for each row execute function public.set_updated_at();

grant select, insert, update, delete on table
    public.document_discoveries,
    public.analysis_metrics,
    public.campaign_clusters,
    public.campaign_cluster_documents,
    public.anomalies,
    public.grounded_insights
to service_role;

revoke all privileges on table
    public.document_discoveries,
    public.analysis_metrics,
    public.campaign_clusters,
    public.campaign_cluster_documents,
    public.anomalies,
    public.grounded_insights
from anon, authenticated;

notify pgrst, 'reload schema';

commit;
