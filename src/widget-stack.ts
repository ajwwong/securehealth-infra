import { Stack, CfnOutput } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Distribution, ViewerProtocolPolicy, ResponseHeadersPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface WidgetStackConfig {
  stackName: string;
  domainName: string;
  sslCertArn: string;
  region: string;
  accountNumber: string;
  name: string;
}

export class WidgetStack extends Stack {
  constructor(scope: Construct, id: string, config: WidgetStackConfig) {
    super(scope, id, {
      env: {
        account: config.accountNumber,
        region: config.region,
      },
    });

    // S3 bucket for widget assets (booking.js)
    const widgetBucket = new Bucket(this, 'WidgetBucket', {
      bucketName: config.domainName,
      publicReadAccess: false,
    });

    // CloudFront distribution with CORS headers for cross-origin script loading
    const distribution = new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new S3Origin(widgetBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
      },
      domainNames: [config.domainName],
      certificate: Certificate.fromCertificateArn(this, 'Certificate', config.sslCertArn),
    });

    new CfnOutput(this, 'DistributionUrl', {
      value: distribution.distributionDomainName,
    });

    new CfnOutput(this, 'WidgetBucketName', {
      value: widgetBucket.bucketName,
    });
  }
}
