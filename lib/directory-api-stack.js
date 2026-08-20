"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DirectoryApiStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_apigatewayv2_1 = require("aws-cdk-lib/aws-apigatewayv2");
const aws_apigatewayv2_integrations_1 = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const aws_lambda_1 = require("aws-cdk-lib/aws-lambda");
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const path_1 = require("path");
class DirectoryApiStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, config) {
        super(scope, id, {
            env: {
                account: config.accountNumber,
                region: config.region,
            },
        });
        // Lambda function — NodejsFunction auto-bundles with esbuild
        const fn = new aws_lambda_nodejs_1.NodejsFunction(this, 'DirectoryApiFunction', {
            entry: (0, path_1.resolve)(__dirname, '../lambda/directory-api/index.ts'),
            handler: 'handler',
            runtime: aws_lambda_1.Runtime.NODEJS_20_X,
            architecture: aws_lambda_1.Architecture.ARM_64,
            memorySize: 256,
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            environment: {
                MEDPLUM_BASE_URL: config.medplumBaseUrl,
                MEDPLUM_CLIENT_ID: config.medplumClientId,
                MEDPLUM_CLIENT_SECRET: config.medplumClientSecret,
                ...(config.recaptchaSecretKey ? { RECAPTCHA_SECRET_KEY: config.recaptchaSecretKey } : {}),
            },
            bundling: {
                externalModules: [], // Bundle everything including @medplum/core
                forceDockerBundling: false,
            },
        });
        // HTTP API (API Gateway v2)
        const api = new aws_apigatewayv2_1.HttpApi(this, 'DirectoryApi', {
            apiName: `${config.name}-directory-api`,
            corsPreflight: {
                allowOrigins: ['*'],
                allowMethods: [aws_apigatewayv2_1.CorsHttpMethod.GET, aws_apigatewayv2_1.CorsHttpMethod.POST, aws_apigatewayv2_1.CorsHttpMethod.OPTIONS],
                allowHeaders: ['Content-Type'],
            },
        });
        // Bound request volume at the edge — this is a public, unauthenticated API whose search
        // endpoint fans out to availability calculations, so unthrottled it multiplies backend cost.
        // Same posture as the booking API. HttpApi's L2 doesn't expose stage throttling; set it on
        // the default stage's L1.
        const defaultStage = api.defaultStage?.node.defaultChild;
        defaultStage.defaultRouteSettings = {
            throttlingRateLimit: 10,
            throttlingBurstLimit: 25,
        };
        // Single integration for all routes
        const integration = new aws_apigatewayv2_integrations_1.HttpLambdaIntegration('DirectoryIntegration', fn);
        // Search practitioners
        api.addRoutes({
            path: '/api/directory/practitioners',
            methods: [aws_apigatewayv2_1.HttpMethod.GET],
            integration,
        });
        // Get practitioner detail
        api.addRoutes({
            path: '/api/directory/practitioners/{id}',
            methods: [aws_apigatewayv2_1.HttpMethod.GET],
            integration,
        });
        // Get filter options
        api.addRoutes({
            path: '/api/directory/filters',
            methods: [aws_apigatewayv2_1.HttpMethod.GET],
            integration,
        });
        api.addRoutes({
            path: '/api/directory/photo/{id}',
            methods: [aws_apigatewayv2_1.HttpMethod.GET],
            integration,
        });
        // Practitioner listing application (public form on /practitioners)
        api.addRoutes({
            path: '/api/directory/apply',
            methods: [aws_apigatewayv2_1.HttpMethod.POST],
            integration,
        });
        // Cora: Check email deletion status
        api.addRoutes({
            path: '/api/cora/check-email',
            methods: [aws_apigatewayv2_1.HttpMethod.POST],
            integration,
        });
        // Output the API URL for configuration
        new aws_cdk_lib_1.CfnOutput(this, 'DirectoryApiUrl', {
            value: api.url,
            description: 'Directory API URL (set as NEXT_PUBLIC_DIRECTORY_API_URL in findtherapist/.env)',
        });
    }
}
exports.DirectoryApiStack = DirectoryApiStack;
