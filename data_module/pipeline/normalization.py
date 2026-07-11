"""Deterministic normalization helpers for crawl and graph-ready data."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


VALID_CATEGORIES = frozenset(
    {
        "scam_report",
        "impersonation_abuse",
        "customer_feedback",
        "news_pr",
        "noise",
    }
)

VALID_INDICATOR_TYPES = frozenset(
    {
        "bank_account",
        "phone",
        "email",
        "domain",
        "url",
        "social_account",
        "person_alias",
        "organization_alias",
        "qr_payload",
        "transaction_reference",
        "payment_method",
        "money_amount",
        "media_hash",
        "message_template",
    }
)

_TYPE_ALIASES = {
    "account": "bank_account",
    "account_number": "bank_account",
    "bank_account_number": "bank_account",
    "telephone": "phone",
    "phone_number": "phone",
    "mobile": "phone",
    "e_mail": "email",
    "website": "domain",
    "link": "url",
    "social_profile": "social_account",
    "username": "social_account",
    "name": "person_alias",
    "company": "organization_alias",
    "organisation_alias": "organization_alias",
    "qr": "qr_payload",
    "qr_code": "qr_payload",
    "transaction_id": "transaction_reference",
    "amount": "money_amount",
    "image_hash": "media_hash",
    "script": "message_template",
}

_TRACKING_QUERY_KEYS = frozenset(
    {
        "fbclid",
        "gclid",
        "dclid",
        "msclkid",
        "mc_cid",
        "mc_eid",
        "ref_src",
        "igshid",
        "si",
    }
)

_PLATFORM_HOSTS = (
    ("facebook.com", "facebook"),
    ("fb.com", "facebook"),
    ("threads.net", "threads"),
    ("threads.com", "threads"),
    ("twitter.com", "x"),
    ("x.com", "x"),
    ("reddit.com", "reddit"),
    ("tiktok.com", "tiktok"),
    ("instagram.com", "instagram"),
    ("youtube.com", "youtube"),
    ("youtu.be", "youtube"),
)


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def collapse_whitespace(value: Any) -> str:
    """Trim and collapse all Unicode whitespace to a single space."""

    return re.sub(r"\s+", " ", _as_text(value)).strip()


def normalize_domain(value: Any) -> str:
    """Return a lower-case, IDNA domain without ``www.`` or a port."""

    text = _as_text(value)
    if not text:
        return ""
    candidate = text if "://" in text else "//" + text
    parsed = urlsplit(candidate)
    host = (parsed.hostname or "").rstrip(".").lower()
    if host.startswith("www."):
        host = host[4:]
    try:
        return host.encode("idna").decode("ascii")
    except UnicodeError:
        return host


def canonicalize_url(value: Any) -> str:
    """Build a stable URL for cross-run deduplication.

    The canonical form removes fragments and common campaign parameters, sorts
    the remaining query string, lower-cases the host, and removes default ports.
    It intentionally preserves content-significant query parameters.
    """

    text = _as_text(value)
    if not text:
        return ""
    if "://" not in text:
        text = "https://" + text.lstrip("/")
    parsed = urlsplit(text)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname:
        return ""

    host = parsed.hostname.rstrip(".").lower()
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        pass
    port = parsed.port
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = "%s:%s" % (host, port)

    path = quote(parsed.path or "", safe="/%:@!$&'()*+,;=-._~")
    if path == "/":
        path = ""
    elif path.endswith("/"):
        path = path.rstrip("/")

    query_items = []
    for key, item_value in parse_qsl(parsed.query, keep_blank_values=True):
        lowered = key.lower()
        if lowered.startswith("utm_") or lowered in _TRACKING_QUERY_KEYS:
            continue
        query_items.append((key, item_value))
    query_items.sort(key=lambda item: (item[0], item[1]))
    query = urlencode(query_items, doseq=True)
    return urlunsplit((scheme, host, path, query, ""))


def stable_hash(value: Any) -> str:
    """SHA-256 a string or JSON-compatible value deterministically."""

    if isinstance(value, bytes):
        payload = value
    elif isinstance(value, str):
        payload = value.encode("utf-8")
    else:
        payload = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def canonical_url_hash(value: Any) -> str:
    canonical = canonicalize_url(value)
    return stable_hash(canonical) if canonical else ""


def infer_platform(value: Any) -> str:
    host = normalize_domain(value)
    for suffix, platform in _PLATFORM_HOSTS:
        if host == suffix or host.endswith("." + suffix):
            return platform
    return "web"


def normalize_indicator_type(value: Any) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", _as_text(value).lower()).strip("_")
    return _TYPE_ALIASES.get(normalized, normalized)


def _normalize_phone(value: str) -> str:
    has_plus = value.lstrip().startswith("+")
    digits = "".join(character for character in value if character.isdigit())
    if not digits:
        return ""
    # Bank-side demo defaults to Vietnam. Converging +84 and 84 to a domestic
    # leading zero makes the graph join the most common equivalent forms.
    if digits.startswith("84") and len(digits) >= 10:
        digits = "0" + digits[2:]
    elif has_plus:
        digits = "+" + digits
    return digits


def _normalize_money(value: str) -> str:
    text = unicodedata.normalize("NFKC", value).strip()
    currency = ""
    lowered = text.casefold()
    if any(token in lowered for token in ("vnd", "vnđ", "₫", "đồng")) or lowered.endswith("đ"):
        currency = "VND"
    elif "$" in text or "usd" in lowered:
        currency = "USD"
    elif "eur" in lowered or "€" in text:
        currency = "EUR"

    numeric_match = re.search(r"[-+]?\d[\d.,\s]*", text)
    if not numeric_match:
        return collapse_whitespace(text).upper()
    numeric = re.sub(r"\s+", "", numeric_match.group(0))
    groups = re.split(r"[.,]", numeric)
    if len(groups) > 1 and all(len(group) == 3 for group in groups[1:] if group):
        numeric = "".join(groups)
    elif "," in numeric and "." not in numeric:
        numeric = numeric.replace(",", ".")
    elif "," in numeric and "." in numeric:
        last_separator = max(numeric.rfind(","), numeric.rfind("."))
        integer = re.sub(r"[.,]", "", numeric[:last_separator])
        numeric = integer + "." + numeric[last_separator + 1 :]
    try:
        amount = format(Decimal(numeric), "f")
        if "." in amount:
            amount = amount.rstrip("0").rstrip(".")
        if not amount or amount == "-":
            amount = "0"
    except InvalidOperation:
        amount = re.sub(r"[^0-9+-]", "", numeric)
    return (amount + (" " + currency if currency else "")).strip()


def normalize_indicator_value(indicator_type: Any, value: Any) -> str:
    """Normalize a value according to the graph indicator type."""

    kind = normalize_indicator_type(indicator_type)
    text = collapse_whitespace(value)
    if not text:
        return ""
    if kind == "phone":
        return _normalize_phone(text)
    if kind == "email":
        return text.casefold()
    if kind == "domain":
        return normalize_domain(text)
    if kind == "url":
        return canonicalize_url(text)
    if kind in {"bank_account", "transaction_reference"}:
        return re.sub(r"[^A-Za-z0-9]", "", unicodedata.normalize("NFKC", text)).upper()
    if kind == "social_account":
        return text.lstrip("@").casefold()
    if kind in {"person_alias", "organization_alias", "payment_method", "message_template"}:
        return text.casefold()
    if kind == "money_amount":
        return _normalize_money(text)
    if kind == "media_hash":
        return re.sub(r"^(sha(?:1|256|512):)", "", text.casefold())
    # QR payloads can be case-sensitive, so only whitespace is normalized.
    return text


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return _as_text(value).casefold() in {"1", "true", "yes", "y", "có", "co"}


def _bounded_number(value: Any, lower: float, upper: float, default: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = default
    return max(lower, min(upper, numeric))


def normalize_indicator(indicator: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """Return a storage-ready indicator or ``None`` for an unusable item."""

    kind = normalize_indicator_type(indicator.get("type"))
    if kind not in VALID_INDICATOR_TYPES:
        return None
    display_value = collapse_whitespace(indicator.get("value") or indicator.get("display_value"))
    normalized_value = normalize_indicator_value(
        kind,
        indicator.get("normalized_value") or display_value,
    )
    if not normalized_value:
        return None
    return {
        "type": kind,
        "value": display_value or normalized_value,
        "normalized_value": normalized_value,
        "evidence_source": collapse_whitespace(indicator.get("evidence_source")) or "unknown",
        "confidence": _bounded_number(indicator.get("confidence"), 0.0, 1.0, 1.0),
    }


def dedupe_indicators(indicators: Iterable[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """Normalize and deduplicate indicators, keeping the highest confidence."""

    by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for candidate in indicators:
        normalized = normalize_indicator(candidate)
        if not normalized:
            continue
        key = (normalized["type"], normalized["normalized_value"])
        previous = by_key.get(key)
        if previous is None or normalized["confidence"] > previous["confidence"]:
            by_key[key] = normalized
    return list(by_key.values())


def normalize_classification(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Coerce a provider JSON response into the downstream classification contract."""

    category = normalize_indicator_type(payload.get("primary_category"))
    if category not in VALID_CATEGORIES:
        category = "noise"

    raw_scam_types = payload.get("scam_types") or []
    raw_bank_roles = payload.get("bank_roles") or []
    if isinstance(raw_scam_types, str):
        raw_scam_types = [raw_scam_types]
    if isinstance(raw_bank_roles, str):
        raw_bank_roles = [raw_bank_roles]

    scam_types = sorted(
        {
            normalize_indicator_type(item)
            for item in raw_scam_types
            if normalize_indicator_type(item)
        }
    )
    bank_roles = sorted(
        {
            normalize_indicator_type(item)
            for item in raw_bank_roles
            if normalize_indicator_type(item)
        }
    )
    raw_indicators = payload.get("indicators") or []
    if not isinstance(raw_indicators, list):
        raw_indicators = []

    return {
        "primary_category": category,
        "scam_types": scam_types,
        "bank_roles": bank_roles,
        "specific_case": _coerce_bool(payload.get("specific_case")),
        "first_person_report": _coerce_bool(payload.get("first_person_report")),
        "summary": collapse_whitespace(payload.get("summary")),
        "severity": int(round(_bounded_number(payload.get("severity"), 1.0, 5.0, 1.0))),
        "confidence": _bounded_number(payload.get("confidence"), 0.0, 1.0, 0.0),
        "indicators": dedupe_indicators(
            item for item in raw_indicators if isinstance(item, Mapping)
        ),
    }
