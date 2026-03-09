# -*- coding: utf-8 -*-
"""
Backfill sp500_pct_change, beta, week52_high, week52_low for existing DynamoDB
records that were stored before market-context enrichment was added.

Each record already has: date, ticker, close_price, percent_change, open_price
This script adds the missing fields by fetching 52-week history from the Massive API.

Usage:
    cd backend/ingestion
    python3 backfill_enrichment.py
"""

import os, time, requests, boto3
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv

load_dotenv()

API_KEY    = os.getenv("MASSIVE_API_KEY")
TABLE_NAME = os.getenv("DYNAMODB_TABLE_NAME", "stock_mover_table")
RANGE_URL  = "https://api.massive.com/v2/aggs/ticker/{ticker}/range/1/day/{start}/{end}"
SPACING    = 12  # seconds between API calls to respect rate limits


def fetch_ohlc(ticker, start, end):
    resp = requests.get(
        RANGE_URL.format(ticker=ticker, start=start, end=end),
        params={"apiKey": API_KEY, "sort": "asc", "limit": 260},
        timeout=15,
    )
    resp.raise_for_status()
    rows = []
    for r in resp.json().get("results", []):
        o, c, h, l = r.get("o", 0), r.get("c", 0), r.get("h", 0), r.get("l", 0)
        pct = ((c - o) / o * 100) if o else 0.0
        ts = r.get("t")
        date = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).date().isoformat() if ts else None
        rows.append({"date": date, "close": c, "high": h, "low": l, "pct": pct})
    return rows


def enrich(ticker, record_date):
    """Fetch 52-week history and compute enrichment fields for a given ticker and date."""
    end   = record_date
    start = (datetime.fromisoformat(record_date) - timedelta(days=365)).date().isoformat()

    print(f"  Fetching {ticker} history {start} to {end}...")
    stock = fetch_ohlc(ticker, start, end)
    time.sleep(SPACING)

    print(f"  Fetching SPY history {start} to {end}...")
    spy = fetch_ohlc("SPY", start, end)
    time.sleep(SPACING)

    # S&P 500 % change on the exact record date
    spy_on_date = next((r["pct"] for r in spy if r["date"] == record_date), None)
    if spy_on_date is None and spy:
        spy_on_date = spy[-1]["pct"]  # fallback to last available candle

    # 52-week high/low from daily candles
    week52_high = max((r["high"] for r in stock), default=0.0)
    week52_low  = min((r["low"]  for r in stock if r["low"] > 0), default=0.0)

    # Beta = cov(stock_returns, spy_returns) / var(spy_returns)
    stock_rets = [r["pct"] for r in stock]
    spy_rets   = [r["pct"] for r in spy]
    n = min(len(stock_rets), len(spy_rets))
    beta = 1.0
    if n > 10:
        s, m = stock_rets[-n:], spy_rets[-n:]
        ms, mm = sum(s) / n, sum(m) / n
        cov = sum((si - ms) * (mi - mm) for si, mi in zip(s, m)) / (n - 1)
        var = sum((mi - mm) ** 2 for mi in m) / (n - 1)
        beta = round(cov / var, 2) if var else 1.0

    return {
        "sp500_pct_change": round(spy_on_date or 0.0, 4),
        "beta":             beta,
        "week52_high":      round(week52_high, 2),
        "week52_low":       round(week52_low,  2),
    }


def main():
    if not API_KEY:
        print("ERROR: MASSIVE_API_KEY not set in .env")
        return

    table = boto3.resource("dynamodb", region_name="us-west-1").Table(TABLE_NAME)

    # Scan for records missing the 'beta' field (proxy for all enrichment fields)
    print("Scanning DynamoDB for records missing enrichment fields...")
    resp = table.scan(
        FilterExpression="attribute_not_exists(beta)",
        ProjectionExpression="#dt, ticker",
        ExpressionAttributeNames={"#dt": "date"},
    )
    items = resp.get("Items", [])

    if not items:
        print("All records already have enrichment fields. Nothing to do.")
        return

    print(f"Found {len(items)} record(s) to backfill: {[i['date'] for i in items]}\n")

    for item in sorted(items, key=lambda x: x["date"]):
        date   = item["date"]
        ticker = item["ticker"]
        print(f"Backfilling {ticker} on {date}...")
        try:
            fields = enrich(ticker, date)
            print(f"  sp500={fields['sp500_pct_change']}% | beta={fields['beta']} "
                  f"| 52W {fields['week52_low']}-{fields['week52_high']}")
            table.update_item(
                Key={"date": date},
                UpdateExpression="SET sp500_pct_change=:s, beta=:b, week52_high=:h, week52_low=:l",
                ExpressionAttributeValues={
                    ":s": Decimal(str(fields["sp500_pct_change"])),
                    ":b": Decimal(str(fields["beta"])),
                    ":h": Decimal(str(fields["week52_high"])),
                    ":l": Decimal(str(fields["week52_low"])),
                },
            )
            print(f"  OK - Updated {date}\n")
        except Exception as exc:
            print(f"  FAILED for {date}: {exc}\n")


if __name__ == "__main__":
    main()
