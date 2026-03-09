# Stock Pipeline — Daily Mover Dashboard

A serverless AWS pipeline that tracks a watchlist of tech stocks, finds the biggest (absolute  % change) daily mover, and displays it on a live dashboard with price charts and market context.

**Live Website Link:** https://d352bbeld15umk.cloudfront.net

---

## What it does

Every weekday at 22:00 UTC (2:00 PM PST / 5:00 PM ET), a Lambda function fetches that day's data for 6 tickers, picks the biggest mover by absolute % change, enriches it with beta and 52-week range, and stores it in DynamoDB. A React frontend pulls from an API Gateway endpoint and renders the winner card, price history chart, and S&P 500 comparison.

**Watchlist Companies:** Apple · Microsoft · Google · Amazon · Telsa · Nvidia

---

## Architecture 

```
EventBridge (cron Mon-Fri 22:00 UTC)
        │
        ▼
Lambda: stock-ingest
  ├── Fetches prev-day data for 6 tickers (Massive API)
  ├── Picks biggest mover by absolute % change
  ├── Enriches: S&P 500 comparison, beta, and 52-week range
  └── Writes one record to DynamoDB with those fields fetched from Massive API
        │
        ▼
DynamoDB: stock_mover_table
  └── Partition (primary) key: date (ISO string)
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
        └── deploy.yml          # CI/CD: auto-deploy on push to main on GitHub
```

---

## How to Deploy

### Prerequisites
- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.3
- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- [Node.js](https://nodejs.org/) >= 18
- A [Massive API](https://massive.com) key (free tier)

### 1. Clone the repo
```bash
git clone https://github.com/parisashap/stockpipeline-mac.git
cd stockpipeline-mac
```

### 2. Deploy infrastructure
```bash
cd infrastructure
terraform init
terraform apply -var="massive_api_key=YOUR_MASSIVE_API_KEY"
```
This provisions DynamoDB, two Lambdas, EventBridge rule, API Gateway, S3, and CloudFront.

### 3. Deploy Lambda code
```bash
cd backend/ingestion
pip install requests boto3 python-dotenv --target .
zip -r ../../lambda_deploy.zip . --exclude "*.pyc" --exclude "__pycache__/*"

aws lambda update-function-code --function-name stock-ingest --zip-file fileb://../../lambda_deploy.zip --region us-west-1
aws lambda update-function-code --function-name stock-api --zip-file fileb://../../lambda_deploy.zip --region us-west-1
```

### 4. Build and deploy frontend
```bash
cd frontend
npm install && npm run build
aws s3 sync dist s3://YOUR_S3_BUCKET --delete
aws cloudfront create-invalidation --distribution-id YOUR_CF_ID --paths "/*"
```

> After the first deploy, all future deploys are handled automatically by GitHub Actions on every push to `main`.

---

## CI/CD

Every push to `main` automatically deploys both Lambda functions and rebuilds + syncs the frontend to S3 via GitHub Actions. CloudFront cache is invalidated on each deploy.

---

## Security

- No secrets in source code — API key stored as Lambda env var, injected by Terraform
- Least-privilege IAM — `stock-ingest` has only `dynamodb:PutItem`; `stock-api` has only `dynamodb:Scan` + `dynamodb:GetItem`
- `.gitignore` excludes `.env`, `*.tfvars`, and all other credential files
- Weekend guard — Lambda skips execution on Saturday/Sunday because the market is closed on the weekends

---

## Challenges & Trade-offs

A big part of this project was learning Terraform while also learning how to connect the rest of the AWS stack. The hardest part was not writing any single component in isolation, but getting Lambda, DynamoDB, API Gateway, EventBridge, S3, CloudFront, and GitHub Actions to work together effortlessly. I also learned a lot about infrastructure as code through Terraform. One of the biggest benefits was how much easier it became to update and manage the AWS resources as the project changed, rather than manually reconfiguring pieces of the stack.

One trade-off came from using the free tier of the Massive API. The API rate-limits pretty aggressively, so the ingestion Lambda includes a 12-second delay between ticker requests and retries on HTTP 429 responses. That keeps the pipeline reliable enough to stay within Lambda's timeout, but it also means a full ingestion run takes roughly two minutes. A paid tier or a different market data source would make this much faster.