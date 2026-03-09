# ============================================================
# variables.tf — Input variables for the stock pipeline
# ============================================================

variable "aws_region" {
  description = "AWS region where all resources are deployed"
  type        = string
  default     = "us-west-1"
}

variable "dynamodb_table_name" {
  description = "Name of the DynamoDB table that stores daily stock movers"
  type        = string
  default     = "stock_mover_table"
}

variable "massive_api_key" {
  description = "API key for the MASSIVE data provider — passed as a Lambda env var, never hardcoded"
  type        = string
  sensitive   = true
}

variable "lambda_zip_path" {
  description = "Path to the Lambda deployment ZIP (relative to the infrastructure/ directory)"
  type        = string
  default     = "../lambda_package.zip"
}
