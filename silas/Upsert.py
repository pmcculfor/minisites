"""Bloomerang to Salesforce NPC migration pipeline.

This module provides a reusable ETL pipeline for moving a Bloomerang export into
Salesforce NPC via Bulk API 2.0. The script is intentionally modular and idempotent,
so it can be used for an initial migration and a later delta/cutover run.

Key design decisions:
- all writes are upserts keyed by a Bloomerang external ID
- customer records are sampled or loaded in parent-first order
- child rows are derived by foreign key relationships to sampled or live constituents
- Salesforce object names and field API names are managed through config dictionaries

The org-specific field names for the target Salesforce objects must be confirmed in the
real org before a live migration. The defaults provided here assume custom fields such as:
- Bloomerang_ID__c
- Bloomerang_Transaction_ID__c
- Bloomerang_Email_Key__c
- Bloomerang_Phone_Key__c
- Bloomerang_Address_Key__c

The script can be run in dry-run mode without Salesforce credentials so you can validate
transforms before hitting a sandbox or production org.

Live runs default to sandbox (SF_DOMAIN=test) and refuse production unless --production
is passed. ContentNotes that already exist (matched on Title) are skipped. Recurring
schedules that already exist keep their Salesforce Type so a refresh cannot re-pause them.
"""

from __future__ import annotations

import argparse
import base64
import csv
import html
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
from simple_salesforce import Salesforce

logger = logging.getLogger("bloomerang_to_sf")

DEFAULT_INPUT_DIR = Path(__file__).resolve().parent / "DataExport-2026-08-17"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent / "migration-output"
DEFAULT_MAPPING_FILE = Path(__file__).resolve().parent / "field_mapping.csv"

# Load a local .env file if present; session-level env vars always take precedence (setdefault).
_env_file = Path(__file__).resolve().parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))
    # Credentials stay in process memory only; never log values from this file.


def _instance_url_looks_like_production(instance_url: str) -> bool:
    """Treat sandbox / test hosts as non-production; everything else on Salesforce is production."""
    host = instance_url.lower()
    sandbox_markers = ("sandbox", "test.salesforce.com", ".cs", "scratch")
    if any(marker in host for marker in sandbox_markers):
        return False
    return "salesforce.com" in host or "cloudforce.com" in host or "site.com" in host


@dataclass
class SalesforceConfig:
    username: str = ""
    password: str = ""
    security_token: str = ""
    domain: str = "test"
    instance_url: str = ""
    session_id: str = ""

    @classmethod
    def from_env(cls, allow_production: bool = False) -> "SalesforceConfig":
        # Prefer session token auth – avoids SOAP login which is disabled in many modern orgs.
        # Get SF_SESSION_ID from Workbench (https://workbench.developerforce.com) or your
        # browser's Network tab after logging in: look for the Authorization: Bearer <token> header.
        instance_url = os.getenv("SF_INSTANCE_URL", "")
        session_id = os.getenv("SF_SESSION_ID", "")
        if instance_url and session_id:
            if _instance_url_looks_like_production(instance_url) and not allow_production:
                raise ValueError(
                    "SF_INSTANCE_URL looks like a production org. Re-run with --production if you "
                    "intentionally want to write to the live org."
                )
            logger.info("Connecting via SF_INSTANCE_URL + SF_SESSION_ID.")
            return cls(instance_url=instance_url, session_id=session_id)

        username = os.getenv("SF_USERNAME", "")
        password = os.getenv("SF_PASSWORD", "")
        security_token = os.getenv("SF_SECURITY_TOKEN", "")
        domain = os.getenv("SF_DOMAIN", "test")

        if not username or not password:
            raise ValueError(
                "Set SF_INSTANCE_URL + SF_SESSION_ID (recommended for orgs with SOAP login disabled), "
                "or SF_USERNAME + SF_PASSWORD [+ SF_SECURITY_TOKEN] [+ SF_DOMAIN=test|login]."
            )
        if domain == "login" and not allow_production:
            raise ValueError(
                "Salesforce production (SF_DOMAIN=login) is blocked unless you pass --production. "
                "For a sandbox, set SF_DOMAIN=test (the default)."
            )
        return cls(username=username, password=password, security_token=security_token, domain=domain)

    def connect(self) -> Salesforce:
        if self.session_id and self.instance_url:
            return Salesforce(instance_url=self.instance_url, session_id=self.session_id)
        return Salesforce(
            username=self.username,
            password=self.password,
            security_token=self.security_token,
            domain=self.domain,
        )


def configure_logging(verbose: bool = False, log_dir: Path | None = None) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_dir:
        log_dir.mkdir(parents=True, exist_ok=True)
        ts = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
        file_handler = logging.FileHandler(log_dir / f"upsert_{ts}.log", encoding="utf-8")
        handlers.append(file_handler)
    logging.basicConfig(level=level, format="%(asctime)s | %(levelname)s | %(message)s", handlers=handlers)


def normalize_identifier_series(series: pd.Series) -> pd.Series:
    """Normalize the string IDs used across Bloomerang CSVs.

    Also strips a trailing ".0" so IDs that pandas once inferred as floats
    (AccountNumber 12345 becoming "12345.0") still match the other files.
    """
    normalized = series.astype("string")
    normalized = normalized.str.strip()
    float_like = normalized.str.match(r"^-?\d+\.0+$", na=False)
    normalized = normalized.where(~float_like, normalized.str.replace(r"\.0+$", "", regex=True))
    normalized = normalized.replace({"": pd.NA, "nan": pd.NA, "NaN": pd.NA, "None": pd.NA, "<NA>": pd.NA})
    return normalized


def parse_iso_date(value: Any) -> str | None:
    """Format a datetime for Salesforce.

    Calendar dates (no time) are sent as noon UTC so a US timezone does not
    roll the gift to the previous evening. Timed values are converted to UTC.
    """
    if pd.isna(value):
        return None
    try:
        text = str(value).strip()
        parsed = pd.to_datetime(value, errors="coerce")
        if pd.isna(parsed):
            return None
        date_only = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", text)) or (
            "T" not in text
            and ":" not in text
            and getattr(parsed, "hour", 0) == 0
            and parsed.minute == 0
            and parsed.second == 0
        )
        if date_only:
            return parsed.strftime("%Y-%m-%dT12:00:00.000Z")
        if parsed.tzinfo is not None:
            parsed = parsed.tz_convert("UTC")
        else:
            parsed = parsed.tz_localize("UTC")
        return parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    except Exception:
        return None


def parse_date_only(value: Any) -> str | None:
    if pd.isna(value):
        return None
    try:
        parsed = pd.to_datetime(value, errors="coerce")
        if pd.isna(parsed):
            return None
        return parsed.strftime("%Y-%m-%d")
    except Exception:
        return None


def clean_phone(value: Any) -> str | None:
    if pd.isna(value):
        return None
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if not digits:
        return None
    return digits


def clean_email(value: Any) -> str | None:
    if pd.isna(value):
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    return text


def split_street_lines(value: Any) -> tuple[str | None, str | None]:
    """Split a multi-line street address into (line 1, line 2) on the first line break."""
    if pd.isna(value):
        return None, None
    parts = re.split(r"\r\n|\r|\n", str(value), maxsplit=1)
    line1 = parts[0].strip() or None
    line2 = (parts[1].strip() if len(parts) > 1 else None) or None
    return line1, line2


# Maps Bloomerang constituent Type to the Salesforce Account address category.
# Individuals get Mailing address line fields; orgs/households get Shipping.
CONSTITUENT_TYPE_TO_ADDRESS_CATEGORY: dict[str, str] = {
    "Individual": "Mailing",
    "Organization": "Shipping",
    "Household": "Shipping",
}

# Kept as a TypeName-based fallback in case constituent data is unavailable.
ADDRESS_TYPE_TO_CATEGORY: dict[str, str] = {
    "Home": "Mailing",
    "Work": "Billing",
    "Vacation": "Shipping",
}

# Account field API names for each address category's split street lines.
ACCOUNT_ADDRESS_LINE_FIELDS: dict[str, tuple[str, str]] = {
    "Billing": ("Billing_Address_Line_1__c", "Billing_Address_Line_2__c"),
    "Mailing": ("Mailing_Address_Line_1__c", "Mailing_Address_Line_2__c"),
    "Shipping": ("Shipping_Address_Line_1__c", "Shipping_Address_Line_2__c"),
}


def clean_name(row: pd.Series) -> str | None:
    candidates = [
        row.get("FullName"),
        row.get("FormalName"),
        row.get("EnvelopeName"),
        row.get("RecognitionName"),
        row.get("SortName"),
        row.get("First"),
        row.get("Last"),
    ]
    for value in candidates:
        if pd.notna(value) and str(value).strip():
            if isinstance(value, str):
                return value.strip()
            return str(value).strip()

    first = row.get("First")
    last = row.get("Last")
    if pd.notna(first) or pd.notna(last):
        pieces = [str(first).strip() if pd.notna(first) else "", str(last).strip() if pd.notna(last) else ""]
        final = " ".join(piece for piece in pieces if piece)
        if final:
            return final
    return None


# External ID field for each SF target object – used as the upsert key.
# Update values to match the actual custom field API names confirmed in your org.
EXTERNAL_ID_FIELDS: dict[str, str] = {
    "Account": "Bloomerang_ID__c",
    "ContactPointEmail": "Bloomerang_Email_Key__c",
    "ContactPointPhone": "Bloomerang_Phone_Key__c",
    "ContactPointAddress": "Bloomerang_Address_Key__c",
    "Campaign": "Bloomerang_Appeal_ID__c",
    "GiftDesignation": "Bloomerang_Fund_ID__c",
    "GiftTransaction": "Bloomerang_Transaction_ID__c",
    "GiftCommitment": "Bloomerang_Commitment_ID__c",
    "GiftSoftCredit": "Bloomerang_SoftCredit_Key__c",
    "GiftCommitmentSchedule": "Bloomerang_Recurring_Schedule_ID__c",
    # Requires Bloomerang_TxnDesignation_Key__c custom Text (External ID) field on GiftTransactionDesignation.
    "GiftTransactionDesignation": "Bloomerang_TxnDesignation_Key__c",
}

# When left-joining a secondary Bloomerang table into a primary one, use this column.
_TABLE_JOIN_KEY: dict[str, str] = {
    "Donations": "TransactionNumber",
    "PledgePayments": "TransactionNumber",
    "RecurringDonationPayments": "TransactionNumber",
    "RecurringDonations": "TransactionNumber",
    "Pledges": "TransactionNumber",
    "Transactions": "TransactionNumber",
    "Refunds": "TransactionNumber",
}

# Secondary tables that can have many rows per join key. Aggregate before join so
# GiftTransaction (and similar parents) are not exploded and then silently deduped.
_ONE_TO_MANY_JOIN_TABLES = {"Donations"}

# ContactPointAddress AddressType uses Salesforce Billing/Shipping values.
# Account custom line fields use Mailing/Shipping (see CONSTITUENT_TYPE_TO_ADDRESS_CATEGORY).
CONTACT_POINT_ADDRESS_TYPE_BY_CONSTITUENT: dict[str, str] = {
    "Individual": "Billing",
    "Organization": "Shipping",
    "Household": "Shipping",
}


def _first_non_null(series: pd.Series):
    for value in series:
        if pd.notna(value) and str(value).strip() != "":
            return value
    return pd.NA


def _join_unique_text(series: pd.Series):
    parts: list[str] = []
    seen: set[str] = set()
    for value in series:
        if pd.isna(value):
            continue
        text = str(value).strip()
        if text and text not in seen:
            seen.add(text)
            parts.append(text)
    return "\n".join(parts) if parts else pd.NA


def aggregate_one_to_many(df: pd.DataFrame, key: str, table_name: str) -> pd.DataFrame:
    """Collapse many child rows onto one parent key, keeping the first non-blank value.

    Note columns are concatenated so split-gift comments are not thrown away.
    """
    if df.empty or key not in df.columns:
        return df
    df = df.copy()
    df[key] = normalize_identifier_series(df[key])
    before = len(df)
    unique_keys = df[key].nunique(dropna=True)
    if before <= unique_keys:
        return df
    agg_cols: dict[str, Any] = {}
    for col in df.columns:
        if col == key:
            continue
        if "note" in col.lower():
            agg_cols[col] = _join_unique_text
        else:
            agg_cols[col] = _first_non_null
    out = df.groupby(key, as_index=False).agg(agg_cols)
    logger.warning(
        "Collapsed %s %s rows onto %s unique %s values so a 1:N join cannot explode the parent object.",
        before - len(out),
        table_name,
        len(out),
        key,
    )
    return out


def _composite_part_value(row: pd.Series, col: str) -> str:
    """Normalize one piece of a composite external ID the same way as the mapped field."""
    if col not in row.index or pd.isna(row[col]):
        return ""
    raw = row[col]
    if col in {"Number", "TelephoneNumber"}:
        return clean_phone(raw) or ""
    if col in {"Value", "EmailAddress"}:
        return clean_email(raw) or ""
    if col == "Street":
        return re.sub(r"\s+", " ", str(raw).replace("\r", " ").replace("\n", " ")).strip()
    return str(raw).strip()


def drop_is_bad_rows(df: pd.DataFrame, table_name: str) -> pd.DataFrame:
    if df.empty or "IsBad" not in df.columns:
        return df
    flag = df["IsBad"].astype("string").str.strip().str.lower()
    bad = flag.isin(["true", "1", "yes", "y"])
    dropped = int(bad.sum())
    if dropped:
        logger.warning("Dropping %s %s rows marked IsBad.", dropped, table_name)
        return df.loc[~bad].copy()
    return df


def read_bloomerang_csv(path: Path) -> pd.DataFrame:
    """Read a Bloomerang export table with all columns as text so IDs stay stable."""
    df = pd.read_csv(path, dtype=str, keep_default_na=False, low_memory=False)
    return df.replace({"": pd.NA})


def apply_transform(
    series: pd.Series,
    transform: str,
    lookup_maps: dict[str, dict[str, str]],
) -> pd.Series | None:
    """Apply one field-level transform from the field_mapping.csv DSL to a Series.

    DSL reference:
      identity              no transform
      date_only              ISO date string YYYY-MM-DD
      date_iso               ISO datetime string
      clean_phone            digits only
      clean_email            strip whitespace
      map:a=b;c=d            replace picklist values (unknown values pass through unchanged)
      multiselect            convert Bloomerang "|" separators to Salesforce ";" multi-select syntax
      lookup:<Key>           map a Bloomerang key to a Salesforce Id via lookup_maps["<Key>"]
                             (e.g. lookup:Account, lookup:Campaign, lookup:Designation)
      const:VALUE            replace the entire column with a hardcoded constant
      filter_startswith:P     omit values that start with prefix P (used for Admin_Notes__c)
      skip / composite /      handled upstream (e.g. by a dedicated Python builder); returns
        split_lines /          None to signal "omit this field" from the generic engine
        fund_flags /
        refund_flags /
        name_convention
    """
    t = (transform or "identity").strip()
    if t in ("skip", "SKIP", "composite", "split_lines", "fund_flags", "refund_flags", "name_convention"):
        return None
    if t == "identity":
        return series
    if t == "date_iso":
        return series.map(parse_iso_date)
    if t == "date_only":
        return series.map(parse_date_only)
    if t == "clean_phone":
        return series.map(clean_phone)
    if t == "clean_email":
        return series.map(clean_email)
    if t.startswith("map:"):
        value_map: dict[str, str] = {}
        for pair in t[4:].split(";"):
            if "=" in pair:
                k, _, v = pair.partition("=")
                value_map[k.strip()] = v.strip()
        def _apply_map(x, _m=value_map):
            if pd.isna(x):
                return pd.NA
            mapped = _m.get(str(x).strip())
            if mapped is None:
                return str(x)  # pass through unknown values unchanged
            return pd.NA if mapped.lower() == "null" else mapped  # "null" in map → omit field
        return series.map(_apply_map)
    if t == "xxxx_empty":
        # "XXXX" (case-insensitive) → empty string; all other values pass through unchanged.
        return series.map(lambda x: "" if pd.notna(x) and str(x).strip().upper() == "XXXX" else x)
    if t == "xxxx_unknown":
        # "XXXX" (case-insensitive) → "[Unknown]"; all other values pass through unchanged.
        return series.map(lambda x: "[Unknown]" if pd.notna(x) and str(x).strip().upper() == "XXXX" else x)
    if t == "multiselect":
        # Salesforce multi-select picklists use ";" as the value separator; Bloomerang uses "|".
        def _to_multiselect(x):
            if pd.isna(x):
                return pd.NA
            parts = [p.strip() for p in str(x).split("|") if p.strip()]
            return ";".join(parts) if parts else pd.NA
        return series.map(_to_multiselect)
    if t == "enddate_notnull":
        # Non-null/non-empty EndDate → "FixedLength"; null/empty → "OpenEnded".
        return series.map(lambda x: "FixedLength" if pd.notna(x) and str(x).strip() else "OpenEnded")
    if t.startswith("lookup:"):
        lookup_key = t[len("lookup:") :]
        lookup_table = lookup_maps.get(lookup_key, {})
        return series.astype("string").str.strip().map(lookup_table)
    if t.startswith("const:"):
        return pd.Series([t[6:]] * len(series), index=series.index)
    if t.startswith("filter_startswith:"):
        prefix = t[len("filter_startswith:"):]
        def _filter_prefix(x, _p=prefix):
            if pd.isna(x):
                return pd.NA
            text = str(x)
            return pd.NA if text.startswith(_p) else text
        return series.map(_filter_prefix)
    logger.warning("Unknown transform rule %r – applying identity.", t)
    return series


def load_mapping(mapping_path: Path) -> pd.DataFrame:
    """Load and validate field_mapping.csv, dropping rows marked SKIP or CONFIRM."""
    if not mapping_path.exists():
        raise FileNotFoundError(f"Mapping file not found: {mapping_path}")
    mapping = pd.read_csv(mapping_path, dtype=str, keep_default_na=False)
    required_cols = {"sf_object", "bloomerang_table", "bloomerang_field", "transform", "sf_field"}
    missing_cols = required_cols - set(mapping.columns)
    if missing_cols:
        raise ValueError(f"field_mapping.csv is missing columns: {sorted(missing_cols)}")
    active = mapping[~mapping["sf_field"].isin(["SKIP", "CONFIRM", ""])].copy()
    logger.info("Loaded %s active mapping rows from %s.", len(active), mapping_path.name)
    return active


def build_object_from_mapping(
    object_name: str,
    mapping: pd.DataFrame,
    data: dict[str, pd.DataFrame],
    lookup_maps: dict[str, dict[str, str]],
) -> pd.DataFrame:
    """Transform Bloomerang source tables into a single SF object DataFrame using mapping rules."""
    obj_rows = mapping[mapping["sf_object"] == object_name].copy()
    if obj_rows.empty:
        logger.debug("No active mapping rows for %s.", object_name)
        return pd.DataFrame()

    # Rows using a bypass sentinel transform (skip/split_lines/fund_flags/refund_flags) are
    # handled elsewhere (or not at all) and must not pull in a source table just to be joined
    # and then discarded.
    bypass_transforms = {"skip", "SKIP", "split_lines", "fund_flags", "refund_flags", "name_convention"}
    table_rows = obj_rows[~obj_rows["transform"].str.strip().isin(bypass_transforms)]
    if table_rows.empty:
        logger.debug("No active source tables for %s.", object_name)
        return pd.DataFrame()

    # Build merged source: primary table first, then left-join secondary tables.
    tables = list(table_rows["bloomerang_table"].unique())
    primary = tables[0]
    merged = data.get(primary, pd.DataFrame()).copy()
    if merged.empty:
        logger.warning("Primary source table %s is empty for object %s.", primary, object_name)
        return pd.DataFrame()

    if "AccountNumber" in merged.columns:
        merged["AccountNumber"] = normalize_identifier_series(merged["AccountNumber"])
    if "TransactionNumber" in merged.columns:
        merged["TransactionNumber"] = normalize_identifier_series(merged["TransactionNumber"])

    for secondary in tables[1:]:
        secondary_df = data.get(secondary, pd.DataFrame()).copy()
        if secondary_df.empty:
            continue
        join_col = _TABLE_JOIN_KEY.get(secondary, "AccountNumber")
        if join_col not in merged.columns or join_col not in secondary_df.columns:
            logger.warning("Cannot join %s into %s: missing join column %s.", secondary, primary, join_col)
            continue
        merged[join_col] = normalize_identifier_series(merged[join_col])
        secondary_df[join_col] = normalize_identifier_series(secondary_df[join_col])
        if secondary in _ONE_TO_MANY_JOIN_TABLES:
            secondary_df = aggregate_one_to_many(secondary_df, join_col, secondary)
        dup_cols = [c for c in secondary_df.columns if c in merged.columns and c != join_col]
        secondary_df = secondary_df.rename(columns={c: f"{c}_{secondary}" for c in dup_cols})
        merged = merged.merge(secondary_df, on=join_col, how="left")

    output = pd.DataFrame(index=merged.index)
    for _, rule in obj_rows.iterrows():
        src_field = rule["bloomerang_field"].strip()
        tgt_field = rule["sf_field"].strip()
        transform = rule["transform"].strip()

        if "+" in src_field:
            # Composite key: concatenate multiple source columns with "|".
            parts = [p.strip() for p in src_field.split("+")]
            output[tgt_field] = merged.apply(
                lambda r, _p=parts: "|".join(_composite_part_value(r, col) for col in _p),
                axis=1,
            ).replace({"": pd.NA})
        elif not src_field and transform.strip().startswith("const:"):
            # const: transform with no source field – write the constant value across all rows.
            result = apply_transform(pd.Series([None] * len(merged), index=merged.index), transform, lookup_maps)
            if result is not None:
                output[tgt_field] = result
        elif src_field in merged.columns:
            result = apply_transform(merged[src_field].copy(), transform, lookup_maps)
            if result is not None:
                if tgt_field in output.columns and tgt_field == "CampaignId":
                    # First non-null wins: CampaignName is mapped before AppealName in field_mapping.csv.
                    output[tgt_field] = output[tgt_field].where(output[tgt_field].notna(), result)
                elif tgt_field in output.columns:
                    # Coalesce: new value wins where non-null; keeps existing where null.
                    output[tgt_field] = result.where(result.notna(), output[tgt_field])
                else:
                    output[tgt_field] = result
        else:
            logger.debug("Source field %s not found in merged table for %s.", src_field, object_name)

    return output.dropna(how="all").copy()


def sample_account_numbers(
    constituents: pd.DataFrame,
    sample_fraction: float = 0.05,
    seed: int = 42,
) -> set[str]:
    """Sample constituent AccountNumbers while preserving deterministic reruns."""
    if not 0 < sample_fraction <= 1:
        raise ValueError("sample_fraction must be between 0 and 1 (inclusive of 1).")
    if constituents.empty:
        raise ValueError("Constituents.csv is empty.")
    if "AccountNumber" not in constituents.columns:
        raise KeyError("Constituents.csv is missing the AccountNumber column.")

    account_numbers = normalize_identifier_series(constituents["AccountNumber"]).dropna().drop_duplicates()
    if sample_fraction == 1:
        return set(account_numbers.tolist())
    sampled = account_numbers.sample(frac=sample_fraction, random_state=seed)
    return set(sampled.tolist())


def filter_table_for_sample(
    df: pd.DataFrame,
    sampled_account_numbers: set[str],
    sampled_transaction_numbers: set[str],
) -> pd.DataFrame:
    """Keep child rows linked to sampled constituents or sampled transactions."""
    if df.empty:
        return df.copy()
    filtered = df.copy()

    account_mask = pd.Series(False, index=filtered.index)
    transaction_mask = pd.Series(False, index=filtered.index)

    if "AccountNumber" in filtered.columns:
        filtered["AccountNumber"] = normalize_identifier_series(filtered["AccountNumber"])
        account_mask = filtered["AccountNumber"].isin(sampled_account_numbers)

    if "TransactionNumber" in filtered.columns:
        filtered["TransactionNumber"] = normalize_identifier_series(filtered["TransactionNumber"])
        transaction_mask = filtered["TransactionNumber"].isin(sampled_transaction_numbers)

    if "AccountNumber" in filtered.columns and "TransactionNumber" in filtered.columns:
        mask = account_mask | transaction_mask
    elif "AccountNumber" in filtered.columns:
        mask = account_mask
    elif "TransactionNumber" in filtered.columns:
        mask = transaction_mask
    else:
        mask = pd.Series(False, index=filtered.index)

    return filtered.loc[mask].copy()


def sample_bloomerang_export(
    input_dir: Path = DEFAULT_INPUT_DIR,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    sample_fraction: float = 0.05,
    seed: int = 42,
    tables: list[str] | None = None,
) -> dict[str, int]:
    """Create a deterministic sample while keeping constituent and transaction links intact."""
    if not input_dir.exists():
        raise FileNotFoundError(f"Input directory does not exist: {input_dir}")

    constituents_path = input_dir / "Constituents.csv"
    transactions_path = input_dir / "Transactions.csv"
    if not constituents_path.exists() or not transactions_path.exists():
        raise FileNotFoundError("Both Constituents.csv and Transactions.csv are required.")

    constituents = read_bloomerang_csv(constituents_path)
    transactions = read_bloomerang_csv(transactions_path)

    sampled_accounts = sample_account_numbers(constituents, sample_fraction=sample_fraction, seed=seed)

    sampled_transactions = transactions.copy()
    if "AccountNumber" in sampled_transactions.columns:
        sampled_transactions["AccountNumber"] = normalize_identifier_series(sampled_transactions["AccountNumber"])
    if "TransactionNumber" in sampled_transactions.columns:
        sampled_transactions["TransactionNumber"] = normalize_identifier_series(sampled_transactions["TransactionNumber"])
    sampled_transactions = sampled_transactions[
        sampled_transactions["AccountNumber"].isin(sampled_accounts)
    ].copy()

    output_dir.mkdir(parents=True, exist_ok=True)

    constituents_sample = constituents[
        normalize_identifier_series(constituents["AccountNumber"]).isin(sampled_accounts)
    ].copy()
    constituents_sample.to_csv(output_dir / "Constituents.csv", index=False)
    # Soft credits point at DesignationNumber on a donation that may belong to a
    # different constituent. Keep those parent gifts (and their donor accounts)
    # so GiftTransactionByDesignation can resolve in the sample.
    soft_credits_path = input_dir / "SoftCredits.csv"
    donations_path = input_dir / "Donations.csv"
    if soft_credits_path.exists() and donations_path.exists():
        soft_credits = read_bloomerang_csv(soft_credits_path)
        donations_all = read_bloomerang_csv(donations_path)
        if not soft_credits.empty and "AccountNumber" in soft_credits.columns:
            sampled_accounts |= set(
                normalize_identifier_series(soft_credits["AccountNumber"]).dropna().tolist()
            )
            constituents_sample = constituents[
                normalize_identifier_series(constituents["AccountNumber"]).isin(sampled_accounts)
            ].copy()
            constituents_sample.to_csv(output_dir / "Constituents.csv", index=False)
        if (
            not soft_credits.empty
            and "ReferenceDesignationNumber" in soft_credits.columns
            and "DesignationNumber" in donations_all.columns
            and "TransactionNumber" in donations_all.columns
        ):
            referenced = set(normalize_identifier_series(soft_credits["ReferenceDesignationNumber"]).dropna().tolist())
            parent_txns = normalize_identifier_series(donations_all["TransactionNumber"])[
                normalize_identifier_series(donations_all["DesignationNumber"]).isin(referenced)
            ]
            extra_txn_numbers = set(parent_txns.dropna().tolist())
            if extra_txn_numbers:
                extra_txns = transactions[
                    normalize_identifier_series(transactions["TransactionNumber"]).isin(extra_txn_numbers)
                ].copy()
                sampled_transactions = pd.concat([sampled_transactions, extra_txns], ignore_index=True)
                sampled_transactions = sampled_transactions.drop_duplicates(
                    subset=["TransactionNumber"], keep="first"
                )
                sampled_transactions.to_csv(output_dir / "Transactions.csv", index=False)
                if "AccountNumber" in extra_txns.columns:
                    sampled_accounts |= set(normalize_identifier_series(extra_txns["AccountNumber"]).dropna().tolist())
                    constituents_sample = constituents[
                        normalize_identifier_series(constituents["AccountNumber"]).isin(sampled_accounts)
                    ].copy()
                    constituents_sample.to_csv(output_dir / "Constituents.csv", index=False)

    selected_tables = tables or sorted(
        p.name for p in input_dir.glob("*.csv") if p.name not in {"Constituents.csv", "Transactions.csv"}
    )

    counts = {"Constituents.csv": len(constituents_sample), "Transactions.csv": len(sampled_transactions)}
    for table_name in selected_tables:
        table_path = input_dir / table_name
        if not table_path.exists():
            logger.warning("Skipping missing file %s", table_name)
            continue
        source_df = read_bloomerang_csv(table_path)
        filtered = filter_table_for_sample(
            source_df,
            sampled_account_numbers=sampled_accounts,
            sampled_transaction_numbers=set(sampled_transactions["TransactionNumber"].dropna().astype(str).tolist()),
        )
        filtered.to_csv(output_dir / table_name, index=False)
        counts[table_name] = len(filtered)

    manifest = pd.DataFrame(
        [{
            "sampled_account_count": len(sampled_accounts),
            "sampled_transaction_count": len(sampled_transactions),
            "sample_fraction": sample_fraction,
            "output_dir": str(output_dir),
        }]
    )
    manifest.to_csv(output_dir / "sample_manifest.csv", index=False)

    logger.info("Sampled %s constituent records and %s transaction records.", len(sampled_accounts), len(sampled_transactions))
    return counts


def load_export_dir(export_dir: Path, sample_fraction: float = 1.0, seed: int = 42):
    """Read the Bloomerang CSV export and optionally sample it before transformation."""
    if not export_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {export_dir}")

    def _read(name: str) -> pd.DataFrame:
        path = export_dir / name
        return read_bloomerang_csv(path) if path.exists() else pd.DataFrame()

    data = {
        "Constituents": _read("Constituents.csv"),
        "Transactions": _read("Transactions.csv"),
        "Addresses": drop_is_bad_rows(_read("Addresses.csv"), "Addresses"),
        "Emails": drop_is_bad_rows(_read("Emails.csv"), "Emails"),
        "Phones": drop_is_bad_rows(_read("Phones.csv"), "Phones"),
        "Pledges": _read("Pledges.csv"),
        "RecurringDonations": _read("RecurringDonations.csv"),
        "Donations": _read("Donations.csv"),
        "Notes": _read("Notes.csv"),
        "Interactions": _read("Interactions.csv"),
        "Households": _read("Households.csv"),
        "Appeals": _read("Appeals.csv"),
        "Campaigns": _read("Campaigns.csv"),
        "Funds": _read("Funds.csv"),
        "Refunds": _read("Refunds.csv"),
        "SoftCredits": _read("SoftCredits.csv"),
        "Relationships": _read("Relationships.csv"),
    }

    if sample_fraction < 1.0:
        sampled_accounts = sample_account_numbers(data["Constituents"], sample_fraction=sample_fraction, seed=seed)

        transactions = data["Transactions"]
        sampled_transaction_numbers: set[str] = set()
        if not transactions.empty and "AccountNumber" in transactions.columns and "TransactionNumber" in transactions.columns:
            txn_accounts = normalize_identifier_series(transactions["AccountNumber"])
            txn_numbers = normalize_identifier_series(transactions["TransactionNumber"])
            sampled_transaction_numbers = set(txn_numbers[txn_accounts.isin(sampled_accounts)].dropna().tolist())

        # Soft credits on sampled people can point at another donor's gift. Keep those
        # parent gifts (and their donor accounts) so GiftSoftCredit can resolve.
        soft = data.get("SoftCredits", pd.DataFrame())
        donations_all = data.get("Donations", pd.DataFrame())
        if (
            not soft.empty
            and "AccountNumber" in soft.columns
            and "ReferenceDesignationNumber" in soft.columns
            and not donations_all.empty
            and "DesignationNumber" in donations_all.columns
            and "TransactionNumber" in donations_all.columns
        ):
            soft_acct = normalize_identifier_series(soft["AccountNumber"])
            sampled_soft = soft.loc[soft_acct.isin(sampled_accounts)]
            referenced = set(normalize_identifier_series(sampled_soft["ReferenceDesignationNumber"]).dropna().tolist())
            if referenced:
                parent_txns = normalize_identifier_series(donations_all["TransactionNumber"])[
                    normalize_identifier_series(donations_all["DesignationNumber"]).isin(referenced)
                ]
                extra_txn_numbers = set(parent_txns.dropna().tolist())
                sampled_transaction_numbers |= extra_txn_numbers
                if extra_txn_numbers and "AccountNumber" in transactions.columns:
                    extra_accts = normalize_identifier_series(transactions["AccountNumber"])[
                        normalize_identifier_series(transactions["TransactionNumber"]).isin(extra_txn_numbers)
                    ]
                    sampled_accounts |= set(extra_accts.dropna().tolist())
                    logger.info(
                        "Sample expansion: kept %s extra parent gifts referenced by soft credits.",
                        len(extra_txn_numbers),
                    )

        for name, df in list(data.items()):
            if df.empty:
                continue

            has_account_col = "AccountNumber" in df.columns
            has_txn_col = "TransactionNumber" in df.columns

            if not has_account_col and not has_txn_col:
                # Reference/master data (e.g. Appeals, Campaigns, Funds) has no per-constituent
                # or per-transaction key, so it is left unfiltered rather than dropped entirely.
                # Keeping these tables intact preserves lookup completeness for later joins.
                continue

            mask = pd.Series(False, index=df.index)
            if has_account_col:
                mask |= normalize_identifier_series(df["AccountNumber"]).isin(sampled_accounts)
            if has_txn_col:
                mask |= normalize_identifier_series(df["TransactionNumber"]).isin(sampled_transaction_numbers)

            data[name] = df.loc[mask].copy()

    return data


def build_account_records(constituents: pd.DataFrame) -> pd.DataFrame:
    """Build Account rows keyed by Bloomerang constituent IDs for upsert."""
    if constituents.empty:
        return pd.DataFrame()

    ext_id = EXTERNAL_ID_FIELDS["Account"]
    df = constituents.copy()
    df[ext_id] = normalize_identifier_series(df["AccountNumber"])
    # FullName is used for org/household Name; Person Accounts derive Name from FirstName+LastName automatically.
    df["Name"] = df.get("FullName", pd.Series([None] * len(df), index=df.index))
    if "First" in df.columns:
        df["FirstName"] = apply_transform(df["First"], "xxxx_empty", {})
    if "Last" in df.columns:
        df["LastName"] = apply_transform(df["Last"], "xxxx_unknown", {})
    # Map Bloomerang type to NPC RecordType using Bulk API 2.0 relationship notation.
    _type_map = {"Individual": "PersonAccount", "Organization": "Organization", "Household": "Household"}
    df["RecordType.DeveloperName"] = df["Type"].map(_type_map) if "Type" in df.columns else pd.Series([None] * len(df), index=df.index)

    keep = [ext_id] + [c for c in ["Name", "FirstName", "LastName", "RecordType.DeveloperName"] if c in df.columns]
    return df[keep].dropna(subset=[ext_id]).copy()


def build_account_communication_fields(constituents: pd.DataFrame) -> pd.DataFrame:
    """Apply multi-field communication restriction and channel preference logic.

    CommunicationRestrictions and Custom: Additional Communication Information each map
    to two separate Salesforce fields based on substring matching – this cannot be expressed
    in the generic mapping DSL, so the logic lives here and is merged onto accounts in main().
    """
    if constituents.empty:
        return pd.DataFrame()

    ext_id = EXTERNAL_ID_FIELDS["Account"]
    df = constituents.copy()
    df[ext_id] = normalize_identifier_series(df["AccountNumber"])
    df = df.dropna(subset=[ext_id])
    if df.empty:
        return pd.DataFrame()

    output = df[[ext_id]].copy()

    # CommunicationRestrictions: DoNotMail → Do_Not_Mail__c; DoNotCall → PersonDoNotCall.
    # DoNotSolicit is intentionally not mapped per business rules.
    if "CommunicationRestrictions" in df.columns:
        val = df["CommunicationRestrictions"].fillna("").astype(str)
        output["Do_Not_Mail__c"] = val.str.contains("DoNotMail", case=False)
        output["PersonDoNotCall"] = val.str.contains("DoNotCall", case=False)

    # Custom: Additional Communication Information: multi-value substring field.
    # QYM takes precedence over BYM when both are present in the same value.
    comm_col = "Custom: Additional Communication Information"
    if comm_col in df.columns:
        val = df[comm_col].fillna("").astype(str)
        output["Do_Not_Share__c"] = val.str.contains("DNS", case=False)
        mail_freq: pd.Series = pd.Series(pd.NA, index=df.index, dtype="object")
        mail_freq = mail_freq.where(~val.str.contains("BYM", case=False), "BYM")
        mail_freq = mail_freq.where(~val.str.contains("QYM", case=False), "QYM")
        output["Mail_Frequency__c"] = mail_freq

    return output


def apply_deceased_from_status(accounts: pd.DataFrame, constituents: pd.DataFrame) -> pd.DataFrame:
    """Set Deceased__c from Bloomerang Status on every run, including False for living people.

    Sending False (not omitting the field) lets a later export un-check someone who was
    marked deceased in error and then corrected in Bloomerang.
    """
    if accounts.empty or constituents.empty or "Status" not in constituents.columns:
        return accounts
    ext_id = EXTERNAL_ID_FIELDS["Account"]
    if ext_id not in accounts.columns:
        return accounts
    status_lookup = (
        constituents.assign(_id=normalize_identifier_series(constituents["AccountNumber"]))
        .dropna(subset=["_id"])
        .drop_duplicates(subset=["_id"], keep="first")
        .set_index("_id")["Status"]
    )
    status = accounts[ext_id].map(status_lookup).astype("string").str.strip().str.lower()
    out = accounts.copy()
    out["Deceased__c"] = status.eq("deceased")
    return out


def apply_donor_pathway_typo_fix(accounts: pd.DataFrame) -> pd.DataFrame:
    """Map the Bloomerang 'Treatement' misspelling to Salesforce 'Treatment'."""
    col = "Donor_Pathway_Segment__c"
    if accounts.empty or col not in accounts.columns:
        return accounts
    out = accounts.copy()
    out[col] = out[col].replace({"Treatement": "Treatment", "treatement": "Treatment"})
    return out


def build_email_records(emails: pd.DataFrame, account_ids: dict[str, str]) -> pd.DataFrame:
    """Create ContactPointEmail rows linked to Salesforce Account IDs via a lookup map."""
    if emails.empty:
        return pd.DataFrame()
    df = emails.copy()
    df["AccountNumber"] = normalize_identifier_series(df.get("AccountNumber", pd.Series([None] * len(df))))
    df["EmailAddress"] = df.get("Value").map(clean_email)
    df["IsPrimary"] = df.get("IsPrimary", pd.Series(False, index=df.index)).fillna(False).astype(bool)
    df["Bloomerang_Email_Key__c"] = df.apply(lambda row: f"{row['AccountNumber']}|{row['EmailAddress']}" if pd.notna(row['AccountNumber']) and pd.notna(row['EmailAddress']) else None, axis=1)
    df["ParentId"] = df["AccountNumber"].map(account_ids)
    df = df.dropna(subset=["ParentId", "EmailAddress", "Bloomerang_Email_Key__c"])
    return df[["Bloomerang_Email_Key__c", "ParentId", "EmailAddress", "IsPrimary"]].copy()


def build_phone_records(phones: pd.DataFrame, account_ids: dict[str, str]) -> pd.DataFrame:
    """Create ContactPointPhone rows linked to Salesforce Account IDs via a lookup map."""
    if phones.empty:
        return pd.DataFrame()
    df = phones.copy()
    df["AccountNumber"] = normalize_identifier_series(df.get("AccountNumber", pd.Series([None] * len(df))))
    df["TelephoneNumber"] = df.get("Number").map(clean_phone)
    df["IsPrimary"] = df.get("IsPrimary", pd.Series(False, index=df.index)).fillna(False).astype(bool)
    df["Bloomerang_Phone_Key__c"] = df.apply(lambda row: f"{row['AccountNumber']}|{row['TelephoneNumber']}" if pd.notna(row['AccountNumber']) and pd.notna(row['TelephoneNumber']) else None, axis=1)
    df["ParentId"] = df["AccountNumber"].map(account_ids)
    df = df.dropna(subset=["ParentId", "TelephoneNumber", "Bloomerang_Phone_Key__c"])
    return df[["Bloomerang_Phone_Key__c", "ParentId", "TelephoneNumber", "IsPrimary"]].copy()


def build_address_records(addresses: pd.DataFrame, account_ids: dict[str, str]) -> pd.DataFrame:
    """Create ContactPointAddress rows linked to Salesforce Account IDs via a lookup map."""
    if addresses.empty:
        return pd.DataFrame()
    df = addresses.copy()
    df["AccountNumber"] = normalize_identifier_series(df.get("AccountNumber", pd.Series([None] * len(df))))
    df["Street"] = df.get("Street", pd.Series([None] * len(df)))
    df["City"] = df.get("City", pd.Series([None] * len(df)))
    df["State"] = df.get("State", pd.Series([None] * len(df)))
    df["PostalCode"] = df.get("PostalCode", pd.Series([None] * len(df)))
    df["Country"] = df.get("Country", pd.Series([None] * len(df)))
    df["IsPrimary"] = df.get("IsPrimary", pd.Series(False, index=df.index)).fillna(False).astype(bool)
    df["Bloomerang_Address_Key__c"] = df.apply(
        lambda row: "|".join([
            str(row["AccountNumber"]).strip() if pd.notna(row["AccountNumber"]) else "",
            _composite_part_value(row, "Street"),
            str(row["City"]).strip() if pd.notna(row["City"]) else "",
            str(row["State"]).strip() if pd.notna(row["State"]) else "",
            str(row["PostalCode"]).strip() if pd.notna(row["PostalCode"]) else "",
        ]) if pd.notna(row["AccountNumber"]) else None,
        axis=1,
    )
    df["ParentId"] = df["AccountNumber"].map(account_ids)
    df = df.dropna(subset=["ParentId", "Bloomerang_Address_Key__c"])
    return df[["Bloomerang_Address_Key__c", "ParentId", "Street", "City", "State", "PostalCode", "Country", "IsPrimary"]].copy()


def build_gift_commitment_records(pledges: pd.DataFrame, recurring: pd.DataFrame, account_ids: dict[str, str]) -> pd.DataFrame:
    """Build gift commitment rows from pledge and recurring donation exports."""
    frames = []
    for name, df in [("Pledge", pledges), ("RecurringDonation", recurring)]:
        if df.empty:
            continue
        frame = df.copy()
        frame["AccountNumber"] = normalize_identifier_series(frame.get("AccountNumber", pd.Series([None] * len(frame))))
        frame["ParentId"] = frame["AccountNumber"].map(account_ids)
        frame["Bloomerang_Commitment_ID__c"] = normalize_identifier_series(frame.get("TransactionNumber", pd.Series([None] * len(frame))))
        frame["Amount"] = pd.to_numeric(frame.get("Amount", pd.Series([0] * len(frame))), errors="coerce").fillna(0)
        # Pledge and recurring rows land in the same Salesforce object; the source name keeps the lineage visible.
        frame["StartDate"] = frame.get("FirstInstallmentDate", pd.Series([None] * len(frame))).map(parse_iso_date)
        frame["EndDate"] = frame.get("EndDate", pd.Series([None] * len(frame))).map(parse_iso_date)
        frame["CommitmentType"] = name
        frames.append(frame[["Bloomerang_Commitment_ID__c", "ParentId", "Amount", "StartDate", "EndDate", "CommitmentType"]])

    if not frames:
        return pd.DataFrame()

    output = pd.concat(frames, ignore_index=True)
    return output.dropna(subset=["ParentId", "Bloomerang_Commitment_ID__c"]).copy()


def build_gift_transaction_records(transactions: pd.DataFrame, account_ids: dict[str, str]) -> pd.DataFrame:
    """Build gift transaction rows from the Bloomerang Transactions export."""
    if transactions.empty:
        return pd.DataFrame()
    df = transactions.copy()
    df["AccountNumber"] = normalize_identifier_series(df.get("AccountNumber", pd.Series([None] * len(df))))
    df["ParentId"] = df["AccountNumber"].map(account_ids)
    df["Bloomerang_Transaction_ID__c"] = normalize_identifier_series(df.get("TransactionNumber", pd.Series([None] * len(df))))
    df["Amount"] = pd.to_numeric(df.get("Amount", pd.Series([0] * len(df))), errors="coerce").fillna(0)
    df["GiftDate"] = df.get("Date", pd.Series([None] * len(df))).map(parse_iso_date)
    # Payment method is passed through because the live org picklist was verified separately.
    df["PaymentMethod"] = df.get("Method", pd.Series([None] * len(df)))
    out = df[["Bloomerang_Transaction_ID__c", "ParentId", "Amount", "GiftDate", "PaymentMethod"]].copy()
    return out.dropna(subset=["ParentId", "Bloomerang_Transaction_ID__c"]).copy()


def build_gift_transaction_designation_records(
    donations: pd.DataFrame,
    transaction_ids: dict[str, str],
    designation_ids: dict[str, str],
) -> pd.DataFrame:
    """Build GiftTransactionDesignation junction records from Donations.csv.

    Each Donations row is one fund allocation for one gift, and Bloomerang's DesignationNumber
    identifies that allocation, so it is the external id here. GiftDesignationId resolves through
    FundName because GiftDesignation is keyed by fund name.
    """
    if donations.empty:
        return pd.DataFrame()

    ext_id = EXTERNAL_ID_FIELDS["GiftTransactionDesignation"]
    df = donations.copy()
    df["TransactionNumber"] = normalize_identifier_series(df.get("TransactionNumber", pd.Series([None] * len(df))))
    df["DesignationNumber"] = normalize_identifier_series(df.get("DesignationNumber", pd.Series([None] * len(df))))
    df["FundName"] = normalize_identifier_series(df.get("FundName", pd.Series([None] * len(df))))

    df[ext_id] = df["DesignationNumber"]
    df["GiftTransactionId"] = df["TransactionNumber"].map(transaction_ids)
    df["GiftDesignationId"] = df["FundName"].map(designation_ids)
    df["Amount"] = pd.to_numeric(df.get("Amount", pd.Series([0] * len(df))), errors="coerce").fillna(0)

    out = df[[ext_id, "GiftTransactionId", "GiftDesignationId", "Amount"]].copy()
    return out.dropna(subset=[ext_id, "GiftTransactionId", "GiftDesignationId"]).copy()


def build_account_name_lookup(constituents: pd.DataFrame) -> dict[str, str]:
    """Map Bloomerang AccountNumber to a display name, used by the Name naming conventions."""
    if constituents.empty or "AccountNumber" not in constituents.columns:
        return {}
    df = constituents.copy()
    df["_acct"] = normalize_identifier_series(df["AccountNumber"])
    df = df.dropna(subset=["_acct"]).drop_duplicates(subset=["_acct"], keep="first")
    names = df.apply(clean_name, axis=1)
    return {a: n for a, n in zip(df["_acct"], names) if pd.notna(n) and str(n).strip()}


def _format_amount(value: Any) -> str:
    amount = pd.to_numeric(value, errors="coerce")
    return "" if pd.isna(amount) else f"${amount:,.2f}"


def _join_name_parts(parts: list[str], limit: int = 80) -> str | None:
    joined = " - ".join(p for p in parts if p)
    return joined[:limit] if joined else None


def build_gift_transaction_names(transactions: pd.DataFrame, account_names: dict[str, str]) -> pd.DataFrame:
    """Name convention for GiftTransaction: [Amount] - [Account Name] - [Date]."""
    if transactions.empty:
        return pd.DataFrame()
    ext_id = EXTERNAL_ID_FIELDS["GiftTransaction"]
    df = transactions.copy()
    df[ext_id] = normalize_identifier_series(df.get("TransactionNumber", pd.Series([None] * len(df))))
    acct = normalize_identifier_series(df.get("AccountNumber", pd.Series([None] * len(df))))
    amounts = df.get("Amount", pd.Series([None] * len(df))).map(_format_amount)
    dates = df.get("Date", pd.Series([None] * len(df))).map(parse_date_only).fillna("")
    names = acct.map(account_names).fillna("")
    df["Name"] = [_join_name_parts([a, n, d]) for a, n, d in zip(amounts, names, dates)]
    out = df[[ext_id, "Name"]].dropna(subset=[ext_id])
    return out.drop_duplicates(subset=[ext_id], keep="first").copy()


def build_gift_commitment_names(
    recurring: pd.DataFrame,
    account_names: dict[str, str],
    transactions: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Name convention for GiftCommitment: [Amount] - [Frequency] - [Account Name]."""
    if recurring.empty:
        return pd.DataFrame()
    ext_id = EXTERNAL_ID_FIELDS["GiftCommitment"]
    df = recurring.copy()
    df[ext_id] = normalize_identifier_series(df.get("TransactionNumber", pd.Series([None] * len(df))))
    if "AccountNumber" not in df.columns and transactions is not None and not transactions.empty:
        txn_lookup = transactions.copy()
        txn_lookup["_txn"] = normalize_identifier_series(txn_lookup.get("TransactionNumber", pd.Series([None] * len(txn_lookup))))
        txn_lookup["_acct"] = normalize_identifier_series(txn_lookup.get("AccountNumber", pd.Series([None] * len(txn_lookup))))
        txn_lookup = txn_lookup.dropna(subset=["_txn"]).drop_duplicates(subset=["_txn"], keep="first")
        df = df.merge(txn_lookup[["_txn", "_acct"]], left_on=ext_id, right_on="_txn", how="left")
        df["AccountNumber"] = df["_acct"]
    acct = normalize_identifier_series(df.get("AccountNumber", pd.Series([None] * len(df))))
    amounts = df.get("Amount", pd.Series([None] * len(df))).map(_format_amount)
    freqs = df.get("Frequency", pd.Series([None] * len(df))).fillna("").astype(str).str.strip()
    names = acct.map(account_names).fillna("")
    df["Name"] = [_join_name_parts([a, f, n]) for a, f, n in zip(amounts, freqs, names)]
    out = df[[ext_id, "Name"]].dropna(subset=[ext_id])
    return out.drop_duplicates(subset=[ext_id], keep="first").copy()


def apply_address_name_convention(addresses: pd.DataFrame) -> pd.DataFrame:
    """Name convention for ContactPointAddress: the full street address on a single line."""
    df = addresses.copy()
    if "Street" not in df.columns:
        return df
    df["Name"] = (
        df["Street"]
        .fillna("")
        .astype(str)
        .str.replace(r"[\r\n]+", " ", regex=True)
        .str.replace(r"\s+", " ", regex=True)
        .str.strip()
        .str.slice(0, 80)
        .replace({"": pd.NA})
    )
    return df


def apply_required_name_conventions(
    object_name: str,
    df: pd.DataFrame,
    data: dict[str, pd.DataFrame],
    account_names: dict[str, str],
) -> pd.DataFrame:
    """Fill required Name fields that the mapping DSL cannot express."""
    if df.empty:
        return df
    if object_name == "ContactPointAddress":
        df = apply_address_name_convention(df)
        if "Name" in df.columns:
            before = len(df)
            df = df.dropna(subset=["Name"]).copy()
            dropped = before - len(df)
            if dropped:
                logger.warning("ContactPointAddress: dropped %s rows with blank Name.", dropped)
        return df
    if object_name == "GiftCommitment":
        gc_names = build_gift_commitment_names(
            data.get("RecurringDonations", pd.DataFrame()),
            account_names,
            transactions=data.get("Transactions", pd.DataFrame()),
        )
        ext_id = EXTERNAL_ID_FIELDS["GiftCommitment"]
        if not gc_names.empty and ext_id in df.columns:
            left = df.drop(columns=["Name"], errors="ignore").copy()
            left[ext_id] = normalize_identifier_series(left[ext_id])
            gc_names = gc_names.copy()
            gc_names[ext_id] = normalize_identifier_series(gc_names[ext_id])
            return left.merge(gc_names, on=ext_id, how="left")
        return df
    if object_name == "GiftTransaction":
        gt_names = build_gift_transaction_names(data.get("Transactions", pd.DataFrame()), account_names)
        ext_id = EXTERNAL_ID_FIELDS["GiftTransaction"]
        if not gt_names.empty and ext_id in df.columns:
            left = df.drop(columns=["Name"], errors="ignore").copy()
            left[ext_id] = normalize_identifier_series(left[ext_id])
            gt_names = gt_names.copy()
            gt_names[ext_id] = normalize_identifier_series(gt_names[ext_id])
            left = left.merge(gt_names, on=ext_id, how="left")
            before = len(left)
            left = left.drop_duplicates(subset=[ext_id], keep="first")
            dropped = before - len(left)
            if dropped:
                logger.warning(
                    "GiftTransaction: collapsed %s duplicate %s rows from multi-fund donations.",
                    dropped,
                    ext_id,
                )
            return left
        return df
    return df


def query_account_ids(sf: Salesforce, account_numbers: list[str]) -> dict[str, str]:
    """Use a Bloomerang key to retrieve Salesforce Account Ids after the parent upsert."""
    return query_external_ids(sf, "Account", EXTERNAL_ID_FIELDS["Account"], account_numbers)


def query_record_type_ids(sf: Salesforce, sobject_type: str) -> dict[str, str]:
    """Query RecordType IDs by DeveloperName for a given sObject type."""
    try:
        result = sf.query_all(f"SELECT Id, DeveloperName FROM RecordType WHERE SObjectType = '{sobject_type}'")
        return {row["DeveloperName"]: row["Id"] for row in result.get("records", [])}
    except Exception as exc:
        logger.warning("Could not query RecordType IDs for %s: %s", sobject_type, exc)
        return {}


def build_account_address_line_fields(addresses: pd.DataFrame, constituents: pd.DataFrame | None = None) -> pd.DataFrame:
    """Split each Bloomerang address's Street into Line 1/Line 2 and pivot onto Account-level
    Mailing/Shipping fields keyed by the Bloomerang constituent id.

    Category is determined by constituent type (Individual→Mailing, Org/Household→Shipping).
    When a constituent has more than one address, the primary address wins.
    """
    if addresses.empty or "AccountNumber" not in addresses.columns or "Street" not in addresses.columns:
        return pd.DataFrame()

    ext_id = EXTERNAL_ID_FIELDS["Account"]
    df = addresses.copy()
    df["AccountNumber"] = normalize_identifier_series(df["AccountNumber"])

    if constituents is not None and not constituents.empty and "Type" in constituents.columns:
        type_lookup = (
            constituents[["AccountNumber", "Type"]]
            .assign(AccountNumber=normalize_identifier_series(constituents["AccountNumber"]))
            .drop_duplicates(subset=["AccountNumber"])
            .set_index("AccountNumber")["Type"]
            .to_dict()
        )
        df["Category"] = df["AccountNumber"].map(type_lookup).map(CONSTITUENT_TYPE_TO_ADDRESS_CATEGORY)
    else:
        df["Category"] = df.get("TypeName", pd.Series([None] * len(df))).map(ADDRESS_TYPE_TO_CATEGORY)
    df = df.dropna(subset=["AccountNumber", "Category"])
    if df.empty:
        return pd.DataFrame()

    df["IsPrimary"] = df.get("IsPrimary", pd.Series(False, index=df.index)).fillna(False).astype(bool)
    df = df.sort_values("IsPrimary", ascending=False).drop_duplicates(subset=["AccountNumber", "Category"], keep="first")

    lines = df["Street"].map(split_street_lines)
    df["Line1"] = lines.map(lambda pair: pair[0])
    df["Line2"] = lines.map(lambda pair: pair[1])

    pivoted = df.pivot(index="AccountNumber", columns="Category", values=["Line1", "Line2"])
    pivoted.columns = [f"{category}_{part}" for part, category in pivoted.columns]
    pivoted = pivoted.reset_index().rename(columns={"AccountNumber": ext_id})

    for category, (line1_field, line2_field) in ACCOUNT_ADDRESS_LINE_FIELDS.items():
        pivoted = pivoted.rename(columns={f"{category}_Line1": line1_field, f"{category}_Line2": line2_field})

    return pivoted


# Set by main() before any live upserts so upsert_bulk/insert_bulk can write error CSVs.
_run_error_dir: Path | None = None

# Max IDs per SOQL IN clause; Salesforce recommends staying well below 2000 for safety.
_SOQL_BATCH = 200


def _clean_record(rec: dict) -> dict:
    """Strip null/NA values and convert Python booleans to lowercase strings for Bulk API 2.0."""
    cleaned = {}
    for k, v in rec.items():
        if v is None:
            continue
        try:
            if pd.isna(v):
                continue
        except (TypeError, ValueError):
            pass
        cleaned[k] = str(v).lower() if isinstance(v, bool) else v
        if isinstance(v, str) and v.strip().lower() in {"true", "false"}:
            cleaned[k] = v.strip().lower()
    return cleaned


def query_external_ids(sf: Salesforce, object_name: str, external_id_field: str, keys: list[str]) -> dict[str, str]:
    """Look up Salesforce Ids for any object/external-id pair after an upsert.

    Batches the SOQL IN clause to stay within Salesforce query string limits.
    """
    values = sorted({str(key) for key in keys if key})
    if not values:
        return {}
    result_map: dict[str, str] = {}
    for start in range(0, len(values), _SOQL_BATCH):
        batch = values[start : start + _SOQL_BATCH]
        escaped = [v.replace("'", "\\'") for v in batch]
        query = (
            f"SELECT Id, {external_id_field} FROM {object_name} "
            f"WHERE {external_id_field} IN ('" + "','".join(escaped) + "')"
        )
        rows = sf.query_all(query).get("records", [])
        for row in rows:
            key = row.get(external_id_field)
            if key:
                result_map[str(key)] = row["Id"]
    logger.debug("query_external_ids %s: requested %s, resolved %s.", object_name, len(values), len(result_map))
    return result_map


def salesforce_field_exists(sf: Salesforce, object_name: str, field_name: str) -> bool:
    try:
        desc = getattr(sf, object_name).describe()
        return any(field.get("name") == field_name for field in desc.get("fields", []))
    except Exception as exc:
        logger.warning("Could not describe %s to check field %s: %s", object_name, field_name, exc)
        return False


def query_existing_content_note_titles(sf: Salesforce, titles: list[str]) -> set[str] | None:
    """Return Titles already in Salesforce, or None if the query could not be run."""
    values = sorted({str(title) for title in titles if title})
    if not values:
        return set()
    found: set[str] = set()
    try:
        for start in range(0, len(values), _SOQL_BATCH):
            batch = values[start : start + _SOQL_BATCH]
            escaped = [v.replace("'", "\\'") for v in batch]
            query = "SELECT Title FROM ContentNote WHERE Title IN ('" + "','".join(escaped) + "')"
            rows = sf.query_all(query).get("records", [])
            for row in rows:
                if row.get("Title"):
                    found.add(row["Title"])
    except Exception as exc:
        logger.warning("Could not query existing ContentNote titles: %s", exc)
        return None
    return found


def strip_pause_from_existing_schedules(
    sf: Salesforce,
    schedules: pd.DataFrame,
    external_id_field: str,
) -> pd.DataFrame:
    """Do not send Type=PauseTransactions for schedules that already exist in Salesforce."""
    if schedules.empty or "Type" not in schedules.columns or external_id_field not in schedules.columns:
        return schedules
    keys = schedules[external_id_field].dropna().astype(str).tolist()
    existing = query_external_ids(sf, "GiftCommitmentSchedule", external_id_field, keys)
    if not existing:
        return schedules
    out = schedules.copy()
    mask = out[external_id_field].astype(str).isin(existing)
    count = int(mask.sum())
    if count:
        out.loc[mask, "Type"] = pd.NA
        logger.info(
            "Leaving Type unchanged for %s GiftCommitmentSchedule rows that already exist in Salesforce.",
            count,
        )
    return out


def scrub_invalid_picklist_values(sf: Salesforce, object_name: str, records: pd.DataFrame) -> pd.DataFrame:
    """Blank restricted picklist values that are not in the org, so the rest of the row can load."""
    if records.empty:
        return records
    try:
        desc = getattr(sf, object_name).describe()
    except Exception as exc:
        logger.warning("Skipping picklist scrub for %s: %s", object_name, exc)
        return records
    field_meta = {field["name"]: field for field in desc.get("fields", [])}
    out = records.copy()
    for col in list(out.columns):
        meta = field_meta.get(col)
        if not meta or meta.get("type") not in {"picklist", "multipicklist"}:
            continue
        if not meta.get("restrictedPicklist"):
            continue
        allowed = {v.get("value") for v in meta.get("picklistValues", []) if v.get("active")}
        if not allowed:
            continue
        if meta.get("type") == "multipicklist":
            def _keep_valid(value: Any, _allowed=allowed) -> Any:
                if pd.isna(value) or str(value).strip() == "":
                    return pd.NA
                parts = [p.strip() for p in str(value).split(";") if p.strip()]
                kept = [p for p in parts if p in _allowed]
                dropped = [p for p in parts if p not in _allowed]
                if dropped:
                    logger.warning("%s.%s: dropped unknown multi-select values %s", object_name, col, dropped)
                return ";".join(kept) if kept else pd.NA
            out[col] = out[col].map(_keep_valid)
        else:
            invalid = out[col].notna() & ~out[col].astype(str).isin(allowed) & (out[col].astype(str).str.strip() != "")
            n = int(invalid.sum())
            if n:
                samples = out.loc[invalid, col].astype(str).drop_duplicates().head(8).tolist()
                logger.warning(
                    "%s.%s: clearing %s values not in the org picklist (examples: %s).",
                    object_name, col, n, samples,
                )
                out.loc[invalid, col] = pd.NA
    return out


def build_pledge_commitment_records(
    pledges: pd.DataFrame,
    lookup_maps: dict[str, dict[str, str]],
    account_names: dict[str, str],
) -> pd.DataFrame:
    """Build GiftCommitment rows from Pledges.csv using the same field names as the mapping path."""
    if pledges.empty:
        return pd.DataFrame()
    ext_id = EXTERNAL_ID_FIELDS["GiftCommitment"]
    df = pledges.copy()
    df[ext_id] = normalize_identifier_series(df.get("TransactionNumber", pd.Series([None] * len(df))))
    acct = normalize_identifier_series(df.get("AccountNumber", pd.Series([None] * len(df))))
    df["DonorId"] = acct.map(lookup_maps.get("Account", {}))
    df["EffectiveStartDate"] = df.get("FirstInstallmentDate", pd.Series([None] * len(df))).map(parse_date_only)
    end = df.get("EndDate", pd.Series([None] * len(df)))
    df["ExpectedEndDate"] = end.map(parse_date_only)
    df["RecurrenceType"] = end.map(lambda x: "FixedLength" if pd.notna(x) and str(x).strip() else "OpenEnded")
    df["Description"] = df.get("Note", pd.Series([None] * len(df)))
    if "AppealName" in df.columns:
        df["CampaignId"] = df["AppealName"].astype("string").str.strip().map(lookup_maps.get("Campaign", {}))
    amounts = df.get("Amount", pd.Series([None] * len(df))).map(_format_amount)
    freqs = df.get("Frequency", pd.Series([None] * len(df))).fillna("").astype(str).str.strip()
    freqs = freqs.replace({"": "Pledge"})
    names = acct.map(account_names).fillna("")
    df["Name"] = [_join_name_parts([a, f, n]) for a, f, n in zip(amounts, freqs, names)]
    keep = [c for c in [
        ext_id, "DonorId", "EffectiveStartDate", "ExpectedEndDate",
        "RecurrenceType", "Description", "CampaignId", "Name",
    ] if c in df.columns]
    out = df[keep].dropna(subset=[ext_id])
    before = len(out)
    out = out.dropna(subset=["DonorId"]) if "DonorId" in out.columns else out
    dropped = before - len(out)
    if dropped:
        logger.warning("Pledges: dropped %s rows with no matching Salesforce Account.", dropped)
    out = out.drop_duplicates(subset=[ext_id], keep="first")
    logger.info("Prepared %s GiftCommitment rows from Pledges.csv.", len(out))
    return out


def merge_pledge_commitments(
    gift_commitments: pd.DataFrame,
    pledges: pd.DataFrame,
    lookup_maps: dict[str, dict[str, str]],
    account_names: dict[str, str],
) -> pd.DataFrame:
    pledge_rows = build_pledge_commitment_records(pledges, lookup_maps, account_names)
    if pledge_rows.empty:
        return gift_commitments
    ext_id = EXTERNAL_ID_FIELDS["GiftCommitment"]
    if gift_commitments.empty:
        return pledge_rows
    combined = pd.concat([gift_commitments, pledge_rows], ignore_index=True)
    before = len(combined)
    combined = combined.drop_duplicates(subset=[ext_id], keep="first")
    collisions = before - len(combined)
    if collisions:
        logger.warning(
            "Dropped %s pledge GiftCommitment rows whose Bloomerang ID already existed on a recurring gift.",
            collisions,
        )
    return combined


def write_reconciliation_report(
    output_dir: Path,
    data: dict[str, pd.DataFrame],
    prepared: dict[str, pd.DataFrame],
    live_resolved: dict[str, int] | None = None,
) -> None:
    """Write source vs prepared (and optional live) counts so gift dollars can be tied out."""

    def _len(frame: pd.DataFrame) -> int:
        return 0 if frame is None or frame.empty else len(frame)

    def _sum(frame: pd.DataFrame, column: str) -> float:
        if frame is None or frame.empty or column not in frame.columns:
            return 0.0
        return float(pd.to_numeric(frame[column], errors="coerce").fillna(0).sum())

    constituents = data.get("Constituents", pd.DataFrame())
    transactions = data.get("Transactions", pd.DataFrame())
    pledges = data.get("Pledges", pd.DataFrame())
    recurring = data.get("RecurringDonations", pd.DataFrame())
    donations = data.get("Donations", pd.DataFrame())
    accounts = prepared.get("Account", pd.DataFrame())
    gifts = prepared.get("GiftTransaction", pd.DataFrame())
    commitments = prepared.get("GiftCommitment", pd.DataFrame())
    designations = prepared.get("GiftTransactionDesignation", pd.DataFrame())

    gift_amount_col = "OriginalAmount" if gifts is not None and "OriginalAmount" in gifts.columns else "Amount"
    rows = [
        {"metric": "constituents_in_export", "value": _len(constituents)},
        {"metric": "accounts_prepared", "value": _len(accounts)},
        {"metric": "transactions_in_export", "value": _len(transactions)},
        {"metric": "gift_transactions_prepared", "value": _len(gifts)},
        {"metric": "transaction_amount_sum_export", "value": round(_sum(transactions, "Amount"), 2)},
        {"metric": "gift_amount_sum_prepared", "value": round(_sum(gifts, gift_amount_col), 2)},
        {"metric": "pledges_in_export", "value": _len(pledges)},
        {"metric": "pledge_amount_sum_export", "value": round(_sum(pledges, "Amount"), 2)},
        {"metric": "recurring_in_export", "value": _len(recurring)},
        {"metric": "gift_commitments_prepared", "value": _len(commitments)},
        {"metric": "donation_rows_in_export", "value": _len(donations)},
        {"metric": "gift_transaction_designations_prepared", "value": _len(designations)},
        {"metric": "designation_amount_sum_prepared", "value": round(_sum(designations, "Amount"), 2)},
        {"metric": "emails_in_export", "value": _len(data.get("Emails", pd.DataFrame()))},
        {"metric": "phones_in_export", "value": _len(data.get("Phones", pd.DataFrame()))},
        {"metric": "addresses_in_export", "value": _len(data.get("Addresses", pd.DataFrame()))},
        {"metric": "notes_in_export", "value": _len(data.get("Notes", pd.DataFrame()))},
        {"metric": "soft_credits_in_export", "value": _len(data.get("SoftCredits", pd.DataFrame()))},
    ]
    if live_resolved:
        for name, count in live_resolved.items():
            rows.append({"metric": f"salesforce_resolved_{name}", "value": count})

    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "reconciliation.csv"
    pd.DataFrame(rows).to_csv(path, index=False)
    logger.info("Wrote reconciliation report to %s", path)
    gift_export = _sum(transactions, "Amount")
    gift_prepared = _sum(gifts, gift_amount_col)
    if gift_export and abs(gift_export - gift_prepared) > 0.01:
        logger.warning(
            "Gift dollar mismatch: export Transactions.Amount sum is %s; prepared GiftTransaction sum is %s.",
            round(gift_export, 2),
            round(gift_prepared, 2),
        )


def build_campaign_records(appeals: pd.DataFrame) -> pd.DataFrame:
    """Build Campaign rows from Bloomerang Appeals, skipping appeals coded "E0..." (no Campaign is created for those)."""
    if appeals.empty:
        return pd.DataFrame()

    ext_id = EXTERNAL_ID_FIELDS["Campaign"]
    df = appeals.copy()
    df["Name"] = df.get("Name", pd.Series([None] * len(df))).astype("string").str.strip()
    df = df[~df["Name"].str.upper().str.startswith("E0", na=False)].copy()
    df[ext_id] = df["Name"]
    df["IsActive"] = df.get("IsActive", pd.Series(True, index=df.index)).fillna(True).astype(bool)
    df["StartDate"] = df.get("StartDate", pd.Series([None] * len(df))).map(parse_date_only)
    df["EndDate"] = df.get("EndDate", pd.Series([None] * len(df))).map(parse_date_only)

    out = df[[ext_id, "Name", "IsActive", "StartDate", "EndDate"]].dropna(subset=[ext_id])
    return out.drop_duplicates(subset=[ext_id]).copy()


# Bloomerang Campaigns.csv shares the same shape as Appeals.csv but is a distinct entity list;
# both map into the same standard SF Campaign object via two separate upserts, each keyed by its
# own external id field so a record is only ever matched against one of the two.
CAMPAIGN_CSV_EXTERNAL_ID_FIELD = "Bloomerang_Campaign_ID__c"


def build_campaign_records_from_campaigns(campaigns: pd.DataFrame) -> pd.DataFrame:
    """Build Campaign rows from Bloomerang's own Campaigns.csv (distinct from Appeals.csv)."""
    if campaigns.empty:
        return pd.DataFrame()

    ext_id = CAMPAIGN_CSV_EXTERNAL_ID_FIELD
    df = campaigns.copy()
    df["Name"] = df.get("Name", pd.Series([None] * len(df))).astype("string").str.strip()
    df[ext_id] = df["Name"]
    df["IsActive"] = df.get("IsActive", pd.Series(True, index=df.index)).fillna(True).astype(bool)
    df["StartDate"] = df.get("StartDate", pd.Series([None] * len(df))).map(parse_date_only)
    df["EndDate"] = df.get("EndDate", pd.Series([None] * len(df))).map(parse_date_only)

    out = df[[ext_id, "Name", "IsActive", "StartDate", "EndDate"]].dropna(subset=[ext_id])
    return out.drop_duplicates(subset=[ext_id]).copy()


def build_designation_records(data: dict[str, pd.DataFrame], campaign_ids: dict[str, str]) -> pd.DataFrame:
    """Build GiftDesignation rows deduped by FundName across Donations, Pledges, and RecurringDonations.

    A GiftDesignation is the Fund itself, so FundName is the external id. The per-gift fund
    allocation (Bloomerang's DesignationNumber) belongs on GiftTransactionDesignation instead.
    Funds.csv is joined in afterward by name purely to carry over whether the fund is still active.
    """
    frames = []
    for table_name in ("Donations", "Pledges", "RecurringDonations"):
        source = data.get(table_name, pd.DataFrame())
        if source.empty or "FundName" not in source.columns:
            continue
        columns = [c for c in ("FundName", "AppealName", "CampaignName") if c in source.columns]
        frames.append(source[columns].copy())

    if not frames:
        return pd.DataFrame()

    ext_id = EXTERNAL_ID_FIELDS["GiftDesignation"]
    combined = pd.concat(frames, ignore_index=True)
    combined["FundName"] = normalize_identifier_series(combined["FundName"])
    combined = combined.dropna(subset=["FundName"]).drop_duplicates(subset=["FundName"], keep="first")

    combined[ext_id] = combined["FundName"]
    combined["Name"] = combined["FundName"]
    combined["WeGive_ID__c"] = combined["FundName"]  # required field; fund name used as placeholder

    funds = data.get("Funds", pd.DataFrame())
    if not funds.empty and "Name" in funds.columns and "IsActive" in funds.columns:
        fund_status = (
            funds[["Name", "IsActive"]]
            .drop_duplicates(subset=["Name"], keep="first")
            .rename(columns={"Name": "_fund_name"})
        )
        combined = combined.merge(fund_status, left_on="FundName", right_on="_fund_name", how="left").drop(columns=["_fund_name"])
        return combined[[ext_id, "Name", "IsActive", "WeGive_ID__c"]].copy()

    return combined[[ext_id, "Name", "WeGive_ID__c"]].copy()


def build_gift_transaction_refund_fields(refunds: pd.DataFrame) -> pd.DataFrame:
    """Produce per-transaction refund columns to merge onto GiftTransaction.

    Returns RefundedAmount and _RefundSuffix (formatted for Admin_Notes__c appending).
    IsFullyRefunded / IsPartiallyRefunded are computed in _apply_refund_postprocessing
    after the merge, once the original transaction Amount is available for comparison.
    """
    if refunds.empty or "ReferenceTransactionNumber" not in refunds.columns:
        return pd.DataFrame()

    ext_id = EXTERNAL_ID_FIELDS["GiftTransaction"]
    df = refunds.copy()
    df[ext_id] = normalize_identifier_series(df["ReferenceTransactionNumber"])
    df = df.dropna(subset=[ext_id])
    df["RefundedAmount"] = pd.to_numeric(df.get("Amount", pd.Series([None] * len(df))), errors="coerce")
    df["_RefundDate"] = df.get("Date", pd.Series([None] * len(df))).map(parse_date_only).fillna("")
    df["_RefundNote"] = df.get("Note", pd.Series([None] * len(df))).fillna("").astype(str).str.strip()

    def _suffix(dates: pd.Series, notes: pd.Series):
        chunks = []
        for date_val, note_val in zip(dates, notes):
            line = f"Refund {date_val}: {note_val}".strip()
            if line not in {"Refund :", "Refund:"}:
                chunks.append(line)
        return ("---\n" + "\n".join(chunks)) if chunks else pd.NA

    suffixes: dict[str, Any] = {}
    for key, group in df.groupby(ext_id):
        suffixes[str(key)] = _suffix(group["_RefundDate"], group["_RefundNote"])
    amounts = df.groupby(ext_id, as_index=False)["RefundedAmount"].sum()
    amounts["_RefundSuffix"] = amounts[ext_id].astype(str).map(suffixes)
    if len(amounts) < len(df):
        logger.info(
            "Rolled %s refund rows up to %s transactions (summed RefundedAmount).",
            len(df),
            len(amounts),
        )
    return amounts[[ext_id, "RefundedAmount", "_RefundSuffix"]].copy()


def _report_bulk_errors(
    object_name: str,
    response: list[dict[str, Any]],
    records: pd.DataFrame,
    external_id_field: str,
) -> None:
    """Log individual Salesforce errors from a bulk response and write an error CSV if configured."""
    failures = [(i, r) for i, r in enumerate(response) if not r.get("success")]
    if not failures:
        return
    logger.error("%s: %s / %s records FAILED.", object_name, len(failures), len(response))
    payload = records.to_dict(orient="records") if not records.empty else []
    for idx, result in failures[:20]:
        ext_val = payload[idx].get(external_id_field, "<unknown>") if idx < len(payload) else "<unknown>"
        for err in result.get("errors", []):
            logger.error("  [%s=%s] %s: %s (fields: %s)", external_id_field, ext_val,
                         err.get("statusCode"), err.get("message"), err.get("fields"))
    if len(failures) > 20:
        logger.error("  ... and %s more failures (see error CSV for full list).", len(failures) - 20)
    if _run_error_dir:
        _run_error_dir.mkdir(parents=True, exist_ok=True)
        failed_indices = [i for i, _ in failures]
        safe_indices = [min(i, len(records) - 1) for i in failed_indices]
        err_df = records.iloc[safe_indices].copy()
        err_df["_sf_errors"] = [
            " | ".join(f"{e.get('statusCode')}: {e.get('message')}" for e in r.get("errors", []))
            for _, r in failures
        ]
        ts = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
        err_path = _run_error_dir / f"errors_{object_name}_{ts}.csv"
        err_df.to_csv(err_path, index=False)
        logger.error("  Full error list written to %s", err_path)


def upsert_bulk(sf: Salesforce, object_name: str, records: pd.DataFrame, external_id_field: str) -> list[dict[str, Any]]:
    """Upsert records to Salesforce via Bulk API 2.0."""
    if records.empty:
        logger.info("No records for %s; skipping bulk upsert.", object_name)
        return []

    logger.info("%s: upserting %s records...", object_name, len(records))
    records = scrub_invalid_picklist_values(sf, object_name, records)
    if external_id_field in records.columns:
        # Salesforce rejects an entire bulk job that repeats an external id within one payload.
        before = len(records)
        records = records.drop_duplicates(subset=[external_id_field], keep="last")
        if len(records) < before:
            logger.warning("%s: dropped %s duplicate %s rows before upsert.",
                           object_name, before - len(records), external_id_field)
    payload = [_clean_record(rec) for rec in records.to_dict(orient="records")]
    bulk_object = getattr(sf.bulk2, object_name)
    job_results = bulk_object.upsert(records=payload, external_id_field=external_id_field, batch_size=10000)
    if not isinstance(job_results, list):
        job_results = [job_results]

    total_failed = sum(r.get("numberRecordsFailed", 0) for r in job_results)
    total_processed = sum(r.get("numberRecordsProcessed", 0) for r in job_results)
    logger.info("%s: %s succeeded (%s total), %s failed.",
                object_name, total_processed - total_failed, total_processed, total_failed)

    if total_failed:
        for job_result in job_results:
            job_id = job_result.get("job_id")
            if not job_id or not job_result.get("numberRecordsFailed"):
                continue
            try:
                failed_csv = bulk_object.get_failed_records(job_id)
                failed_rows = list(csv.DictReader(failed_csv.splitlines()))
                for row in failed_rows[:20]:
                    logger.error("  [%s=%s] %s", external_id_field,
                                 row.get(external_id_field, "?"), row.get("sf__Error", ""))
                if len(failed_rows) > 20:
                    logger.error("  ... and %s more failures.", len(failed_rows) - 20)
                if _run_error_dir:
                    _run_error_dir.mkdir(parents=True, exist_ok=True)
                    ts = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
                    err_path = _run_error_dir / f"errors_{object_name}_{ts}.csv"
                    pd.DataFrame(failed_rows).to_csv(err_path, index=False)
                    logger.error("  Full error list written to %s", err_path)
            except Exception as exc:
                logger.warning("Could not retrieve failed record details for %s: %s", object_name, exc)
                if _run_error_dir:
                    _run_error_dir.mkdir(parents=True, exist_ok=True)
                    ts = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
                    records.to_csv(_run_error_dir / f"errors_{object_name}_{ts}.csv", index=False)

    return job_results


def insert_bulk(sf: Salesforce, object_name: str, records: pd.DataFrame) -> list[dict[str, Any]]:
    """Insert records to Salesforce via Bulk API 2.0 (no external ID matching)."""
    if records.empty:
        logger.info("No records for %s; skipping bulk insert.", object_name)
        return []

    logger.info("%s: inserting %s records...", object_name, len(records))
    payload = [_clean_record(rec) for rec in records.to_dict(orient="records")]
    bulk_object = getattr(sf.bulk2, object_name)
    job_results = bulk_object.insert(records=payload, batch_size=10000)
    if not isinstance(job_results, list):
        job_results = [job_results]

    total_failed = sum(r.get("numberRecordsFailed", 0) for r in job_results)
    total_processed = sum(r.get("numberRecordsProcessed", 0) for r in job_results)
    logger.info("%s: %s / %s records inserted.", object_name, total_processed - total_failed, total_processed)

    if total_failed:
        for job_result in job_results:
            job_id = job_result.get("job_id")
            if not job_id or not job_result.get("numberRecordsFailed"):
                continue
            try:
                failed_csv = bulk_object.get_failed_records(job_id)
                failed_rows = list(csv.DictReader(failed_csv.splitlines()))
                if _run_error_dir:
                    _run_error_dir.mkdir(parents=True, exist_ok=True)
                    ts = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
                    pd.DataFrame(failed_rows).to_csv(_run_error_dir / f"errors_{object_name}_{ts}.csv", index=False)
                    logger.error("%s: %s failures written to error CSV.", object_name, len(failed_rows))
            except Exception as exc:
                logger.warning("Could not retrieve failed record details for %s: %s", object_name, exc)

    # Build per-record result list in input order; used by build_content_document_links to get ContentNote IDs.
    per_record: list[dict[str, Any]] = [{"success": False, "id": None, "errors": []} for _ in payload]
    key_field = next(iter(payload[0]), None) if payload else None
    if key_field:
        for job_result in job_results:
            job_id = job_result.get("job_id")
            if not job_id:
                continue
            try:
                successful_csv = bulk_object.get_successful_records(job_id)
                id_by_key: dict[str, str] = {}
                for row in csv.DictReader(successful_csv.splitlines()):
                    kv = row.get(key_field, "")
                    sf_id = row.get("sf__Id", "")
                    if kv and sf_id:
                        id_by_key[kv] = sf_id
                for i, orig in enumerate(payload):
                    kv = str(orig.get(key_field, ""))
                    if kv in id_by_key:
                        per_record[i] = {"success": True, "id": id_by_key[kv], "errors": []}
            except Exception as exc:
                logger.warning("Could not retrieve per-record results for %s: %s", object_name, exc)

    return per_record


def build_content_notes(
    notes: pd.DataFrame,
    since_date: str | None = None,
) -> pd.DataFrame:
    """Build ContentNote rows from Bloomerang Notes.csv.

    The `Content` field must be base64-encoded HTML per Salesforce requirements.
    The Bloomerang Note ID is embedded in the Title so later runs can skip notes
    that are already in Salesforce. --since still only filters Notes; it is not a
    general delta pipeline.
    """
    if notes.empty:
        return pd.DataFrame()

    df = notes.copy()

    if since_date and "LastModifiedDate" in df.columns:
        cutoff = pd.to_datetime(since_date, errors="coerce")
        if pd.notna(cutoff):
            df["LastModifiedDate"] = pd.to_datetime(df["LastModifiedDate"], errors="coerce")
            df = df[df["LastModifiedDate"] >= cutoff].copy()
            logger.info("Delta filter: kept %s Notes with LastModifiedDate >= %s.", len(df), since_date)

    if df.empty:
        return pd.DataFrame()

    note_ids = df.get("Id", pd.Series([""] * len(df))).astype(str)
    note_dates = df.get("Date", pd.Series([None] * len(df))).map(parse_date_only).fillna("")
    df["Title"] = "[BM-" + note_ids + "] " + note_dates
    df["Title"] = df["Title"].str.strip()

    def _encode(text: str) -> str:
        # ContentNote expects base64-encoded HTML, not plain text.
        if not text:
            return base64.b64encode(b"<p></p>").decode("utf-8")
        paragraphs = "".join(
            f"<p>{html.escape(line)}</p>" for line in text.split("\n") if line.strip()
        )
        return base64.b64encode(paragraphs.encode("utf-8")).decode("utf-8") if paragraphs else base64.b64encode(b"<p></p>").decode("utf-8")

    def _build_body(row: pd.Series) -> str:
        parts: list[str] = []
        note = str(row.get("Note", "")).strip() if pd.notna(row.get("Note")) else ""
        if note:
            parts.append(note)
        amount = str(row.get("Custom: Amount", "")).strip() if pd.notna(row.get("Custom: Amount")) else ""
        if amount:
            parts.append(f"Amount: {amount}")
        check_num = str(row.get("Custom: Check Number", "")).strip() if pd.notna(row.get("Custom: Check Number")) else ""
        if check_num:
            parts.append(f"Check Number: {check_num}")
        return "\n".join(parts)

    df["Content"] = df.apply(lambda row: _encode(_build_body(row)), axis=1)
    df["_AccountNumber"] = normalize_identifier_series(df.get("AccountNumber", pd.Series([None] * len(df))))

    return df[["Title", "Content", "_AccountNumber"]].copy()


def build_content_document_links(
    cn_results: list[dict[str, Any]],
    content_notes: pd.DataFrame,
    account_ids: dict[str, str],
) -> pd.DataFrame:
    """Build ContentDocumentLink rows to attach ContentNotes to their parent Accounts.

    Must be called after the ContentNote bulk insert so real record IDs are available.
    Row order matches content_notes exactly; rows where the insert failed are skipped.
    """
    if not cn_results or content_notes.empty:
        return pd.DataFrame()

    links = []
    for result, row in zip(cn_results, content_notes.itertuples(index=False)):
        if not result.get("success"):
            logger.warning("ContentNote insert failed for row %s: %s", row.Title, result.get("errors"))
            continue
        content_id = result.get("id")
        acct_num = getattr(row, "_AccountNumber", None)
        sf_account_id = account_ids.get(str(acct_num)) if pd.notna(acct_num) else None
        if content_id and sf_account_id:
            links.append({
                "ContentDocumentId": content_id,
                "LinkedEntityId": sf_account_id,
                "ShareType": "V",
                "Visibility": "AllUsers",
            })
        else:
            logger.debug("Skipping ContentDocumentLink: content_id=%s account_id=%s", content_id, sf_account_id)

    return pd.DataFrame(links)


def _apply_refund_postprocessing(gift_transactions: pd.DataFrame) -> pd.DataFrame:
    """Compute full/partial refund flags and append the refund suffix to Admin_Notes__c."""
    df = gift_transactions.copy()
    amount_col = next((c for c in ("OriginalAmount", "Amount") if c in df.columns), None)
    if "RefundedAmount" in df.columns and amount_col:
        # Refund status is derived after the merge so the comparison uses the original gift amount.
        refunded_mask = df["RefundedAmount"].notna()
        refund_abs = pd.to_numeric(df["RefundedAmount"], errors="coerce").abs()
        original = pd.to_numeric(df[amount_col], errors="coerce").fillna(0)
        df["IsFullyRefunded"] = refunded_mask & (refund_abs >= original)
        df["IsPartiallyRefunded"] = refunded_mask & (refund_abs < original)
    if "_RefundSuffix" in df.columns:
        if "Admin_Notes__c" in df.columns:
            suffix_mask = df["_RefundSuffix"].notna()
            df.loc[suffix_mask, "Admin_Notes__c"] = (
                df.loc[suffix_mask, "Admin_Notes__c"].fillna("") + "\n" + df.loc[suffix_mask, "_RefundSuffix"]
            ).str.strip()
        df = df.drop(columns=["_RefundSuffix"])
    return df


def build_todo_file(data: dict[str, pd.DataFrame], output_dir: Path) -> None:
    """Write todo_manual_fixes.txt listing records that require manual post-migration cleanup."""
    recurring = data.get("RecurringDonations", pd.DataFrame())
    lines: list[str] = []

    if not recurring.empty and "Day2" in recurring.columns:
        day2_records = recurring[
            recurring["Day2"].notna() & (recurring["Day2"].astype(str).str.strip() != "")
        ].copy()
        if not day2_records.empty:
            lines += [
                "=== TWICE-MONTHLY RECURRING SCHEDULES – CONFIGURE SECOND BILLING DAY MANUALLY ===",
                "",
                "These GiftCommitmentSchedule records were migrated with Frequency=Custom because",
                "Bloomerang's 'TwiceMonthly' type cannot be expressed as a single",
                "TransactionPeriod+TransactionInterval combination in NPC. Open each schedule",
                "in Salesforce (find via GiftCommitment.Bloomerang_Commitment_ID__c) and set",
                "the second billing day using the Day2 value shown below.",
                "",
            ]
            for _, row in day2_records.iterrows():
                lines.append(
                    f"  Bloomerang_Commitment_ID__c={str(row.get('TransactionNumber', 'N/A')).strip()}"
                    f"  AccountNumber={str(row.get('AccountNumber', 'N/A')).strip()}"
                    f"  Amount={str(row.get('Amount', 'N/A')).strip()}"
                    f"  Day2={str(row.get('Day2', 'N/A')).strip()}"
                )
            lines.append("")

    if lines:
        output_dir.mkdir(parents=True, exist_ok=True)
        todo_path = output_dir / "todo_manual_fixes.txt"
        todo_path.write_text("\n".join(lines), encoding="utf-8")
        logger.info("Written %s manual-fix items to %s.", sum(1 for ln in lines if ln.startswith("  ")), todo_path)
    else:
        logger.debug("No manual fixes required; todo file not created.")


def ensure_required_tables(export_dir: Path) -> None:
    required = ["Constituents.csv", "Transactions.csv"]
    for name in required:
        if not (export_dir / name).exists():
            raise FileNotFoundError(f"Missing required export table: {name}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bloomerang to Salesforce NPC migration ETL")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=DEFAULT_INPUT_DIR,
        help="Directory containing the Bloomerang export tables. There is no silent fallback if this path is missing.",
    )
    parser.add_argument("--sample-fraction", type=float, default=1.0, help="Fraction of constituents to include. 1.0 = full load. 0.05 = 5%% sample.")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for deterministic sampling.")
    parser.add_argument("--dry-run", action="store_true", help="Transform the data without invoking Salesforce.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Where to write transformed CSVs, logs, and reconciliation.csv.")
    parser.add_argument("--verbose", action="store_true", help="Enable detailed logging.")
    parser.add_argument(
        "--mapping-file",
        type=Path,
        default=None,
        help="Path to field_mapping.csv. Defaults to field_mapping.csv next to this script when that file exists.",
    )
    parser.add_argument(
        "--since",
        type=str,
        default=None,
        help="ISO date (YYYY-MM-DD). Only Notes with LastModifiedDate on or after this date are considered. Does not delta-filter other objects.",
    )
    parser.add_argument(
        "--log-dir",
        type=Path,
        default=None,
        help="Directory for log file and error CSVs from live upserts. Defaults to --output-dir when not set.",
    )
    parser.add_argument(
        "--production",
        action="store_true",
        help="Allow writing to a production Salesforce org (login.salesforce.com or a production instance URL). Default is sandbox only.",
    )
    return parser.parse_args()


def main() -> None:
    global _run_error_dir
    args = parse_args()
    log_dir = args.log_dir or args.output_dir
    configure_logging(args.verbose, log_dir=None if args.dry_run else log_dir)
    if _env_file.exists():
        logger.warning(
            "Loaded credentials from %s. Keep this file off shared drives and revoke the Salesforce session after the run.",
            _env_file,
        )
    logger.warning(
        "--since only filters Notes. Every other object is a full snapshot upsert. "
        "A live re-run overwrites mapped Salesforce fields with Bloomerang values."
    )
    if args.since:
        logger.warning("Note date filter --since=%s is in effect. Existing ContentNotes are still skipped by Title.", args.since)

    mapping: pd.DataFrame | None = None
    mapping_path = args.mapping_file
    if mapping_path is None and DEFAULT_MAPPING_FILE.exists():
        mapping_path = DEFAULT_MAPPING_FILE
        logger.info("Using mapping file %s (found next to the script).", mapping_path)
    if mapping_path:
        mapping = load_mapping(mapping_path)
    else:
        logger.warning(
            "No field_mapping.csv was found. Using the thinner hardcoded builders. "
            "Pass --mapping-file or place field_mapping.csv next to Upsert.py."
        )

    if not args.input_dir.exists():
        raise FileNotFoundError(
            f"Input directory does not exist: {args.input_dir}. "
            "Pass --input-dir pointing at the current Bloomerang export folder."
        )
    ensure_required_tables(args.input_dir)
    data = load_export_dir(args.input_dir, sample_fraction=args.sample_fraction, seed=args.seed)

    # Build Account records – mapping-driven if a mapping file was supplied.
    accounts = (
        build_object_from_mapping("Account", mapping, data, {})
        if mapping is not None
        else build_account_records(data["Constituents"])
    )
    logger.info("Prepared %s Account rows.", len(accounts))

    acct_ext_id = EXTERNAL_ID_FIELDS["Account"]

    address_lines = build_account_address_line_fields(
        data.get("Addresses", pd.DataFrame()),
        constituents=data.get("Constituents"),
    )
    if not address_lines.empty and acct_ext_id in accounts.columns:
        accounts = accounts.merge(address_lines, on=acct_ext_id, how="left")
        logger.info("Merged split address line fields onto Account rows for %s constituents.", len(address_lines))

    comm_fields = build_account_communication_fields(data.get("Constituents", pd.DataFrame()))
    if not comm_fields.empty and acct_ext_id in accounts.columns:
        accounts = accounts.merge(comm_fields, on=acct_ext_id, how="left")
        logger.info("Merged communication restriction fields onto Account rows.")

    accounts = apply_deceased_from_status(accounts, data.get("Constituents", pd.DataFrame()))
    accounts = apply_donor_pathway_typo_fix(accounts)

    dry_ids: dict[str, str] = (
        {str(r[acct_ext_id]): "dry-run" for _, r in accounts.iterrows() if pd.notna(r.get(acct_ext_id))}
        if not accounts.empty and acct_ext_id in accounts.columns
        else {}
    )

    # ContactPointAddress AddressType: Person Accounts use Billing; orgs and households use Shipping.
    # Account custom street-line fields still use Mailing for individuals (see CONSTITUENT_TYPE_TO_ADDRESS_CATEGORY).
    _cons = data.get("Constituents", pd.DataFrame())
    if not _cons.empty and "AccountNumber" in _cons.columns and "Type" in _cons.columns:
        _acct_nums = normalize_identifier_series(_cons["AccountNumber"])
        _types = _cons["Type"].fillna("").astype(str).str.strip()
        address_type_by_account: dict[str, str] = {
            acct: CONTACT_POINT_ADDRESS_TYPE_BY_CONSTITUENT.get(ctype, "Shipping")
            for acct, ctype in zip(_acct_nums.dropna(), _types[_acct_nums.notna()])
        }
    else:
        address_type_by_account = {}

    if args.dry_run:
        output_dir = args.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)

        # Campaigns and GiftDesignations are always built with dedicated Python functions,
        # not the generic mapping engine, because they filter/union rows across tables.
        campaigns = build_campaign_records(data.get("Appeals", pd.DataFrame()))
        campaigns_from_csv = build_campaign_records_from_campaigns(data.get("Campaigns", pd.DataFrame()))
        campaign_ext = EXTERNAL_ID_FIELDS["Campaign"]
        dry_campaign_ids = (
            {str(v): "dry-run" for v in campaigns[campaign_ext].dropna().tolist()}
            if not campaigns.empty and campaign_ext in campaigns.columns
            else {}
        )

        designations = build_designation_records(data, dry_campaign_ids)
        designation_ext = EXTERNAL_ID_FIELDS["GiftDesignation"]
        dry_designation_ids = (
            {str(v): "dry-run" for v in designations[designation_ext].dropna().tolist()}
            if not designations.empty and designation_ext in designations.columns
            else {}
        )

        # Build CampaignFromCSV and GiftTransactionByDesignation lookup maps for dry-run.
        # All IDs are placeholder strings in dry-run; the bridge structure is built from source data shapes.
        dry_campaign_csv_ids: dict[str, str] = (
            {str(v): "dry-run" for v in campaigns_from_csv[CAMPAIGN_CSV_EXTERNAL_ID_FIELD].dropna().tolist()}
            if not campaigns_from_csv.empty and CAMPAIGN_CSV_EXTERNAL_ID_FIELD in campaigns_from_csv.columns
            else {}
        )
        _donations_df = data.get("Donations", pd.DataFrame())
        dry_desig_to_txn: dict[str, str] = (
            {str(d): "dry-run" for d in normalize_identifier_series(_donations_df["DesignationNumber"]).dropna().unique()}
            if not _donations_df.empty and "DesignationNumber" in _donations_df.columns
            else {}
        )

        lookup_maps = {
            "Account": dry_ids,
            "Campaign": dry_campaign_ids,
            "CampaignFromCSV": dry_campaign_csv_ids,
            "GiftDesignation": dry_designation_ids,
            "GiftTransactionByDesignation": dry_desig_to_txn,
            "AddressTypeByAccount": address_type_by_account,
        }

        if not campaigns.empty:
            campaigns.to_csv(output_dir / "Campaign.csv", index=False)
        if not campaigns_from_csv.empty:
            campaigns_from_csv.to_csv(output_dir / "Campaign_from_Campaigns_csv.csv", index=False)
        if not designations.empty:
            designations.to_csv(output_dir / "GiftDesignation.csv", index=False)

        refund_fields = build_gift_transaction_refund_fields(data.get("Refunds", pd.DataFrame()))
        gt_ext_id = EXTERNAL_ID_FIELDS["GiftTransaction"]

        if mapping is not None:
            account_names = build_account_name_lookup(data.get("Constituents", pd.DataFrame()))
            if not accounts.empty:
                accounts.to_csv(output_dir / "Account.csv", index=False)
            for obj_name in ["ContactPointEmail", "ContactPointPhone", "ContactPointAddress", "GiftCommitment"]:
                df = build_object_from_mapping(obj_name, mapping, data, lookup_maps)
                df = apply_required_name_conventions(obj_name, df, data, account_names)
                if obj_name == "GiftCommitment":
                    df = merge_pledge_commitments(
                        df, data.get("Pledges", pd.DataFrame()), lookup_maps, account_names
                    )
                if not df.empty:
                    df.to_csv(output_dir / f"{obj_name}.csv", index=False)

            gift_transactions = build_object_from_mapping("GiftTransaction", mapping, data, lookup_maps)
            gift_transactions = apply_required_name_conventions(
                "GiftTransaction", gift_transactions, data, account_names
            )
            if not refund_fields.empty and not gift_transactions.empty and gt_ext_id in gift_transactions.columns:
                gift_transactions = gift_transactions.merge(refund_fields, on=gt_ext_id, how="left")
                gift_transactions = _apply_refund_postprocessing(gift_transactions)
                logger.info("Merged refund status onto %s GiftTransaction rows.", refund_fields[gt_ext_id].notna().sum())
            if not gift_transactions.empty:
                gift_transactions.to_csv(output_dir / "GiftTransaction.csv", index=False)

            # GiftSoftCredit uses GiftTransactionByDesignation which is now in lookup_maps.
            soft_credits = build_object_from_mapping("GiftSoftCredit", mapping, data, lookup_maps)
            if not soft_credits.empty:
                soft_credits.to_csv(output_dir / "GiftSoftCredit.csv", index=False)

            dry_commitment_ids: dict[str, str] = {}
            gc_ext_id = EXTERNAL_ID_FIELDS["GiftCommitment"]
            gc_dry = build_object_from_mapping("GiftCommitment", mapping, data, lookup_maps)
            gc_dry = apply_required_name_conventions("GiftCommitment", gc_dry, data, account_names)
            gc_dry = merge_pledge_commitments(
                gc_dry, data.get("Pledges", pd.DataFrame()), lookup_maps, account_names
            )
            if not gc_dry.empty and gc_ext_id in gc_dry.columns:
                dry_commitment_ids = {str(v): "dry-run" for v in gc_dry[gc_ext_id].dropna().tolist()}
            lookup_maps["GiftCommitment"] = dry_commitment_ids
            schedules = build_object_from_mapping("GiftCommitmentSchedule", mapping, data, lookup_maps)
            if not schedules.empty:
                schedules.to_csv(output_dir / "GiftCommitmentSchedule.csv", index=False)

            # GiftTransactionDesignation: build with dry-run placeholder IDs
            gtd = pd.DataFrame()
            gtd_ext = EXTERNAL_ID_FIELDS["GiftTransactionDesignation"]
            if gtd_ext in EXTERNAL_ID_FIELDS.values():  # only if field was created in org
                dry_txn_ids = {
                    str(v): "dry-run"
                    for v in gift_transactions[gt_ext_id].dropna().tolist()
                } if not gift_transactions.empty and gt_ext_id in gift_transactions.columns else {}
                gtd = build_gift_transaction_designation_records(
                    data.get("Donations", pd.DataFrame()),
                    dry_txn_ids,
                    dry_designation_ids,
                )
                if not gtd.empty:
                    gtd.to_csv(output_dir / "GiftTransactionDesignation.csv", index=False)
                    logger.info("GiftTransactionDesignation dry-run: %s rows written.", len(gtd))

            content_notes = build_content_notes(data.get("Notes", pd.DataFrame()), since_date=args.since)
            if not content_notes.empty:
                content_notes[["Title", "Content"]].to_csv(output_dir / "ContentNote.csv", index=False)
                logger.info("ContentNote dry-run: %s rows written (ContentDocumentLink requires a live run).", len(content_notes))

            write_reconciliation_report(
                output_dir,
                data,
                {
                    "Account": accounts,
                    "GiftTransaction": gift_transactions,
                    "GiftCommitment": gc_dry,
                    "GiftTransactionDesignation": gtd,
                },
            )
        else:
            for name, df in {
                "Accounts": accounts,
                "ContactPointEmails": build_email_records(data["Emails"], dry_ids),
                "ContactPointPhones": build_phone_records(data["Phones"], dry_ids),
                "ContactPointAddresses": build_address_records(data["Addresses"], dry_ids),
                "GiftCommitments": build_gift_commitment_records(data["Pledges"], data["RecurringDonations"], dry_ids),
                "GiftTransactions": build_gift_transaction_records(data["Transactions"], dry_ids),
            }.items():
                if not df.empty:
                    df.to_csv(output_dir / f"{name}.csv", index=False)

        build_todo_file(data, output_dir)
        logger.info("Dry-run complete. Transformed files written to %s", output_dir)
        return

    sf_config = SalesforceConfig.from_env(allow_production=args.production)
    sf = sf_config.connect()
    _run_error_dir = log_dir
    gift_transactions = pd.DataFrame()
    gift_commitments = pd.DataFrame()
    gtd = pd.DataFrame()
    transaction_ids: dict[str, str] = {}

    # 1. Accounts – Bulk API 2.0 does not accept RecordType.DeveloperName as a reference (it is
    # not an external ID field), so resolve the real RecordTypeId values from the org first.
    if "RecordType.DeveloperName" in accounts.columns:
        rt_ids = query_record_type_ids(sf, "Account")
        needed = set(accounts["RecordType.DeveloperName"].dropna().astype(str).unique())
        missing_rts = needed - set(rt_ids)
        if missing_rts:
            logger.error(
                "Account RecordType DeveloperNames missing from this org: %s. Available: %s. "
                "Confirm in Setup whether individuals should use PersonAccount or Household, then update the mapping.",
                sorted(missing_rts),
                sorted(rt_ids),
            )
        accounts["RecordTypeId"] = accounts["RecordType.DeveloperName"].map(rt_ids)
        accounts = accounts.drop(columns=["RecordType.DeveloperName"])
        logger.info("Resolved Account RecordType IDs: %s", rt_ids)
        # PersonAccount.Name is read-only (compiled from FirstName+LastName) – must not be sent.
        person_acct_id = rt_ids.get("PersonAccount")
        if person_acct_id and "Name" in accounts.columns:
            accounts.loc[accounts["RecordTypeId"] == person_acct_id, "Name"] = pd.NA
        # Org/Household records reject person-specific fields.
        org_ids = {rt_ids.get("Organization"), rt_ids.get("Household")} - {None}
        if org_ids:
            org_mask = accounts["RecordTypeId"].isin(org_ids)
            for _pf in ["FirstName", "LastName", "MiddleName", "Salutation", "Suffix", "PersonBirthdate", "WeGive_Last_Name__c", "PersonDoNotCall"]:
                if _pf in accounts.columns:
                    accounts.loc[org_mask, _pf] = pd.NA
    upsert_bulk(sf, "Account", accounts, acct_ext_id)
    account_ids = query_account_ids(sf, accounts[acct_ext_id].dropna().astype(str).tolist() if acct_ext_id in accounts.columns else [])
    logger.info("Resolved %s Account Ids from Salesforce.", len(account_ids))

    # 2. Campaigns from Appeals (skipping E0 codes) then from Campaigns.csv under a separate external id.
    campaigns = build_campaign_records(data.get("Appeals", pd.DataFrame()))
    campaign_ext = EXTERNAL_ID_FIELDS["Campaign"]
    upsert_bulk(sf, "Campaign", campaigns, campaign_ext)
    campaign_ids = query_external_ids(
        sf, "Campaign", campaign_ext, campaigns[campaign_ext].dropna().astype(str).tolist() if campaign_ext in campaigns.columns else []
    )
    logger.info("Resolved %s Campaign Ids from Salesforce (Appeals).", len(campaign_ids))

    campaigns_from_csv = build_campaign_records_from_campaigns(data.get("Campaigns", pd.DataFrame()))
    upsert_bulk(sf, "Campaign", campaigns_from_csv, CAMPAIGN_CSV_EXTERNAL_ID_FIELD)
    campaign_csv_ids = query_external_ids(
        sf, "Campaign", CAMPAIGN_CSV_EXTERNAL_ID_FIELD,
        campaigns_from_csv[CAMPAIGN_CSV_EXTERNAL_ID_FIELD].dropna().astype(str).tolist() if CAMPAIGN_CSV_EXTERNAL_ID_FIELD in campaigns_from_csv.columns else [],
    )
    logger.info("Resolved %s Campaign Ids from Salesforce (Campaigns.csv).", len(campaign_csv_ids))

    # 3. GiftDesignations
    designations = build_designation_records(data, campaign_ids)
    designation_ext = EXTERNAL_ID_FIELDS["GiftDesignation"]
    upsert_bulk(sf, "GiftDesignation", designations, designation_ext)
    designation_ids = query_external_ids(
        sf, "GiftDesignation", designation_ext, designations[designation_ext].dropna().astype(str).tolist() if designation_ext in designations.columns else []
    )
    logger.info("Resolved %s GiftDesignation Ids from Salesforce.", len(designation_ids))

    lookup_maps = {
        "Account": account_ids,
        "Campaign": campaign_ids,
        "CampaignFromCSV": campaign_csv_ids,
        "GiftDesignation": designation_ids,
        "AddressTypeByAccount": address_type_by_account,
    }

    if mapping is not None:
        account_names = build_account_name_lookup(data.get("Constituents", pd.DataFrame()))
        gc_ext_id = EXTERNAL_ID_FIELDS["GiftCommitment"]
        gift_commitments = pd.DataFrame()

        # 4. Contact points and GiftCommitment (no GiftSoftCredit yet – it needs GiftTransaction IDs).
        for obj_name in ["ContactPointEmail", "ContactPointPhone", "ContactPointAddress", "GiftCommitment"]:
            df = build_object_from_mapping(obj_name, mapping, data, lookup_maps)
            df = apply_required_name_conventions(obj_name, df, data, account_names)
            if obj_name == "GiftCommitment":
                df = merge_pledge_commitments(
                    df, data.get("Pledges", pd.DataFrame()), lookup_maps, account_names
                )
                gift_commitments = df
            ext_id = EXTERNAL_ID_FIELDS.get(obj_name)
            if ext_id and not df.empty:
                upsert_bulk(sf, obj_name, df, ext_id)

        # 4b. GiftCommitmentSchedule – one schedule per RecurringDonation, paused so it does not auto-charge.
        commitment_keys = (
            gift_commitments[gc_ext_id].dropna().astype(str).tolist()
            if not gift_commitments.empty and gc_ext_id in gift_commitments.columns
            else []
        )
        commitment_ids = query_external_ids(sf, "GiftCommitment", gc_ext_id, commitment_keys)
        logger.info("Resolved %s GiftCommitment Ids from Salesforce.", len(commitment_ids))
        lookup_maps["GiftCommitment"] = commitment_ids
        schedules = build_object_from_mapping("GiftCommitmentSchedule", mapping, data, lookup_maps)
        gcs_ext = EXTERNAL_ID_FIELDS["GiftCommitmentSchedule"]
        if not schedules.empty:
            schedules = strip_pause_from_existing_schedules(sf, schedules, gcs_ext)
            upsert_bulk(sf, "GiftCommitmentSchedule", schedules, gcs_ext)

        # 5. GiftTransaction with refund post-processing.
        gift_transactions = build_object_from_mapping("GiftTransaction", mapping, data, lookup_maps)
        gift_transactions = apply_required_name_conventions(
            "GiftTransaction", gift_transactions, data, account_names
        )
        gt_ext_id = EXTERNAL_ID_FIELDS["GiftTransaction"]
        refund_fields = build_gift_transaction_refund_fields(data.get("Refunds", pd.DataFrame()))
        if not refund_fields.empty and not gift_transactions.empty and gt_ext_id in gift_transactions.columns:
            gift_transactions = gift_transactions.merge(refund_fields, on=gt_ext_id, how="left")
            gift_transactions = _apply_refund_postprocessing(gift_transactions)
            logger.info("Merged refund status onto %s GiftTransaction rows.", refund_fields[gt_ext_id].notna().sum())
        upsert_bulk(sf, "GiftTransaction", gift_transactions, gt_ext_id)

        # 6. GiftSoftCredit – build designation→transaction SF-Id bridge from Donations.csv.
        transaction_ids = query_external_ids(
            sf, "GiftTransaction", gt_ext_id,
            gift_transactions[gt_ext_id].dropna().astype(str).tolist() if gt_ext_id in gift_transactions.columns else [],
        )
        logger.info("Resolved %s GiftTransaction Ids from Salesforce.", len(transaction_ids))
        _donations_df = data.get("Donations", pd.DataFrame())
        if not _donations_df.empty and "DesignationNumber" in _donations_df.columns and "TransactionNumber" in _donations_df.columns:
            _desig_to_txn = (
                _donations_df
                .assign(
                    _d=normalize_identifier_series(_donations_df["DesignationNumber"]),
                    _t=normalize_identifier_series(_donations_df["TransactionNumber"]),
                )
                .dropna(subset=["_d", "_t"])
                .drop_duplicates(subset=["_d"])
                .set_index("_d")["_t"]
                .to_dict()
            )
            lookup_maps["GiftTransactionByDesignation"] = {
                d: transaction_ids[t] for d, t in _desig_to_txn.items() if t in transaction_ids
            }
        else:
            lookup_maps["GiftTransactionByDesignation"] = {}
        soft_credits = build_object_from_mapping("GiftSoftCredit", mapping, data, lookup_maps)
        sc_ext_id = EXTERNAL_ID_FIELDS.get("GiftSoftCredit")
        if sc_ext_id and not soft_credits.empty:
            upsert_bulk(sf, "GiftSoftCredit", soft_credits, sc_ext_id)

        # 7. GiftTransactionDesignation – fund allocations per transaction (requires Bloomerang_TxnDesignation_Key__c).
        gtd = build_gift_transaction_designation_records(
            data.get("Donations", pd.DataFrame()), transaction_ids, designation_ids
        )
        gtd_ext = EXTERNAL_ID_FIELDS["GiftTransactionDesignation"]
        if not gtd.empty:
            if salesforce_field_exists(sf, "GiftTransactionDesignation", gtd_ext):
                upsert_bulk(sf, "GiftTransactionDesignation", gtd, gtd_ext)
            else:
                logger.error(
                    "Skipping GiftTransactionDesignation: custom field %s is not in the org. "
                    "Create it as Text (External ID Unique) on GiftTransactionDesignation in Setup, then re-run to load fund splits.",
                    gtd_ext,
                )
    else:
        upsert_bulk(sf, "ContactPointEmail", build_email_records(data["Emails"], account_ids), "Bloomerang_Email_Key__c")
        upsert_bulk(sf, "ContactPointPhone", build_phone_records(data["Phones"], account_ids), "Bloomerang_Phone_Key__c")
        upsert_bulk(sf, "ContactPointAddress", build_address_records(data["Addresses"], account_ids), "Bloomerang_Address_Key__c")
        upsert_bulk(sf, "GiftCommitment", build_gift_commitment_records(data["Pledges"], data["RecurringDonations"], account_ids), "Bloomerang_Commitment_ID__c")
        upsert_bulk(sf, "GiftTransaction", build_gift_transaction_records(data["Transactions"], account_ids), "Bloomerang_Transaction_ID__c")

    # 7. ContentNote + ContentDocumentLink (always runs regardless of mapping mode).
    content_notes = build_content_notes(data.get("Notes", pd.DataFrame()), since_date=args.since)
    if not content_notes.empty:
        existing_titles = query_existing_content_note_titles(
            sf, content_notes["Title"].dropna().astype(str).tolist()
        )
        if existing_titles is None:
            logger.error(
                "Skipping ContentNote insert because existing titles could not be queried. "
                "Refusing to insert notes that may already exist."
            )
            content_notes = pd.DataFrame()
        elif existing_titles:
            before_notes = len(content_notes)
            content_notes = content_notes.loc[~content_notes["Title"].isin(existing_titles)].copy()
            skipped_notes = before_notes - len(content_notes)
            if skipped_notes:
                logger.info(
                    "Skipped %s ContentNotes that already exist in Salesforce (matched on Title).",
                    skipped_notes,
                )
    if not content_notes.empty:
        cn_payload = content_notes[["Title", "Content"]].copy()
        cn_results = insert_bulk(sf, "ContentNote", cn_payload)
        logger.info("Inserted %s ContentNote records.", sum(1 for r in cn_results if r.get("success")))
        links = build_content_document_links(cn_results, content_notes, account_ids)
        if not links.empty:
            insert_bulk(sf, "ContentDocumentLink", links)
            logger.info("Inserted %s ContentDocumentLink records.", len(links))

    args.output_dir.mkdir(parents=True, exist_ok=True)
    build_todo_file(data, args.output_dir)
    prepared_for_recon = {
        "Account": accounts,
        "GiftTransaction": gift_transactions,
        "GiftCommitment": gift_commitments,
        "GiftTransactionDesignation": gtd,
    }
    live_resolved = {
        "Account": len(account_ids),
        "GiftTransaction": len(transaction_ids),
    }
    write_reconciliation_report(args.output_dir, data, prepared_for_recon, live_resolved=live_resolved)
    logger.info("Migration finished.")


if __name__ == "__main__":
    main()
