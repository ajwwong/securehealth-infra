import { Stack, CfnOutput, Duration } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { resolve } from 'path';

export interface DirectoryApiConfig {
  name: string;
  region: string;
  accountNumber: string;
  medplumBaseUrl: string;
  medplumClientId: string;
  medplumClientSecret: string;
  recaptchaSecretKey?: string;
}

export class DirectoryApiStack extends Stack {
  constructor(scope: Construct, id: string, config: DirectoryApiConfig) {
    super(scope, id, {
      env: {
        account: config.accountNumber,
        region: config.region,
      },
    });

    // Lambda function — NodejsFunction auto-bundles with esbuild
    const fn = new NodejsFunction(this, 'DirectoryApiFunction', {
      entry: resolve(__dirname, '../lambda/directory-api/index.ts'),
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
    const api = new HttpApi(this, 'DirectoryApi', {
      apiName: `${config.name}-directory-api`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type'],
      },
    });

    // Single integration for all routes
    const integration = new HttpLambdaIntegration('DirectoryIntegration', fn);

    // Search practitioners
    api.addRoutes({
      path: '/api/directory/practitioners',
      methods: [HttpMethod.GET],
      integration,
    });

    // Get practitioner detail
    api.addRoutes({
      path: '/api/directory/practitioners/{id}',
      methods: [HttpMethod.GET],
      integration,
    });

    // Get filter options
    api.addRoutes({
      path: '/api/directory/filters',
      methods: [HttpMethod.GET],
      integration,
    });

    // Submit booking request
    api.addRoutes({
      path: '/api/directory/booking-request',
      methods: [HttpMethod.POST],
      integration,
    });

    // Cora: Check email deletion status
    api.addRoutes({
      path: '/api/cora/check-email',
      methods: [HttpMethod.POST],
      integration,
    });

    // Output the API URL for configuration
    new CfnOutput(this, 'DirectoryApiUrl', {
      value: api.url!,
      description: 'Directory API URL (set as NEXT_PUBLIC_DIRECTORY_API_URL in findtherapist/.env)',
    });
  }
}
