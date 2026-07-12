# ScamDNA Crawler + Live Campaign Analytics

Local hackathon pipeline for finding public scam/complaint posts, extracting evidence,
classifying each item, and streaming a continuously refreshed campaign graph into the
AABW Supabase project (`xrvrzpmwmqowymhuksse`).

```text
SerpAPI discovery (5 concurrent by default)
  → canonical URL deduplication
  → TinyFish Fetch (batches of 5 by default)
  → GPT-5.6 Luna text + relevant-image vision (maximum 2 images/item)
  → normalized indicators in Supabase
  → global strong-indicator clustering + anomalies after every batch
  → grounded insight summaries at the end of each cycle
```

TinyFish Agent is deliberately **manual-only** because it was the main speed/cost
bottleneck. Enable it only for a small operator-selected job that needs public comments
or browser-only evidence. Ordinary images are handled directly by Luna vision; if an
image URL cannot be loaded, item analysis automatically falls back to text.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
```

Set these gitignored local values:

```dotenv
SUPABASE_URL=https://xrvrzpmwmqowymhuksse.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
TINYFISH_API_KEY=...
SERPAPI_API_KEY=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=none
DISCOVERY_PROVIDER=serpapi
```

The Next.js customer and bank APIs require `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, and
`OPENAI_MODEL=gpt-5.6-luna`. These are server-only variables: never rename or duplicate
the service-role or OpenAI keys under a `NEXT_PUBLIC_*` name, and never commit their
values.

Start the two local processes:

```bash
source .venv/bin/activate
streamlit run data_module/ui.py
```

```bash
source .venv/bin/activate
python -m data_module.worker
```

Open <http://localhost:8501>. The UI is only a control plane; closing or refreshing it
does not stop the worker. The Settings tab swaps SerpAPI/OpenAI keys in local `.env`
without storing them in Supabase. A long-running worker reloads `.env` before each job.

## UI

- **New Crawl**: keywords, aliases, domains, date range, SerpAPI/fetch concurrency,
  URL cap, vision policy, and optional manual Agent budget.
- **Runs**: live counters plus start, pause, resume, cancel and retry.
- **Data Preview**: source evidence, category, severity, indicators and vision status.
- **Analytics**: live SQL metrics, linked campaigns, anomalies and grounded summaries.
- **Logs**: searchable stage/error events.
- **Settings**: hot-swap provider keys/model for the next job.

Both Runs and Analytics can poll Supabase every three seconds. The global graph refreshes
after every completed Fetch + Luna batch, so ingestion and cluster viewing happen at the
same time.

Run the customer and bank UI separately with `npm install && npm run dev`, then open
<http://localhost:3000>.

The Next.js bank overview reads `/api/bank-intelligence`, a server-only adapter over the
current `analysis_metrics` snapshot and active `campaigns` rows. It exposes
only validated aggregate counts and distributions; the service-role key and raw indicator
values never reach the browser. Unsupported monetary exposure, time-series, customer,
containment and workflow totals remain explicitly outside the live-data block.

The home checker posts real customer input to `POST /api/check` as multipart form data.
It accepts optional `text`, `url`, and one `image` screenshot or QR file, with at least
one field required and an 8 MB image limit. Luna analyzes text and images directly using
strict structured output; no separate OCR step is added. A server-only QR decoder also
extracts an exact barcode payload when possible while the original image still goes to
Luna; failed decoding remains explicitly unreadable instead of inventing a payload.
Classification is conservative:
general scam-recovery advice, generic warnings, and legitimate account-opening
commissions or referrals are not treated as concrete scams without case-specific
evidence.

The route first normalizes eligible strong indicators and joins them exactly through active
`campaign_indicators` to active, non-dismissed `campaigns`. When a concrete scam has no
qualifying exact match, it retrieves a bounded candidate set using stored taxonomy, token
overlap, and exact contextual signals linked through campaign documents. Luna then compares
only capped stored evidence summaries for those candidates. This path does not use embeddings,
does not create campaign relationships, and never forces an input into a campaign. The response status is
one of `matched_campaign`, `possible_match`, `new_unmatched_case`, or `not_scam`, with a
normalized analysis, the winning campaign when present, up to five public evidence
documents, grounded match reasons, and recommended actions. A campaign is shown to the
customer as `KNOWN CAMPAIGN` only when the match is exact and `analyst_confirmed=true`.
A contextual comparison may produce only `LIKELY RELATED CAMPAIGN`; an unconfirmed exact
match remains `POSSIBLE CAMPAIGN MATCH`. “No match” means only that the current snapshot has
no qualifying exact or contextual campaign evidence, not that the input is safe.

Bundled customer cases remain available only as an explicit demo fallback and still run
through the existing idle → scanning → result → anonymous-report presentation. Real
input never silently selects a demo fixture.

The `/bank` admin screen presents a live campaign registry backed by the stable
`campaigns` table, including exact normalized indicator roles and analyst-confirmation
state. The older illustrative campaign workspace remains explicitly identified as a
prototype; its sample values are not included in live campaign totals. The relationship map
is separate from that workspace and is built only from live campaigns, stored taxonomy,
capped linked documents, and server-masked indicators.

## Recommended fast defaults

- Search concurrency: `5`
- Fetch concurrency: `5`
- Unique URL cap per shard: `100`
- Search pages: `1` initially; monthly windows split weekly only when saturated
- Vision: relevant images only, maximum `2`
- TinyFish Agent: off
- Grounded summary: once at the end of a cycle

For a large backfill, shard by month and domain group, then run each explicit job in its
own process:

```bash
python -m data_module.worker --job-id <job-uuid>
```

Using explicit IDs prevents two workers from claiming the same queued job. Campaign
analytics is global, so all shards converge into one set of metrics and clusters.

The included YTD runner creates/reuses monthly MB Bank shards across two balanced domain
groups and can fan every pending shard out at once:

```bash
python -m data_module.ytd_backfill --year 2026 --parallel 14 --cap 50
```

This produces 14 shards through July 2026 (including the partial current month), with a
maximum of 700 unique work items before global URL deduplication. Per-shard summaries are
off; when all shards finish, the runner performs one authoritative graph refresh and one
grounded Luna summary. The 10 scam phrases are compressed into two Google `OR` query
groups to stay within search quotas. If SerpAPI returns an hourly-limit `429`, only that
query falls back to TinyFish Search; it remains resumable and can be rerun with a rotated
SerpAPI key. Use `--create-only` to inspect the jobs without running them.

## Campaign-link rules

Metrics retain every valid classification and indicator. Automatic campaign edges are
more conservative: only concrete (`specific_case=true`) `scam_report` or
`impersonation_abuse` documents with confidence at least `0.6` can link, and only
through these durable identifiers:

```text
bank_account, phone, email, domain, social_account, qr_payload,
transaction_reference, media_hash
```

URLs, money amounts, person/organization names, payment methods, and message templates
remain searchable evidence but never join campaigns automatically. Global refreshes are
authoritative: clusters that disappear after reclassification are deactivated immediately
instead of surviving until a later backfill.

## Supabase schema

For a clean database, run these files in order in the Supabase SQL editor:

1. `supabase/schema.sql`
2. `supabase/analytics_extension.sql`
3. `supabase/campaign_readiness.sql`
4. `supabase/campaign_clustering_guardrails.sql`

Core output tables:

| Area | Tables |
|---|---|
| Control | `crawl_jobs`, `crawl_items`, `crawl_events` |
| Evidence | `documents`, `document_discoveries`, `document_comments`, `media_evidence` |
| AI output | `classifications`, `indicators`, `document_indicators`, `provider_usage` |
| Live intelligence | `analysis_metrics`, `campaign_clusters`, `campaign_cluster_documents`, `campaigns`, `campaign_documents`, `campaign_indicators`, `anomalies`, `grounded_insights` |

## Tests

```bash
python -m pytest -q
```

The suite covers URL and indicator normalization, SerpAPI requests, TinyFish contracts,
OpenAI structured text/vision output, conservative clustering, persistence payloads and
end-to-end resumability.

## Honest limits

- “Everything” means public pages indexed by Google; private groups, private profiles,
  deleted posts and non-indexed content cannot be guaranteed.
- Some social sites return weak text or block fetches. Those documents and errors remain
  stored/retryable instead of disappearing.
- Multiple explicit workers are suitable for the hackathon, but live graph replacement
  is not a production transaction/locking design. Run one final refresh after all shards
  complete to make the last snapshot authoritative.
- Campaign membership is deterministic indicator linkage, not proof that every linked
  post was operated by the same criminal actor. Evidence URLs remain attached for review.
