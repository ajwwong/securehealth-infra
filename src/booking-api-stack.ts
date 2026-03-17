import { Stack, CfnOutput, Duration } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { resolve } from 'path';

export interface BookingApiConfig {
  name: string;
  region: string;
  accountNumber: string;
  medplumBaseUrl: string;
  medplumClientId: string;
  medplumClientSecret: string;
  recaptchaSecretKey?: string;
}

export class BookingApiStack extends Stack {
  constructor(scope: Construct, id: string, config: BookingApiConfig) {
    super(scope, id, {
      env: {
        account: config.accountNumber,
        region: config.region,
      },
    });

    // Lambda function — NodejsFunction auto-bundles with esbuild
    const fn = new NodejsFunction(this, 'BookingApiFunction', {
      entry: resolve(__dirname, '../lambda/booking-api/index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
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
    const api = new HttpApi(this, 'BookingApi', {
      apiName: `${config.name}-booking-api`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type'],
      },
    });

    // Single integration for all routes
    const integration = new HttpLambdaIntegration('BookingIntegration', fn);

    api.addRoutes({
      path: '/api/booking/{slug}/practice',
      methods: [HttpMethod.GET],
      integration,
    });

    api.addRoutes({
      path: '/api/booking/{slug}/availability',
      methods: [HttpMethod.GET],
      integration,
    });

    api.addRoutes({
      path: '/api/booking/{slug}/availability-dates',
      methods: [HttpMethod.GET],
      integration,
    });

    api.addRoutes({
      path: '/api/booking/{slug}/request',
      methods: [HttpMethod.POST],
      integration,
    });

    api.addRoutes({
      path: '/api/booking/{slug}/contact',
      methods: [HttpMethod.POST],
      integration,
    });

    // Output the API URL for configuration
    new CfnOutput(this, 'BookingApiUrl', {
      value: api.url!,
      description: 'Booking API URL (set as VITE_BOOKING_API_URL in securehealth/.env)',
    });
  }
}
