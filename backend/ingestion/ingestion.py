from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from datetime import datetime, timedelta, timezone
import logging
import time
from typing import Iterable, Optional

import requests

WATCHLIST = ("AAPL", "AMZN", "GOOGL", "MSFT", "NVDA", "TSLA")
DEFAULT_MASSIVE_API_URL = "https://api.massive.com/v2/aggs/ticker/{ticker}/prev"
MASSIVE_RANGE_URL = "https://api.massive.com/v2/aggs/ticker/{ticker}/range/1/day/{start}/{end}"
DEFAULT_MAX_RETRIES = 1
DEFAULT_RETRY_DELAY_SECONDS = 60
DEFAULT_REQUEST_SPACING_SECONDS = 12

logger = logging.getLogger(__name__)


@dataclass
class StockMovement:
    ticker: str
    open_price: float
    close_price: float
    percent_change: float
    date: Optional[str] = None  # actual trading date from API (YYYY-MM-DD)

    @property
    def absolute_change(self) -> float:
        return abs(self.percent_change)


def load_local_env() -> None:
    """Load environment variables from .env for local execution."""
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        logger.debug("python-dotenv is not installed; skipping .env load.")
    except Exception as exc:
        logger.warning("Failed to load .env file: %s", exc)


def _wait_seconds_for_retry(delay: float, attempt: int) -> float:
    """Simple exponential backoff with a small cap."""
    return delay * (2 ** attempt)


def _parse_quote(
    ticker: str,
    quote: dict,
) -> StockMovement:
    try:
        open_price = float(quote["o"])
        close_price = float(quote["c"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"Unexpected payload format for {ticker}: {quote}") from exc

    if open_price == 0:
        raise RuntimeError(f"Open price is 0 for {ticker}; cannot compute percent change.")

    percent_change = ((close_price - open_price) / open_price) * 100

    # Extract the actual trading date from the API timestamp
    trading_date = None
    ts = quote.get("t")
    if ts:
        trading_date = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).date().isoformat()

    return StockMovement(
        ticker=ticker,
        open_price=open_price,
        close_price=close_price,
        percent_change=percent_change,
        date=trading_date,
    )


def fetch_stock_movement(
    ticker: str,
    api_key: str,
    timeout: int = 10,
    max_retries: int = DEFAULT_MAX_RETRIES,
    retry_delay: float = DEFAULT_RETRY_DELAY_SECONDS,
) -> StockMovement:
    """Fetch previous-day open/close from Massive and compute percent change."""
    url = DEFAULT_MASSIVE_API_URL.format(ticker=ticker)
    params = {"apiKey": api_key}

    for attempt in range(max_retries + 1):
        try:
            response = requests.get(url, params=params, timeout=timeout)
            response.raise_for_status()
            break
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status == 429 and attempt < max_retries:
                logger.warning(
                    "Rate limited for %s (attempt %s/%s). Retrying in %.2f seconds.",
                    ticker,
                    attempt + 1,
                    max_retries,
                    _wait_seconds_for_retry(retry_delay, attempt + 1),
                )
                time.sleep(_wait_seconds_for_retry(retry_delay, attempt + 1))
                continue
            raise RuntimeError(f"Failed to fetch data for {ticker}: {exc}") from exc
        except requests.RequestException as exc:
            raise RuntimeError(f"Failed to fetch data for {ticker}: {exc}") from exc

    payload = response.json()
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        raise RuntimeError(f"No market data returned for {ticker}.")

    return _parse_quote(ticker, results[0])


def determine_daily_winner(
    watchlist: Iterable[str],
    api_key: str,
    timeout: int = 10,
    request_spacing_seconds: float = DEFAULT_REQUEST_SPACING_SECONDS,
    max_failures: int = 2,
) -> StockMovement:
    """
    Return the stock with the largest absolute daily move.

    request_spacing_seconds: pause between tickers to avoid rate limits.
    max_failures: error is raised when more than this many tickers fail.
    """
    winner: Optional[StockMovement] = None
    errors: list[str] = []
    failures = 0
    total = 0

    watchlist_items = list(watchlist)
    print(f"[INGEST] Scanning {len(watchlist_items)} tickers: {', '.join(watchlist_items)}")

    for ticker in watchlist_items:
        total += 1
        print(f"[INGEST] [{total}/{len(watchlist_items)}] processing {ticker}")
        if total > 1 and request_spacing_seconds > 0:
            time.sleep(request_spacing_seconds)
            print(f"[INGEST] Sleeping {request_spacing_seconds}s before {ticker}")

        try:
            movement = fetch_stock_movement(ticker, api_key, timeout=timeout)
        except RuntimeError as exc:
            print(f"[INGEST] Skip {ticker}: {exc}")
            logger.warning("Skipping %s: %s", ticker, exc)
            errors.append(f"{ticker}: {exc}")
            failures += 1

            if max_failures is not None and failures > max_failures:
                raise RuntimeError(
                    f"Too many API failures ({failures}/{total}): "
                    + "; ".join(errors)
                )
            continue

        if (
            winner is None
            or movement.absolute_change > winner.absolute_change
            or (
                movement.absolute_change == winner.absolute_change
                and movement.ticker > winner.ticker
            )
        ):
            winner = movement
            print(
                f"[INGEST] New leader: {winner.ticker}, "
                f"percent_change={winner.percent_change:.4f}"
            )

    if winner is None:
        if errors:
            raise RuntimeError("No stock data could be fetched: " + "; ".join(errors))
        raise RuntimeError("No winners were determined from the watchlist.")

    print(
        f"[INGEST] Winner selected: {winner.ticker}, "
        f"percent_change={winner.percent_change:.4f}, close={winner.close_price:.2f}"
    )
    return winner


def _fetch_ohlc_history(ticker: str, api_key: str, start: str, end: str) -> list[dict]:
    """Fetch daily OHLC history for a ticker over a date range."""
    url = MASSIVE_RANGE_URL.format(ticker=ticker, start=start, end=end)
    try:
        resp = requests.get(
            url,
            params={"apiKey": api_key, "sort": "asc", "limit": 260},
            timeout=15,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("Failed to fetch history for %s: %s", ticker, exc)
        return []
    data = []
    for r in resp.json().get("results", []):
        o, c, h, l = r.get("o", 0), r.get("c", 0), r.get("h", 0), r.get("l", 0)
        pct = ((c - o) / o * 100) if o else 0.0
        data.append({"close": c, "high": h, "low": l, "pct": pct})
    return data


def fetch_market_context(winner_ticker: str, api_key: str) -> dict:
    """
    Fetch S&P 500 performance, beta, and 52-week high/low for the winning stock.
    Makes 2 API calls (winner history + SPY history) with rate-limit spacing.
    """
    today = datetime.now(timezone.utc).date()
    start_52w = (today - timedelta(days=365)).isoformat()
    end = today.isoformat()

    print(f"[ENRICH] Fetching 52wk history for {winner_ticker}...")
    time.sleep(DEFAULT_REQUEST_SPACING_SECONDS)
    stock_history = _fetch_ohlc_history(winner_ticker, api_key, start_52w, end)

    print("[ENRICH] Fetching 52wk history for SPY...")
    time.sleep(DEFAULT_REQUEST_SPACING_SECONDS)
    spy_history = _fetch_ohlc_history("SPY", api_key, start_52w, end)

    # S&P 500 % change from last SPY candle
    sp500_pct = spy_history[-1]["pct"] if spy_history else 0.0

    # 52-week high/low
    week52_high = max((d["high"] for d in stock_history), default=0.0)
    week52_low = min((d["low"] for d in stock_history if d["low"] > 0), default=0.0)

    # Beta = cov(stock, spy) / var(spy) over trailing 52 weeks
    stock_rets = [d["pct"] for d in stock_history]
    spy_rets = [d["pct"] for d in spy_history]
    n = min(len(stock_rets), len(spy_rets))
    beta = 1.0
    if n > 10:
        s, m = stock_rets[-n:], spy_rets[-n:]
        ms, mm = sum(s) / n, sum(m) / n
        cov = sum((si - ms) * (mi - mm) for si, mi in zip(s, m)) / (n - 1)
        var = sum((mi - mm) ** 2 for mi in m) / (n - 1)
        beta = round(cov / var, 2) if var else 1.0

    print(
        f"[ENRICH] sp500={sp500_pct:.4f}% | beta={beta} "
        f"| 52w H={week52_high:.2f} L={week52_low:.2f}"
    )
    return {
        "sp500_pct_change": round(sp500_pct, 4),
        "beta": beta,
        "week52_high": round(week52_high, 2),
        "week52_low": round(week52_low, 2),
    }


def to_dynamodb_record(
    movement: StockMovement,
    date: Optional[str] = None,
    market_context: Optional[dict] = None,
) -> dict:
    """Convert a movement to DynamoDB-friendly attribute format."""
    # Priority: explicit date arg > actual trading date from API > today (last resort)
    record_date = date or movement.date or datetime.now(timezone.utc).date().isoformat()
    record: dict = {
        "date": record_date,
        "ticker": movement.ticker,
        "open_price": Decimal(str(movement.open_price)),
        "close_price": Decimal(str(movement.close_price)),
        "percent_change": Decimal(str(movement.percent_change)),
    }
    if market_context:
        record["sp500_pct_change"] = Decimal(str(market_context["sp500_pct_change"]))
        record["beta"] = Decimal(str(market_context["beta"]))
        record["week52_high"] = Decimal(str(market_context["week52_high"]))
        record["week52_low"] = Decimal(str(market_context["week52_low"]))
    return record
