# Stock Pipeline — Daily Mover Dashboard

A serverless AWS pipeline that tracks a watchlist of tech stocks, finds the biggest daily mover, and displays it on a live dashboard with price charts and market context.

**Live Demo:** https://d352bbeld15umk.cloudfront.net

---

## What it does

Every weekday at 10 PM UTC, a Lambda function fetches the previous day's OHLC data for 6 tickers, picks the biggest mover by absolute % change, enriches it with beta and 52-week range, and stores it in DynamoDB. A React frontend pulls from an API Gateway endpoint and renders the winner card, price history chart, and S&P 500 comparison.

**Watchlist:** AAPL · MSFT · GOOGL · AMZN · TSLA · NVDA

---

## Architecture

```
EventBridge (cron Mon-Fri 22:00 UTC)
        │
        ▼
Lambda: stock-ingest
  ├── Fetches prev-day OHLC for 6 tickers (Massive API)
  ├── Picks biggest mover by absolute % change
  ├── Enriches: S&P 500 comparison, beta, 52-week range
  └── Writes one record to DynamoDB
        │
        ▼
DynamoDB: stock_mover_table
  └── Partition key: date (ISO string)
        │
        ▼
API Gateway ──► Lambda: stock-api
  ├── GET /movers    → last 7 trading days
  └── GET /history   → 52-week price history
        │
        ▼
React SPA (Vite + Recharts)
  ├── Winner card: ticker, price, % change, beta, vs S&P 500, 52W range
  ├── Price history chart (area chart)
  └── Recent movers table
        │
        ▼
S3 + CloudFront (public HTTPS)
```

---

## My Tech Stack

- **Infrastructure:** Terraform
- **Compute:** AWS Lambda (Python 3.11)
- **Scheduler:** Amazon EventBridge
- **Database:** Amazon DynamoDB
- **API:** Amazon API Gateway
- **Frontend:** React + Vite + Recharts (Node.js 20)
- **Hosting:** AWS S3 + CloudFront
- **Stock Data:** Massive API
- **CI/CD:** GitHub Actions

---

## Project Structure

```
stockpipeline-mac/
├── backend/
│   └── ingestion/
│       ├── ingestion.py        # Core logic: fetch, compute, enrich
│       ├── lambda_ingest.py    # EventBridge handler (daily cron)
│       ├── lambda_api.py       # API Gateway handler (/movers, /history)
│       └── requirements.txt
├── frontend/
│   └── src/
│       ├── App.jsx             # Main dashboard UI
│       └── App.css
├── infrastructure/
│   ├── main.tf                 # All AWS resources
│   ├── variables.tf
│   └── outputs.tf
└── .github/
    └── workflows/
        └── deploy.yml          # CI/CD: auto-deploy on push to main
```

---

## CI/CD

Every push to `main` automatically deploys both Lambda functions and rebuilds + syncs the frontend to S3 via GitHub Actions. CloudFront cache is invalidated on each deploy.

---

## Security

- No secrets in source code — API key stored as Lambda env var, injected by Terraform
- Least-privilege IAM — `stock-ingest` has only `dynamodb:PutItem`; `stock-api` has only `dynamodb:Scan` + `dynamodb:GetItem`
- `.gitignore` excludes `.env`, `*.tfvars`, and all credential files
- Weekend guard — Lambda skips execution on Saturday/Sunday

---

## Challenges & Trade-offs

**Infrastructure was the biggest learning curve.** I hadn't worked with Terraform before and figuring out how to split responsibilities between two Lambda functions — one for ingestion, one for the API — took some trial and error. Getting them to work together with the right IAM roles, API Gateway routing, and EventBridge trigger all wired up correctly was the most complex part of the project.

**Connecting all the pieces.** The hardest part wasn't writing any single component, it was making sure everything talked to each other correctly — Lambda writing to DynamoDB, API Gateway invoking the right handler, CloudFront serving the frontend while API Gateway handled the backend, and GitHub Actions deploying all of it automatically on push.

**Rate limits on the free tier.** The Massive API rate-limits pretty aggressively. The ingestion Lambda adds a 12-second delay between each ticker request and retries on 429s, which means the full run takes around 2 minutes. It works within Lambda's timeout but it's not fast — a paid tier or a different data source would fix this.

**DynamoDB at this scale is simple by design.** One record per trading day means the table stays tiny and a full scan is fine. 

**Beta is computed once, not on every request.** Rather than recalculating beta (covariance over 52 weeks of returns) on every API call, it gets computed during ingestion and stored. Keeps the frontend fast and the API stateless.
