# ============================================================
# main.tf — Core infrastructure for the stock pipeline
#
# Resources created:
#   - DynamoDB table (stock_mover_table)
#   - IAM roles + least-privilege policies for both Lambdas
#   - Lambda: stock-ingest  (EventBridge cron trigger)
#   - Lambda: stock-api     (API Gateway trigger)
#   - EventBridge rule      (daily cron at 13:00 UTC Tue-Sat)
#   - API Gateway REST API  (GET /movers)
# ============================================================

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.3"
}

provider "aws" {
  region = var.aws_region
}

# ============================================================
# DynamoDB — stores one record per trading day
# ============================================================

resource "aws_dynamodb_table" "stock_movers" {
  name         = var.dynamodb_table_name
  billing_mode = "PAY_PER_REQUEST" # no capacity planning needed for low-volume writes

  hash_key = "date" # partition key — ISO date string e.g. "2025-03-07"

  attribute {
    name = "date"
    type = "S"
  }

  tags = {
    Project = "stockpipeline"
  }
}

# ============================================================
# IAM — shared assume-role policy (both Lambdas use this)
# ============================================================

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ============================================================
# IAM — stock-ingest role (DynamoDB write only)
# ============================================================

resource "aws_iam_role" "stock_ingest" {
  name               = "stock-ingest-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "stock_ingest_policy" {
  # Allow writing new records to the movers table
  statement {
    sid       = "DynamoDBWrite"
    effect    = "Allow"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.stock_movers.arn]
  }

  # Allow Lambda to push logs to CloudWatch
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_role_policy" "stock_ingest" {
  name   = "stock-ingest-policy"
  role   = aws_iam_role.stock_ingest.id
  policy = data.aws_iam_policy_document.stock_ingest_policy.json
}

# ============================================================
# IAM — stock-api role (DynamoDB read only)
# ============================================================

resource "aws_iam_role" "stock_api" {
  name               = "stock-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "stock_api_policy" {
  # Allow reading records from the movers table
  # Scan is used by fetch_last_winners(); GetItem covers point lookups
  statement {
    sid       = "DynamoDBRead"
    effect    = "Allow"
    actions   = ["dynamodb:Scan", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.stock_movers.arn]
  }

  # Allow Lambda to push logs to CloudWatch
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_role_policy" "stock_api" {
  name   = "stock-api-policy"
  role   = aws_iam_role.stock_api.id
  policy = data.aws_iam_policy_document.stock_api_policy.json
}

# ============================================================
# Lambda — stock-ingest
# Reads from MASSIVE API and writes the daily winner to DynamoDB
# ============================================================

resource "aws_lambda_function" "stock_ingest" {
  function_name = "stock-ingest"
  filename      = var.lambda_zip_path
  handler       = "lambda_ingest.lambda_handler"
  runtime       = "python3.11"
  role          = aws_iam_role.stock_ingest.arn
  timeout       = 300 # 6 tickers × 12s sleep + 2 × 12s enrichment = ~96s minimum; 300s gives headroom

  # Triggers a re-deploy whenever the ZIP contents change
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  environment {
    variables = {
      DYNAMODB_TABLE_NAME = var.dynamodb_table_name
      MASSIVE_API_KEY     = var.massive_api_key
    }
  }

  tags = {
    Project = "stockpipeline"
  }
}

# ============================================================
# Lambda — stock-api
# Serves the last N daily winners via API Gateway
# ============================================================

resource "aws_lambda_function" "stock_api" {
  function_name = "stock-api"
  filename      = var.lambda_zip_path
  handler       = "lambda_api.lambda_handler"
  runtime       = "python3.11"
  role          = aws_iam_role.stock_api.arn
  timeout       = 30 # /history calls Massive API externally; 15s was too tight

  source_code_hash = filebase64sha256(var.lambda_zip_path)

  environment {
    variables = {
      DYNAMODB_TABLE_NAME = var.dynamodb_table_name
      MASSIVE_API_KEY     = var.massive_api_key
    }
  }

  tags = {
    Project = "stockpipeline"
  }
}

# ============================================================
# EventBridge — triggers stock-ingest Tue-Sat at 13:00 UTC
# (9:00 AM ET / 6:00 AM PDT — fetches previous day's finalized data)
# ============================================================

resource "aws_cloudwatch_event_rule" "stock_ingest_schedule" {
  name                = "stock-ingest-daily"
  description         = "Fires Tue-Sat at 13:00 UTC (9:00 AM ET) to ingest the previous trading day's top mover"
  schedule_expression = "cron(0 13 ? * TUE-SAT *)"
}

resource "aws_cloudwatch_event_target" "stock_ingest" {
  rule      = aws_cloudwatch_event_rule.stock_ingest_schedule.name
  target_id = "stock-ingest-lambda"
  arn       = aws_lambda_function.stock_ingest.arn
}

# Grant EventBridge permission to invoke stock-ingest
resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.stock_ingest.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.stock_ingest_schedule.arn
}

# ============================================================
# API Gateway REST API — exposes GET /movers
# ============================================================

resource "aws_api_gateway_rest_api" "stock_api" {
  name        = "stock-pipeline-api"
  description = "Public REST API for querying daily stock movers"
}

# /movers resource
resource "aws_api_gateway_resource" "movers" {
  rest_api_id = aws_api_gateway_rest_api.stock_api.id
  parent_id   = aws_api_gateway_rest_api.stock_api.root_resource_id
  path_part   = "movers"
}

# GET method (no auth — public endpoint)
resource "aws_api_gateway_method" "get_movers" {
  rest_api_id   = aws_api_gateway_rest_api.stock_api.id
  resource_id   = aws_api_gateway_resource.movers.id
  http_method   = "GET"
  authorization = "NONE"
}

# Lambda proxy integration — API Gateway forwards the full event to the Lambda
resource "aws_api_gateway_integration" "get_movers" {
  rest_api_id             = aws_api_gateway_rest_api.stock_api.id
  resource_id             = aws_api_gateway_resource.movers.id
  http_method             = aws_api_gateway_method.get_movers.http_method
  integration_http_method = "POST" # Lambda integrations always use POST internally
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.stock_api.invoke_arn
}

# /history resource — serves 52-week price history for a given ticker
resource "aws_api_gateway_resource" "history" {
  rest_api_id = aws_api_gateway_rest_api.stock_api.id
  parent_id   = aws_api_gateway_rest_api.stock_api.root_resource_id
  path_part   = "history"
}

resource "aws_api_gateway_method" "get_history" {
  rest_api_id   = aws_api_gateway_rest_api.stock_api.id
  resource_id   = aws_api_gateway_resource.history.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "get_history" {
  rest_api_id             = aws_api_gateway_rest_api.stock_api.id
  resource_id             = aws_api_gateway_resource.history.id
  http_method             = aws_api_gateway_method.get_history.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.stock_api.invoke_arn
}

# Deploy the API — triggers forces a new deployment whenever any integration changes,
# preventing the "Missing Authentication Token" bug where /history loses its route.
resource "aws_api_gateway_deployment" "stock_api" {
  rest_api_id = aws_api_gateway_rest_api.stock_api.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_integration.get_movers,
      aws_api_gateway_integration.get_history,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

# prod stage — the base URL for all calls
resource "aws_api_gateway_stage" "prod" {
  deployment_id = aws_api_gateway_deployment.stock_api.id
  rest_api_id   = aws_api_gateway_rest_api.stock_api.id
  stage_name    = "prod"
}

# Grant API Gateway permission to invoke stock-api
resource "aws_lambda_permission" "allow_apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.stock_api.function_name
  principal     = "apigateway.amazonaws.com"
  # Wildcard covers all stages and methods for this API
  source_arn = "${aws_api_gateway_rest_api.stock_api.execution_arn}/*/*"
}

# ============================================================
# S3 — static hosting bucket for the React frontend
# ============================================================

resource "aws_s3_bucket" "frontend" {
  bucket = "stock-pipeline-frontend-${data.aws_caller_identity.current.account_id}"

  tags = {
    Project = "stockpipeline"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ============================================================
# CloudFront — CDN in front of S3, serves the React app
# ============================================================

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "stock-pipeline-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "Stock pipeline React frontend"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  # Return index.html for all routes (needed for React Router / SPA)
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Project = "stockpipeline"
  }
}

# Allow CloudFront to read from the S3 bucket
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
        }
      }
    }]
  })
}

# Used for unique bucket naming
data "aws_caller_identity" "current" {}
