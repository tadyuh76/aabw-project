const ELIGIBLE_CATEGORIES = new Set(["scam_report", "impersonation_abuse"]);
const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "igshid",
  "si",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RAW_LENGTH = 4000;
const MAX_EDGE_ROWS = 500;
const MAX_MESSAGE_TEMPLATES = 500;
const FUZZY_MESSAGE_THRESHOLD = 0.82;
const MIN_CLASSIFICATION_CONFIDENCE = 0.6;
const MAX_PUBLIC_SOURCES = 3;

export class CheckEvidenceError extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.name = "CheckEvidenceError";
    this.status = status;
  }
}

function invalid(message = "Invalid evidence") {
  throw new CheckEvidenceError(message, { status: 400 });
}

export function collapseWhitespace(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ");
}

// JavaScript does not expose Unicode casefold directly. These two replacements
// cover the material differences for the Latin/Greek text likely to reach this
// product while preserving Vietnamese diacritics.
export function casefold(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/\u00df/gu, "ss")
    .replace(/\u03c2/gu, "\u03c3");
}

export function normalizePhone(value) {
  const text = collapseWhitespace(value);
  const hasPlus = text.startsWith("+");
  const digits = Array.from(text)
    .filter((character) => /\p{Nd}/u.test(character))
    .join("");
  if (!digits) return "";
  if (digits.startsWith("84") && digits.length >= 10) {
    return `0${digits.slice(2)}`;
  }
  return hasPlus ? `+${digits}` : digits;
}

export function normalizeBankAccount(value) {
  return collapseWhitespace(value)
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9]/gu, "")
    .toUpperCase();
}

export function defangLink(value) {
  return collapseWhitespace(value)
    .replace(/^hxxps:\/\//iu, "https://")
    .replace(/^hxxp:\/\//iu, "http://")
    .replace(/^https?\[:\]\/\//iu, (match) =>
      match.toLowerCase().startsWith("https") ? "https://" : "http://",
    )
    .replace(/\[\.\]|\(\.\)|\{\.\}/gu, ".");
}

function encodeQueryPart(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/gu, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/%20/gu, "+");
}

export function canonicalizeUrl(value) {
  let text = defangLink(value);
  if (!text) return "";
  if (!text.includes("://")) text = `https://${text.replace(/^\/+/, "")}`;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return "";
  if (!parsed.hostname || parsed.username || parsed.password) return "";

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!hostname) return "";
  const host = `${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  let path = parsed.pathname || "";
  if (path === "/") path = "";
  else path = path.replace(/\/+$/u, "");

  const queryItems = Array.from(parsed.searchParams.entries())
    .filter(([key]) => {
      const lowered = key.toLowerCase();
      return !lowered.startsWith("utm_") && !TRACKING_QUERY_KEYS.has(lowered);
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    );
  const query = queryItems
    .map(([key, itemValue]) => `${encodeQueryPart(key)}=${encodeQueryPart(itemValue)}`)
    .join("&");
  return `${parsed.protocol}//${host}${path}${query ? `?${query}` : ""}`;
}

export function normalizeDomain(value) {
  const canonical = canonicalizeUrl(value);
  if (!canonical) return "";
  const hostname = new URL(canonical).hostname.toLowerCase().replace(/\.$/u, "");
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

function looksLikePhone(value) {
  const text = collapseWhitespace(value);
  if (!/^\+?[\p{Nd}\s().-]+$/u.test(text)) return false;
  const digitCount = Array.from(text).filter((character) => /\p{Nd}/u.test(character)).length;
  return digitCount >= 7 && digitCount <= 15;
}

function looksLikeLink(value) {
  const text = defangLink(value);
  if (!text || /\s/u.test(text)) return false;
  if (/^(?:https?:\/\/|www\.)/iu.test(text)) return true;
  return /^(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?(?:[/?#]|$)/u.test(text);
}

const TYPE_ALIASES = {
  phone: "phone",
  telephone: "phone",
  number: "number",
  bank_account: "bank_account",
  account: "bank_account",
  account_number: "bank_account",
  url: "link",
  link: "link",
  domain: "link",
  message: "message",
  text: "message",
};

export function normalizeEvidenceInput(value, requestedType) {
  if (typeof value !== "string") invalid();
  const raw = value.trim();
  if (!raw || raw.length > MAX_RAW_LENGTH) invalid();

  let type;
  if (requestedType != null && requestedType !== "") {
    type = TYPE_ALIASES[String(requestedType).trim().toLowerCase()];
    if (!type) invalid("Unsupported evidence type");
  } else if (looksLikePhone(raw)) {
    // A bare numeric value is ambiguous: Vietnamese phone numbers and bank
    // accounts commonly share the same lengths. Query both exact indicator
    // kinds and prefer phone evidence when both are eligible.
    type = "number";
  } else if (looksLikeLink(raw)) {
    type = "link";
  } else {
    type = "message";
  }

  if (type === "phone" || type === "number") {
    if (raw.length > 80 || !looksLikePhone(raw)) invalid("Invalid phone number");
    const normalizedPhone = normalizePhone(raw);
    const digitCount = normalizedPhone.replace(/\D/gu, "").length;
    if (digitCount < 7 || digitCount > 15) invalid("Invalid phone number");
    const candidates = [
      {
        kind: "phone",
        normalizedValue: normalizedPhone,
        matchMode: "exact",
        similarity: 1,
      },
    ];
    if (type === "number") {
      candidates.push({
        kind: "bank_account",
        normalizedValue: normalizeBankAccount(raw),
        matchMode: "exact",
        similarity: 1,
      });
    }
    return {
      checkedType: type === "number" ? "number" : "phone",
      candidates,
    };
  }

  if (type === "bank_account") {
    if (raw.length > 80) invalid("Invalid account number");
    const normalizedValue = normalizeBankAccount(raw);
    if (normalizedValue.length < 6 || normalizedValue.length > 34) {
      invalid("Invalid account number");
    }
    return {
      checkedType: "number",
      candidates: [
        { kind: "bank_account", normalizedValue, matchMode: "exact", similarity: 1 },
      ],
    };
  }

  if (type === "link") {
    if (raw.length > 2048) invalid("Invalid link");
    const canonicalUrl = canonicalizeUrl(raw);
    const domain = normalizeDomain(raw);
    if (!canonicalUrl || !domain || domain.length > 253) invalid("Invalid link");
    return {
      checkedType: "link",
      candidates: [
        { kind: "url", normalizedValue: canonicalUrl, matchMode: "exact", similarity: 1 },
        { kind: "domain", normalizedValue: domain, matchMode: "domain", similarity: 1 },
      ],
    };
  }

  const normalizedValue = casefold(raw);
  if (normalizedValue.length < 8) invalid("Message is too short to check reliably");
  return {
    checkedType: "message",
    message: normalizedValue,
  };
}

function messageTokens(value) {
  return casefold(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length >= 2);
}

function trigrams(value) {
  const compact = casefold(value).replace(/\s+/gu, " ");
  const result = new Set();
  for (let index = 0; index <= compact.length - 3; index += 1) {
    result.add(compact.slice(index, index + 3));
  }
  return result;
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

export function scoreMessageSimilarity(input, template) {
  const left = casefold(input);
  const right = casefold(template);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  const shortTokens = new Set(messageTokens(shorter));
  if (
    shorter.length >= 24 &&
    shortTokens.size >= 4 &&
    longer.includes(shorter)
  ) {
    const lengthRatio = shorter.length / longer.length;
    return Math.min(0.97, 0.88 + lengthRatio * 0.09);
  }

  const leftTokens = new Set(messageTokens(left));
  const rightTokens = new Set(messageTokens(right));
  if (leftTokens.size < 4 || rightTokens.size < 4) return 0;
  const tokenIntersection = intersectionSize(leftTokens, rightTokens);
  const tokenUnion = leftTokens.size + rightTokens.size - tokenIntersection;
  const tokenContainment = tokenIntersection / Math.min(leftTokens.size, rightTokens.size);
  const tokenJaccard = tokenIntersection / tokenUnion;

  const leftTrigrams = trigrams(left);
  const rightTrigrams = trigrams(right);
  const trigramIntersection = intersectionSize(leftTrigrams, rightTrigrams);
  const trigramDice =
    leftTrigrams.size + rightTrigrams.size
      ? (2 * trigramIntersection) / (leftTrigrams.size + rightTrigrams.size)
      : 0;

  if (
    tokenIntersection < 4 ||
    tokenContainment < 0.8 ||
    tokenJaccard < 0.6 ||
    trigramDice < 0.72
  ) {
    return 0;
  }
  return Math.min(0.99, tokenContainment * 0.35 + tokenJaccard * 0.25 + trigramDice * 0.4);
}

function asRows(value, field) {
  if (!Array.isArray(value)) {
    throw new CheckEvidenceError(`Invalid ${field} response`);
  }
  return value;
}

function validUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function uniqueUuids(values, field) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (!validUuid(value)) throw new CheckEvidenceError(`Invalid ${field}`);
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function inFilter(values) {
  return `in.(${values.join(",")})`;
}

function numeric(value, minimum, maximum, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function isoTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeLabel(value, maximumLength) {
  const text = collapseWhitespace(value);
  return text ? text.slice(0, maximumLength) : "";
}

function publicUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function makeSupabaseClient({ fetchImpl, supabaseUrl, serviceRoleKey, signal }) {
  let baseUrl;
  try {
    baseUrl = new URL(supabaseUrl);
  } catch {
    throw new CheckEvidenceError("Evidence check is not configured", { status: 503 });
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new CheckEvidenceError("Evidence check is not configured", { status: 503 });
  }

  const headers = {
    Accept: "application/json",
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  return async function select(table, params) {
    const url = new URL(`/rest/v1/${table}`, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        headers,
        signal,
      });
    } catch (error) {
      if (error instanceof CheckEvidenceError) throw error;
      throw new CheckEvidenceError("Evidence lookup request failed");
    }
    if (!response?.ok) {
      throw new CheckEvidenceError("Evidence lookup request failed");
    }
    try {
      return asRows(await response.json(), table);
    } catch (error) {
      if (error instanceof CheckEvidenceError) throw error;
      throw new CheckEvidenceError("Evidence lookup response is invalid");
    }
  };
}

async function findExactIndicator(select, candidate) {
  const rows = await select("indicators", {
    select: "id,kind,normalized_value",
    kind: `eq.${candidate.kind}`,
    normalized_value: `eq.${candidate.normalizedValue}`,
    limit: 2,
  });
  const valid = rows.filter(
    (row) =>
      validUuid(row?.id) &&
      row.kind === candidate.kind &&
      row.normalized_value === candidate.normalizedValue,
  );
  if (valid.length > 1) throw new CheckEvidenceError("Indicator lookup is ambiguous");
  return valid[0] ? { ...valid[0], ...candidate } : null;
}

async function findMessageIndicators(select, message) {
  const rows = await select("indicators", {
    select: "id,kind,normalized_value",
    kind: "eq.message_template",
    order: "created_at.desc",
    limit: MAX_MESSAGE_TEMPLATES,
  });
  return rows
    .filter(
      (row) =>
        validUuid(row?.id) &&
        row.kind === "message_template" &&
        typeof row.normalized_value === "string",
    )
    .map((row) => ({
      ...row,
      similarity: scoreMessageSimilarity(message, row.normalized_value),
    }))
    .filter((row) => row.similarity >= FUZZY_MESSAGE_THRESHOLD)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 5)
    .map((row) => ({
      ...row,
      matchMode: row.similarity === 1 ? "exact" : "fuzzy",
    }));
}

async function loadTopCluster(select, documentIds) {
  try {
    const memberships = await select("campaign_cluster_documents", {
      select: "cluster_id,document_id,membership_score",
      document_id: inFilter(documentIds),
      limit: MAX_EDGE_ROWS,
    });
    const usableMemberships = memberships.filter(
      (row) => validUuid(row?.cluster_id) && documentIds.includes(row.document_id),
    );
    const clusterIds = uniqueUuids(
      usableMemberships.map((row) => row.cluster_id),
      "cluster id",
    );
    if (!clusterIds.length) return null;

    const clusters = await select("campaign_clusters", {
      select:
        "id,label,risk_score,document_count,indicator_count,maximum_severity,average_confidence,first_seen_at,last_seen_at",
      id: inFilter(clusterIds),
      is_active: "eq.true",
      limit: clusterIds.length,
    });
    const ranked = clusters
      .filter((row) => validUuid(row?.id))
      .map((row) => ({
        row,
        matchedDocuments: new Set(
          usableMemberships
            .filter((membership) => membership.cluster_id === row.id)
            .map((membership) => membership.document_id),
        ).size,
      }))
      .sort(
        (left, right) =>
          right.matchedDocuments - left.matchedDocuments ||
          numeric(right.row.risk_score, 0, 100) - numeric(left.row.risk_score, 0, 100),
      );
    if (!ranked.length) return null;

    const { row, matchedDocuments } = ranked[0];
    return {
      id: row.id,
      label: safeLabel(row.label, 100) || "Linked scam campaign",
      matchedDocumentCount: matchedDocuments,
      riskScore: numeric(row.risk_score, 0, 100),
      documentCount: Math.trunc(numeric(row.document_count, 0, Number.MAX_SAFE_INTEGER)),
      indicatorCount: Math.trunc(numeric(row.indicator_count, 0, Number.MAX_SAFE_INTEGER)),
      maximumSeverity: Math.trunc(numeric(row.maximum_severity, 0, 5)),
      averageConfidence: numeric(row.average_confidence, 0, 1),
      firstSeen: isoTimestamp(row.first_seen_at),
      lastSeen: isoTimestamp(row.last_seen_at),
    };
  } catch {
    // Campaign analytics are an optional enrichment. Core evidence remains
    // usable when the extension is absent or temporarily unavailable.
    return null;
  }
}

async function loadIndicatorEvidence(select, indicator) {
  const edges = await select("document_indicators", {
    select: "document_id,classification_id,evidence_source,confidence,created_at",
    indicator_id: `eq.${indicator.id}`,
    order: "created_at.desc",
    limit: MAX_EDGE_ROWS,
  });
  const documentIds = uniqueUuids(
    edges.map((edge) => edge?.document_id),
    "evidence document id",
  );
  if (!documentIds.length) return null;

  const classificationRows = await select("classifications", {
    select:
      "id,document_id,primary_category,scam_types,severity,confidence,created_at",
    document_id: inFilter(documentIds),
    primary_category: "in.(scam_report,impersonation_abuse)",
    confidence: `gte.${MIN_CLASSIFICATION_CONFIDENCE}`,
    limit: documentIds.length,
  });
  const classifications = classificationRows.filter(
    (row) =>
      validUuid(row?.id) &&
      documentIds.includes(row.document_id) &&
      ELIGIBLE_CATEGORIES.has(row.primary_category) &&
      numeric(row.confidence, 0, 1) >= MIN_CLASSIFICATION_CONFIDENCE,
  );
  if (!classifications.length) return null;

  const eligibleDocumentIds = uniqueUuids(
    classifications.map((row) => row.document_id),
    "classified document id",
  );
  const documents = await select("documents", {
    select:
      "id,canonical_url,platform,title,published_at,first_seen_at,last_seen_at,created_at",
    id: inFilter(eligibleDocumentIds),
    limit: eligibleDocumentIds.length,
  });
  const documentsById = new Map(
    documents
      .filter((row) => validUuid(row?.id) && eligibleDocumentIds.includes(row.id))
      .map((row) => [row.id, row]),
  );

  const categories = [...new Set(classifications.map((row) => row.primary_category))].sort();
  const scamTypes = [
    ...new Set(
      classifications.flatMap((row) =>
        Array.isArray(row.scam_types)
          ? row.scam_types
              .map((value) => safeLabel(value, 80))
              .filter(Boolean)
          : [],
      ),
    ),
  ].sort().slice(0, 12);
  const confidences = classifications.map((row) => numeric(row.confidence, 0, 1));
  const maximumSeverity = Math.max(
    ...classifications.map((row) => Math.trunc(numeric(row.severity, 0, 5))),
  );
  const averageConfidence =
    confidences.reduce((sum, value) => sum + value, 0) / confidences.length;

  const allSources = eligibleDocumentIds
    .map((documentId) => {
      const document = documentsById.get(documentId);
      if (!document) return null;
      const url = publicUrl(document.canonical_url);
      if (!url) return null;
      return {
        platform: safeLabel(document.platform, 40) || new URL(url).hostname,
        title: safeLabel(document.title, 180) || "Public scam report",
        url,
        observedAt:
          isoTimestamp(document.published_at) ||
          isoTimestamp(document.first_seen_at) ||
          isoTimestamp(document.created_at),
      };
    })
    .filter(Boolean)
    .filter(
      (source, index, array) =>
        array.findIndex((candidate) => candidate.url === source.url) === index,
    )
    .sort((left, right) =>
      String(right.observedAt || "").localeCompare(String(left.observedAt || "")),
    );

  const firstSeenCandidates = classifications.flatMap((classification) => {
    const document = documentsById.get(classification.document_id);
    return [
      isoTimestamp(document?.published_at),
      isoTimestamp(document?.first_seen_at),
      isoTimestamp(classification.created_at),
    ].filter(Boolean);
  });
  const firstSeen = firstSeenCandidates.sort()[0] || null;
  const cluster = await loadTopCluster(select, eligibleDocumentIds);

  return {
    matchedKind: indicator.kind,
    matchMode: indicator.matchMode,
    similarity: Number(indicator.similarity.toFixed(4)),
    evidenceDocumentCount: eligibleDocumentIds.length,
    sourceCount: allSources.length,
    maximumSeverity,
    averageConfidence: Number(averageConfidence.toFixed(4)),
    firstSeen,
    categories,
    scamTypes,
    ...(cluster ? { cluster } : {}),
    sources: allSources.slice(0, MAX_PUBLIC_SOURCES),
  };
}

export async function checkEvidence({
  value,
  type,
  fetchImpl = fetch,
  supabaseUrl,
  serviceRoleKey,
  timeoutMs = 6000,
} = {}) {
  const normalized = normalizeEvidenceInput(value, type);
  if (!supabaseUrl || !serviceRoleKey) {
    throw new CheckEvidenceError("Evidence check is not configured", { status: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const select = makeSupabaseClient({
    fetchImpl,
    supabaseUrl,
    serviceRoleKey,
    signal: controller.signal,
  });

  try {
    const indicators = normalized.message
      ? await findMessageIndicators(select, normalized.message)
      : (
          await Promise.all(
            normalized.candidates.map((candidate) => findExactIndicator(select, candidate)),
          )
        ).filter(Boolean);

    for (const indicator of indicators) {
      const match = await loadIndicatorEvidence(select, indicator);
      if (match) {
        return {
          status: "match",
          checked: { type: normalized.checkedType },
          match,
        };
      }
    }
    return { status: "no_match", checked: { type: normalized.checkedType } };
  } catch (error) {
    if (error instanceof CheckEvidenceError) throw error;
    throw new CheckEvidenceError("Evidence check failed");
  } finally {
    clearTimeout(timeout);
  }
}
