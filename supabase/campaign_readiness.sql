-- Stable, analyst-facing campaign layer for ScamDNA.
--
-- campaign_clusters remains a refreshable analytics output. These tables hold
-- durable campaign identity and reviewed membership so application code never
-- has to treat a derivative cluster UUID as a permanent campaign identifier.
-- Safe to rerun in the Supabase SQL editor after schema.sql and
-- analytics_extension.sql have been applied.

begin;

create table if not exists public.campaigns (
    id uuid primary key default gen_random_uuid(),
    campaign_key text not null,
    anchor_indicator_key text not null,
    source_cluster_id uuid references public.campaign_clusters(id) on delete set null,

    label text,
    status text not null default 'provisional',
    analyst_confirmed boolean not null default false,
    is_active boolean not null default true,

    risk_score numeric(8,4) not null default 0,
    document_count integer not null default 0,
    indicator_count integer not null default 0,
    maximum_severity smallint not null default 0,
    average_confidence numeric(5,4) not null default 0,
    scam_types text[] not null default '{}'::text[],
    bank_roles text[] not null default '{}'::text[],
    shared_indicator_keys text[] not null default '{}'::text[],

    first_seen_at timestamptz,
    last_seen_at timestamptz,
    confirmed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    metadata jsonb not null default '{}'::jsonb,

    constraint campaigns_campaign_key_unique unique (campaign_key),
    constraint campaigns_campaign_key_not_blank check (btrim(campaign_key) <> ''),
    constraint campaigns_anchor_indicator_key_not_blank
        check (btrim(anchor_indicator_key) <> ''),
    constraint campaigns_status_valid
        check (status in ('provisional', 'confirmed', 'dismissed')),
    constraint campaigns_risk_score_nonnegative check (risk_score >= 0),
    constraint campaigns_document_count_nonnegative check (document_count >= 0),
    constraint campaigns_indicator_count_nonnegative check (indicator_count >= 0),
    constraint campaigns_maximum_severity_range
        check (maximum_severity between 0 and 5),
    constraint campaigns_average_confidence_range
        check (average_confidence between 0 and 1),
    constraint campaigns_metadata_object
        check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.campaign_documents (
    campaign_id uuid not null references public.campaigns(id) on delete cascade,
    document_id uuid not null references public.documents(id) on delete cascade,
    membership_score numeric(5,4) not null default 1,
    reasons jsonb not null default '[]'::jsonb,
    analyst_confirmed boolean not null default false,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    primary key (campaign_id, document_id),
    constraint campaign_documents_membership_score_range
        check (membership_score between 0 and 1),
    constraint campaign_documents_reasons_array
        check (jsonb_typeof(reasons) = 'array')
);

create table if not exists public.campaign_indicators (
    campaign_id uuid not null references public.campaigns(id) on delete cascade,
    indicator_id uuid not null references public.indicators(id) on delete cascade,
    role text not null default 'supporting',
    weight numeric(5,4) not null default 1,
    reasons jsonb not null default '[]'::jsonb,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    primary key (campaign_id, indicator_id),
    constraint campaign_indicators_role_valid
        check (role in ('anchor', 'shared', 'supporting', 'context')),
    constraint campaign_indicators_weight_range check (weight between 0 and 1),
    constraint campaign_indicators_reasons_array
        check (jsonb_typeof(reasons) = 'array')
);

-- Keep the file rerunnable if an earlier hackathon draft created these tables
-- before the active flags and matching arrays were introduced.
alter table public.campaigns
    add column if not exists scam_types text[] not null default '{}'::text[],
    add column if not exists bank_roles text[] not null default '{}'::text[],
    add column if not exists shared_indicator_keys text[] not null default '{}'::text[];

alter table public.campaign_documents
    add column if not exists is_active boolean not null default true;

alter table public.campaign_indicators
    add column if not exists is_active boolean not null default true;

create index if not exists campaigns_status_active_risk_idx
    on public.campaigns (status, is_active, risk_score desc, document_count desc);

create index if not exists campaigns_anchor_indicator_key_idx
    on public.campaigns (anchor_indicator_key);

create index if not exists campaigns_source_cluster_idx
    on public.campaigns (source_cluster_id)
    where source_cluster_id is not null;

create index if not exists campaigns_last_seen_idx
    on public.campaigns (last_seen_at desc)
    where last_seen_at is not null;

create index if not exists campaigns_shared_indicator_keys_gin_idx
    on public.campaigns using gin (shared_indicator_keys);

create index if not exists campaign_documents_document_idx
    on public.campaign_documents (document_id, is_active, campaign_id);

create index if not exists campaign_documents_campaign_score_idx
    on public.campaign_documents (campaign_id, is_active, membership_score desc);

create index if not exists campaign_indicators_indicator_idx
    on public.campaign_indicators (indicator_id, is_active, campaign_id);

create index if not exists campaign_indicators_campaign_role_idx
    on public.campaign_indicators (campaign_id, is_active, role, weight desc);

-- A campaign has exactly zero or one normalized indicator designated as its
-- anchor. anchor_indicator_key remains the immutable, denormalized identity
-- seed even if the indicator record is later cleaned up.
create unique index if not exists campaign_indicators_one_anchor_idx
    on public.campaign_indicators (campaign_id)
    where role = 'anchor';

drop trigger if exists campaigns_set_updated_at on public.campaigns;
create trigger campaigns_set_updated_at
before update on public.campaigns
for each row execute function public.set_updated_at();

drop trigger if exists campaign_documents_set_updated_at
    on public.campaign_documents;
create trigger campaign_documents_set_updated_at
before update on public.campaign_documents
for each row execute function public.set_updated_at();

drop trigger if exists campaign_indicators_set_updated_at
    on public.campaign_indicators;
create trigger campaign_indicators_set_updated_at
before update on public.campaign_indicators
for each row execute function public.set_updated_at();

grant usage on schema public to service_role;

grant select, insert, update, delete on table
    public.campaigns,
    public.campaign_documents,
    public.campaign_indicators
to service_role;

revoke all privileges on table
    public.campaigns,
    public.campaign_documents,
    public.campaign_indicators
from anon, authenticated;

notify pgrst, 'reload schema';

commit;
