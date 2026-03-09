# ============================================================
# outputs.tf — Useful values after terraform apply
# ============================================================

output "api_gateway_url" {
  description = "Full invoke URL for the GET /movers endpoint"
  value       = "${aws_api_gateway_stage.prod.invoke_url}/movers"
}

output "dynamodb_table_name" {
  description = "Name of the DynamoDB table storing daily stock movers"
  value       = aws_dynamodb_table.stock_movers.name
}

output "stock_ingest_lambda_arn" {
  description = "ARN of the stock-ingest Lambda function"
  value       = aws_lambda_function.stock_ingest.arn
}

output "stock_api_lambda_arn" {
  description = "ARN of the stock-api Lambda function"
  value       = aws_lambda_function.stock_api.arn
}

output "frontend_url" {
  description = "CloudFront URL for the React frontend"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "s3_bucket_name" {
  description = "S3 bucket name for deploying the React build"
  value       = aws_s3_bucket.frontend.bucket
}
