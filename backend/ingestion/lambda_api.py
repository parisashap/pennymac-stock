from datetime import date, timedelta, datetime, timezone
from decimal import Decimal
import boto3, json, logging, os, requests

logger = logging.getLogger(__name__)

MASSIVE_RANGE_URL = "https://api.massive.com/v2/aggs/ticker/{ticker}/range/1/day/{start}/{end}"

CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    # Cache movers for 5 min — data only changes once daily after 6 PM EDT
    "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
}

HISTORY_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    # Cache history for 1 hour — 52-week data is stable
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=300",
}


def _to_jsonable(value):
    if isinstance(value, Decimal): return float(value)
    if isinstance(value, dict): return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list): return [_to_jsonable(v) for v in value]
    return value


def fetch_last_winners(table_name, limit=7):
    table = boto3.resource("dynamodb").Table(table_name)
    items, scan_kwargs = [], {
        "ProjectionExpression": "#dt, ticker, close_price, percent_change, open_price, sp500_pct_change, beta, week52_high, week52_low",
        "ExpressionAttributeNames": {"#dt": "date"},
    }
    while True:
        response = table.scan(**scan_kwargs)
        items.extend(response.get("Items", []))
        if not response.get("LastEvaluatedKey"): break
        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
    items = sorted(items, key=lambda x: x.get("date", ""), reverse=True)
    seen, result = set(), []
    for item in items:
        d = item.get("date")
        if d and d not in seen:
            seen.add(d)
            result.append(item)
        if len(result) >= limit: break
    return result


def fetch_price_history(ticker: str, api_key: str) -> list[dict]:
    today = date.today()
    start = (today - timedelta(days=365)).isoformat()
    url = MASSIVE_RANGE_URL.format(ticker=ticker, start=start, end=today.isoformat())
    resp = requests.get(url, params={"apiKey": api_key, "sort": "asc", "limit": 260}, timeout=10)
    resp.raise_for_status()
    out = []
    for r in resp.json().get("results", []):
        ts = r.get("t")
        close = r.get("c")
        if ts and close:
            day = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).date().isoformat()
            out.append({"date": day, "close": round(float(close), 2)})
    return out


def lambda_handler(event, context):
    path = event.get("path", "/movers")
    table_name = os.getenv("DYNAMODB_TABLE_NAME", "stock_mover_table")

    # ── GET /history?ticker=NVDA ─────────────────────────────
    if path == "/history":
        ticker = (event.get("queryStringParameters") or {}).get("ticker", "").upper()
        if not ticker:
            return {"statusCode": 400, "headers": CORS_HEADERS,
                    "body": json.dumps({"error": "ticker query param required"})}
        api_key = os.getenv("MASSIVE_API_KEY")
        if not api_key:
            return {"statusCode": 500, "headers": CORS_HEADERS,
                    "body": json.dumps({"error": "MASSIVE_API_KEY not configured"})}
        print(f"[API] /history {ticker}")
        try:
            data = fetch_price_history(ticker, api_key)
            print(f"[API] /history {ticker} → {len(data)} points")
            return {"statusCode": 200, "headers": HISTORY_HEADERS, "body": json.dumps(data)}
        except Exception as exc:
            print(f"[API] /history FAILED — {exc}")
            return {"statusCode": 500, "headers": CORS_HEADERS,
                    "body": json.dumps({"error": str(exc)})}

    # ── GET /movers ──────────────────────────────────────────
    print(f"[API] /movers — table: {table_name}")
    try:
        movers = [_to_jsonable(i) for i in fetch_last_winners(table_name)]
        print(f"[API] Returning {len(movers)} records")
        return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps(movers)}
    except Exception as exc:
        print(f"[API] FAILED — {exc}")
        logger.exception("Failed to fetch movers")
        return {"statusCode": 500, "body": json.dumps({"error": str(exc)})}
