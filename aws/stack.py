"""DevNerds Stack — DDB + S3 + Cognito (Hosted UI) + Lambda + HTTP API.

Single stack, single environment. Mirrors the engine/Lambda contract:
- Table name `devnerds-tasks` (pk/sk + 3 GSIs)
- Bucket name `devnerds-artifacts-{account}`
- Cognito User Pool with hosted OAuth, single web client
- HTTP API v2 with JWT authorizer in front of the Lambda

Configure your public UI origin via the DEVNERDS_UI_ORIGIN env var
(e.g. `https://devnerds.example.com`) before running `cdk deploy`.
"""
import os
from aws_cdk import (
    Stack, Duration, RemovalPolicy, CfnOutput,
    aws_dynamodb as ddb,
    aws_s3 as s3,
    aws_cognito as cognito,
    aws_lambda as lambda_,
    aws_logs as logs,
    aws_iam as iam,
    aws_apigatewayv2 as apigw,
    aws_apigatewayv2_integrations as apigw_integrations,
    aws_apigatewayv2_authorizers as apigw_authorizers,
)
from constructs import Construct


UI_ORIGIN = os.environ.get("DEVNERDS_UI_ORIGIN", "http://localhost:3000")
CORS_ORIGIN = UI_ORIGIN
CALLBACK_URLS = [
    f"{UI_ORIGIN}/auth/callback",
    "http://localhost:3000/auth/callback",
]
LOGOUT_URLS = [
    f"{UI_ORIGIN}/",
    "http://localhost:3000/",
]


class DevNerdsStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, environment: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)
        self.env_name = environment
        account = Stack.of(self).account

        # ── DynamoDB: devnerds-tasks ─────────────────────────────────────────
        table = ddb.Table(
            self, "TasksTable",
            table_name="devnerds-tasks",
            partition_key=ddb.Attribute(name="pk", type=ddb.AttributeType.STRING),
            sort_key=ddb.Attribute(name="sk", type=ddb.AttributeType.STRING),
            billing_mode=ddb.BillingMode.PAY_PER_REQUEST,
            point_in_time_recovery_specification=ddb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True,
            ),
            removal_policy=RemovalPolicy.RETAIN,
        )
        table.add_global_secondary_index(
            index_name="assignee-index",
            partition_key=ddb.Attribute(name="assignee", type=ddb.AttributeType.STRING),
            sort_key=ddb.Attribute(name="status", type=ddb.AttributeType.STRING),
            projection_type=ddb.ProjectionType.ALL,
        )
        table.add_global_secondary_index(
            index_name="priority-index",
            partition_key=ddb.Attribute(name="priority", type=ddb.AttributeType.STRING),
            sort_key=ddb.Attribute(name="status", type=ddb.AttributeType.STRING),
            projection_type=ddb.ProjectionType.ALL,
        )
        table.add_global_secondary_index(
            index_name="status-index",
            partition_key=ddb.Attribute(name="status", type=ddb.AttributeType.STRING),
            sort_key=ddb.Attribute(name="pk", type=ddb.AttributeType.STRING),
            projection_type=ddb.ProjectionType.ALL,
        )

        # ── S3: devnerds-artifacts ───────────────────────────────────────────
        bucket = s3.Bucket(
            self, "ArtifactsBucket",
            # devnerds-artifacts is taken globally by the source account; suffix
            # with account id. Lambda + engine read the name from env vars.
            bucket_name=f"devnerds-artifacts-{account}",
            versioned=True,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            removal_policy=RemovalPolicy.RETAIN,
            lifecycle_rules=[
                s3.LifecycleRule(
                    id="expire-noncurrent-90d",
                    noncurrent_version_expiration=Duration.days(90),
                    enabled=True,
                ),
            ],
        )

        # ── Cognito User Pool: devnerds-users ────────────────────────────────
        user_pool = cognito.UserPool(
            self, "UserPool",
            user_pool_name="devnerds-users",
            sign_in_aliases=cognito.SignInAliases(email=True, username=False),
            self_sign_up_enabled=False,
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            mfa=cognito.Mfa.OPTIONAL,
            mfa_second_factor=cognito.MfaSecondFactor(otp=True, sms=False),
            password_policy=cognito.PasswordPolicy(
                min_length=12,
                require_lowercase=True,
                require_uppercase=True,
                require_digits=True,
                require_symbols=True,
            ),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            removal_policy=RemovalPolicy.RETAIN,
        )

        client = user_pool.add_client(
            "WebClient",
            user_pool_client_name="devnerds-web",
            generate_secret=False,
            o_auth=cognito.OAuthSettings(
                flows=cognito.OAuthFlows(authorization_code_grant=True),
                scopes=[
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE,
                ],
                callback_urls=CALLBACK_URLS,
                logout_urls=LOGOUT_URLS,
            ),
            auth_flows=cognito.AuthFlow(user_srp=True),
            prevent_user_existence_errors=True,
            access_token_validity=Duration.hours(1),
            id_token_validity=Duration.hours(1),
            refresh_token_validity=Duration.days(30),
        )

        # Bot client — machine-to-machine, username+password auth, no Hosted UI
        bot_client = user_pool.add_client(
            "BotClient",
            user_pool_client_name="devnerds-bots-client",
            generate_secret=False,
            auth_flows=cognito.AuthFlow(
                user_password=True,
                user_srp=False,
            ),
            prevent_user_existence_errors=True,
            access_token_validity=Duration.hours(1),
            id_token_validity=Duration.hours(1),
            refresh_token_validity=Duration.days(30),
        )

        domain = user_pool.add_domain(
            "Domain",
            cognito_domain=cognito.CognitoDomainOptions(
                domain_prefix=f"devnerds-{account}",
            ),
        )

        # ── Lambda: devnerds-api ─────────────────────────────────────────────
        log_group = logs.LogGroup(
            self, "ApiLogs",
            log_group_name="/aws/lambda/devnerds-api",
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )

        api_fn = lambda_.Function(
            self, "ApiFunction",
            function_name="devnerds-api",
            runtime=lambda_.Runtime.NODEJS_20_X,
            handler="index.handler",
            code=lambda_.Code.from_asset("lambda-build"),
            memory_size=512,
            timeout=Duration.seconds(30),
            environment={
                "TASK_TABLE": table.table_name,
                "ARTIFACTS_BUCKET": bucket.bucket_name,
                # AWS_REGION is reserved; use a custom name.
                "DEVNERDS_REGION": Stack.of(self).region,
                "USER_POOL_ID": user_pool.user_pool_id,
                "USER_POOL_CLIENT_ID": client.user_pool_client_id,
            },
            log_group=log_group,
        )

        # IAM: DDB + artifacts bucket RW. Plus read on legacy quips bucket so
        # the existing /default and /activity routes keep working.
        table.grant_read_write_data(api_fn)
        bucket.grant_read_write(api_fn)

        # IAM: SSM Parameter Store read for Anthropic API key (SecureString → needs kms:Decrypt)
        region = Stack.of(self).region
        api_fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ssm:GetParameter"],
            resources=[f"arn:aws:ssm:{region}:{account}:parameter/devnerds/anthropic-api-key"],
        ))
        api_fn.add_to_role_policy(iam.PolicyStatement(
            actions=["kms:Decrypt"],
            resources=[f"arn:aws:kms:{region}:{account}:key/*"],
            conditions={
                "StringEquals": {
                    "kms:ViaService": f"ssm.{region}.amazonaws.com"
                }
            },
        ))

        # ── API Gateway HTTP API v2 ──────────────────────────────────────────
        authorizer = apigw_authorizers.HttpJwtAuthorizer(
            "CognitoAuthorizer",
            jwt_issuer=f"https://cognito-idp.{Stack.of(self).region}.amazonaws.com/{user_pool.user_pool_id}",
            jwt_audience=[client.user_pool_client_id, bot_client.user_pool_client_id],
            authorizer_name="devnerds-cognito",
        )

        http_api = apigw.HttpApi(
            self, "HttpApi",
            api_name="devnerds-api",
            cors_preflight=apigw.CorsPreflightOptions(
                allow_origins=[CORS_ORIGIN],
                allow_methods=[apigw.CorsHttpMethod.ANY],
                allow_headers=["Authorization", "Content-Type"],
                allow_credentials=True,
                max_age=Duration.seconds(600),
            ),
        )

        # Public read of the canonical task schema — anyone can fetch it.
        # Defined BEFORE the catch-all proxy so the more-specific route wins.
        http_api.add_routes(
            path="/schema",
            methods=[apigw.HttpMethod.GET],
            integration=apigw_integrations.HttpLambdaIntegration(
                "SchemaIntegration", handler=api_fn,
            ),
        )

        # Non-OPTIONS methods go to Lambda with JWT auth.
        # OPTIONS is intentionally excluded so API Gateway's CorsPreflightOptions
        # handles preflight without invoking the authorizer (preflight has no JWT).
        http_api.add_routes(
            path="/{proxy+}",
            methods=[
                apigw.HttpMethod.GET,
                apigw.HttpMethod.POST,
                apigw.HttpMethod.PUT,
                apigw.HttpMethod.PATCH,
                apigw.HttpMethod.DELETE,
                apigw.HttpMethod.HEAD,
            ],
            integration=apigw_integrations.HttpLambdaIntegration(
                "ApiIntegration", handler=api_fn,
            ),
            authorizer=authorizer,
        )

        # ── Outputs ──────────────────────────────────────────────────────────
        CfnOutput(self, "OutApiUrl", value=http_api.api_endpoint)
        CfnOutput(self, "OutUserPoolId", value=user_pool.user_pool_id)
        CfnOutput(self, "OutUserPoolClientId", value=client.user_pool_client_id)
        CfnOutput(self, "OutCognitoHostedUiUrl", value=(
            f"{domain.base_url()}/login"
            f"?client_id={client.user_pool_client_id}"
            f"&response_type=code"
            f"&scope=email+openid+profile"
            f"&redirect_uri={CALLBACK_URLS[0]}"
        ))
        CfnOutput(self, "OutCognitoDomain", value=domain.base_url())
        CfnOutput(self, "OutTaskTable", value=table.table_name)
        CfnOutput(self, "OutArtifactsBucket", value=bucket.bucket_name)
        CfnOutput(self, "OutLambdaFunctionName", value=api_fn.function_name)
        CfnOutput(self, "OutBotClientId", value=bot_client.user_pool_client_id)
