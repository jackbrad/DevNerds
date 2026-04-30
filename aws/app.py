#!/usr/bin/env python3
"""CDK app for DevNerds. Provisions DDB, S3, Cognito, Lambda, and HTTP API."""
import os
import aws_cdk as cdk
from stack import DevNerdsStack

app = cdk.App()
environment = app.node.try_get_context("environment") or os.environ.get("ENVIRONMENT", "dev")

DevNerdsStack(
    app,
    f"DevNerds-{environment}",
    environment=environment,
    env=cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region=os.environ.get("CDK_DEFAULT_REGION", "us-east-1"),
    ),
)

app.synth()
