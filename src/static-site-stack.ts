import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface StaticSiteConfig {
  stackName: string;
  domainName: string;
  sslCertArn: string;
  region: string;
  accountNumber: string;
  name: string;
}

export class StaticSiteStack extends Stack {
  constructor(scope: Construct, id: string, config: StaticSiteConfig) {
    super(scope, id, {
      env: {
        account: config.accountNumber,
        region: config.region
      }
    });

    // Create S3 bucket for static hosting
    const siteBucket = new Bucket(this, 'SiteBucket', {
      bucketName: config.domainName,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: false,
    });

    // CloudFront distribution
    const distribution = new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new S3Origin(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      domainNames: [config.domainName],
      certificate: Certificate.fromCertificateArn(this, 'Certificate', config.sslCertArn),
    });

    // Output the distribution URL
    new CfnOutput(this, 'DistributionUrl', {
      value: distribution.distributionDomainName,
    });
  }
}
