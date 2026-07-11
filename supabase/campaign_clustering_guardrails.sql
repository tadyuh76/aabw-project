-- Scam-only campaign clustering guardrails.
-- Apply after schema.sql, analytics_extension.sql, and campaign_readiness.sql.

begin;

create or replace function public.assert_campaign_document_is_scam_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_table_name = 'campaign_documents' and new.is_active is not true then
        return new;
    end if;

    if not exists (
        select 1
        from public.classifications c
        join public.documents d on d.id = c.document_id
        where c.document_id = new.document_id
          and d.classification_status = 'completed'
          and c.primary_category in ('scam_report', 'impersonation_abuse')
          and c.specific_case is true
          and c.confidence >= 0.6
    ) then
        raise exception using
            errcode = '23514',
            message = 'Campaign membership requires concrete, sufficiently confident scam evidence.';
    end if;

    return new;
end;
$$;

drop trigger if exists campaign_cluster_documents_require_scam_evidence
    on public.campaign_cluster_documents;
create trigger campaign_cluster_documents_require_scam_evidence
before insert or update of document_id
on public.campaign_cluster_documents
for each row execute function public.assert_campaign_document_is_scam_evidence();

drop trigger if exists campaign_documents_require_scam_evidence
    on public.campaign_documents;
create trigger campaign_documents_require_scam_evidence
before insert or update of document_id, is_active
on public.campaign_documents
for each row execute function public.assert_campaign_document_is_scam_evidence();

create or replace function public.assert_campaign_anchor_is_durable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.is_active is true
       and new.role = 'anchor'
       and exists (
           select 1
           from public.indicators i
           where i.id = new.indicator_id
             and i.kind = 'message_template'
       ) then
        raise exception using
            errcode = '23514',
            message = 'Message templates cannot automatically anchor campaigns.';
    end if;

    return new;
end;
$$;

drop trigger if exists campaign_indicators_require_durable_anchor
    on public.campaign_indicators;
create trigger campaign_indicators_require_durable_anchor
before insert or update of indicator_id, role, is_active
on public.campaign_indicators
for each row execute function public.assert_campaign_anchor_is_durable();

-- Remove ineligible rows from the active derivative layer. Inactive rows remain
-- untouched as historical audit evidence.
delete from public.campaign_cluster_documents ccd
using public.campaign_clusters cc
where cc.id = ccd.cluster_id
  and cc.is_active is true
  and not exists (
      select 1
      from public.classifications c
      join public.documents d on d.id = c.document_id
      where c.document_id = ccd.document_id
        and d.classification_status = 'completed'
        and c.primary_category in ('scam_report', 'impersonation_abuse')
        and c.specific_case is true
        and c.confidence >= 0.6
  );

update public.campaign_documents cd
set is_active = false
where cd.is_active is true
  and cd.analyst_confirmed is false
  and not exists (
      select 1
      from public.classifications c
      join public.documents d on d.id = c.document_id
      where c.document_id = cd.document_id
        and d.classification_status = 'completed'
        and c.primary_category in ('scam_report', 'impersonation_abuse')
        and c.specific_case is true
        and c.confidence >= 0.6
  );

-- A free-form phrase may support analyst review, but a phrase-only component
-- is not an automatic campaign.
update public.campaign_clusters cc
set is_active = false,
    algorithm = 'strong_indicator_components_v3_scam_only'
where cc.is_active is true
  and not exists (
      select 1
      from unnest(cc.shared_indicator_keys) as key
      where split_part(key, '|', 1) in (
          'bank_account', 'phone', 'email', 'domain', 'social_account',
          'qr_payload', 'transaction_reference', 'media_hash'
      )
  );

update public.campaign_indicators ci
set is_active = false
where ci.is_active is true
  and ci.role = 'anchor'
  and exists (
      select 1
      from public.indicators i
      where i.id = ci.indicator_id
        and i.kind = 'message_template'
  );

update public.campaigns c
set is_active = false
where c.is_active is true
  and c.analyst_confirmed is false
  and (
      not exists (
          select 1
          from public.campaign_clusters cc
          where cc.id = c.source_cluster_id
            and cc.is_active is true
      )
      or (
          select count(*)
          from public.campaign_documents cd
          where cd.campaign_id = c.id
            and cd.is_active is true
      ) < 2
  );

update public.campaign_indicators ci
set is_active = false
where ci.is_active is true
  and exists (
      select 1
      from public.campaigns c
      where c.id = ci.campaign_id
        and c.is_active is false
  );

grant execute on function
    public.assert_campaign_document_is_scam_evidence(),
    public.assert_campaign_anchor_is_durable()
to service_role;

notify pgrst, 'reload schema';

commit;
