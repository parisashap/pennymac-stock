from ingestion import WATCHLIST, determine_daily_winner, fetch_market_context, load_local_env, to_dynamodb_record
import boto3, json, logging, os
from decimal import Decimal

logger = logging.getLogger(__name__)

def lambda_handler(event, context):
    load_local_env()
    table_name = os.getenv("DYNAMODB_TABLE_NAME", "stock_mover_table")
    api_key = os.getenv("MASSIVE_API_KEY")

    # Skip Sunday — cron runs Tue-Sat to fetch previous day's data; Sunday has no prior trading day
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).weekday()  # 0=Mon ... 6=Sun
    if today == 6:
        print("[HANDLER] Skipping — today is Sunday, no prior trading day to fetch.")
        return {"statusCode": 200, "body": json.dumps({"message": "Skipped (Sunday)"})}

    print(f"[HANDLER] Starting ingestion — table: {table_name}")

    if not api_key:
        print("[HANDLER] ERROR: MASSIVE_API_KEY is not set")
        return {"statusCode": 400, "body": json.dumps({"error": "MASSIVE_API_KEY is not set"})}

    try:
        winner = determine_daily_winner(WATCHLIST, api_key)
        print(f"[HANDLER] Enriching record with market context for {winner.ticker}...")
        ctx = fetch_market_context(winner.ticker, api_key)
        record = to_dynamodb_record(winner, market_context=ctx)
        print(f"[HANDLER] Writing to DynamoDB: {record}")
        boto3.resource("dynamodb").Table(table_name).put_item(Item=record)
        print(f"[HANDLER] SUCCESS — stored {record['ticker']} for {record['date']}")
        return {"statusCode": 200, "body": json.dumps({"message": "Stored", "ticker": record["ticker"]})}
    except Exception as exc:
        print(f"[HANDLER] FAILED — {exc}")
        logger.exception("Ingestion failed")
        return {"statusCode": 500, "body": json.dumps({"error": str(exc)})}