"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookingApiStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_apigatewayv2_1 = require("aws-cdk-lib/aws-apigatewayv2");
const aws_apigatewayv2_integrations_1 = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const aws_lambda_1 = require("aws-cdk-lib/aws-lambda");
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const path_1 = require("path");
class BookingApiStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, config) {
        super(scope, id, {
            env: {
                account: config.accountNumber,
                region: config.region,
            },
        });
        // Lambda function — NodejsFunction auto-bundles with esbuild
        const fn = new aws_lambda_nodejs_1.NodejsFunction(this, 'BookingApiFunction', {
            entry: (0, path_1.resolve)(__dirname, '../lambda/booking-api/index.ts'),
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
        const api = new aws_apigatewayv2_1.HttpApi(this, 'BookingApi', {
            apiName: `${config.name}-booking-api`,
            corsPreflight: {
                allowOrigins: ['*'],
                allowMethods: [aws_apigatewayv2_1.CorsHttpMethod.GET, aws_apigatewayv2_1.CorsHttpMethod.POST, aws_apigatewayv2_1.CorsHttpMethod.OPTIONS],
                allowHeaders: ['Content-Type'],
            },
        });
        // Single integration for all routes
        const integration = new aws_apigatewayv2_integrations_1.HttpLambdaIntegration('BookingIntegration', fn);
        api.addRoutes({
            path: '/api/booking/{slug}/practice',
            methods: [aws_apigatewayv2_1.HttpMethod.GET],
            integration,
        });
        api.addRoutes({
            path: '/api/booking/{slug}/availability',
            methods: [aws_apigatewayv2_1.HttpMethod.GET],
            integration,
        });
        api.addRoutes({
            path: '/api/booking/{slug}/availability-dates',
            methods: [aws_apigatewayv2_1.HttpMethod.GET],
            integration,
        });
        api.addRoutes({
            path: '/api/booking/{slug}/request',
            methods: [aws_apigatewayv2_1.HttpMethod.POST],
            integration,
        });
        // Output the API URL for configuration
        new aws_cdk_lib_1.CfnOutput(this, 'BookingApiUrl', {
            value: api.url,
            description: 'Booking API URL (set as VITE_BOOKING_API_URL in securehealth/.env)',
        });
    }
}
exports.BookingApiStack = BookingApiStack;
