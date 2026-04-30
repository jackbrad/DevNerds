# DevNerds AWS

CDK stack and migration scripts for the DevNerds backend.

## Stack contents

- DynamoDB table `devnerds-tasks` (pk/sk + 3 GSIs)
- S3 bucket `devnerds-artifacts-{account}` (versioned, private, 90d noncurrent expiry)
- Cognito User Pool `devnerds-users` with Hosted UI
- Lambda `devnerds-api` (Node 20) — code from `../lambda/`
- API Gateway HTTP API v2 with Cognito JWT authorizer
- Scoped IAM user for the worker (created out-of-band, see below)

## Prereqs

- An AWS account, plus a CLI profile with sufficient privileges to run CDK
- AWS CDK v2 (`cdk --version` → 2.x)
- Python 3.10+, `pip install -r requirements.txt`

## Deploy

```bash
# 1. Bundle the lambda code (copies ../lambda/ → lambda-build/ + installs deps)
./build-lambda.sh

# 2. Bootstrap (one-time per account/region)
cdk bootstrap aws://<aws-account-id>/us-east-1 --profile <your-profile>

# 3. Deploy. DEVNERDS_UI_ORIGIN is the public URL the UI will be served from
#    (used for CORS + Cognito callback URLs).
DEVNERDS_UI_ORIGIN=https://devnerds.example.com \
  cdk deploy --profile <your-profile> --require-approval never
```

CfnOutputs land in `OUTPUTS.txt` (gitignored).

## Migrations (one-shot, run after deploy)

```bash
cd migrations
python migrate-dynamodb.py
python migrate-s3.py
```

Both scripts are idempotent — safe to re-run.

## Engine reconfiguration

The worker reads creds via the AWS SDK default chain. Set `AWS_PROFILE` in
its environment to the IAM user you provisioned, then verify with:

```bash
AWS_PROFILE=<your-profile> aws sts get-caller-identity
```
