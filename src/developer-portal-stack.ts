import { Stack, CfnOutput, Duration } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  Distribution,
  ViewerProtocolPolicy,
  ResponseHeadersPolicy,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  CachePolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { ARecord, AaaaRecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface DeveloperPortalConfig {
  stackName: string;
  name: string;
  region: string;
  accountNumber: string;
  /** e.g. developer.practiceharbor.com */
  domainName: string;
  /** us-east-1 ACM cert covering domainName (the *.practiceharbor.com wildcard works) */
  sslCertArn: string;
  /** Route53 hosted zone id for the apex (practiceharbor.com) */
  hostedZoneId: string;
  hostedZoneName: string;
  /** The API host the portal's "try it" may call — the only non-self connect-src */
  apiOrigin: string;
}

/**
 * developer.practiceharbor.com — a static Scalar API reference over our curated OpenAPI spec
 * (progress2-base/developer/). Plan: progress2-base/docs/developer-portal-plan-2026-09-07.md.
 *
 * Security posture (spike-verified 2026-09-07): private bucket behind CloudFront OAC, and a strict
 * CSP — scripts/fonts/images only from self, the ONLY external connection is the API host so the
 * reference's "try it" can call it, no third-party egress (Scalar's agent/MCP/devtools uploads are
 * disabled in the page config too). Scalar compiles the spec with `new Function`, hence
 * 'unsafe-eval'; it injects inline styles, hence 'unsafe-inline' on style-src only.
 */
export class DeveloperPortalStack extends Stack {
  constructor(scope: Construct, id: string, config: DeveloperPortalConfig) {
    super(scope, id, {
      stackName: config.stackName,
      env: { account: config.accountNumber, region: config.region },
    });

    const bucket = new Bucket(this, 'SiteBucket', {
      bucketName: config.domainName,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    const csp = [
      "default-src 'none'",
      "script-src 'self' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ${config.apiOrigin}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');

    const headers = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${config.name}-developer-portal-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, preload: true, override: true },
      },
    });

    const distribution = new Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [config.domainName],
      certificate: Certificate.fromCertificateArn(this, 'Certificate', config.sslCertArn),
      // No SPA fallback: this is a real static site; a missing path is a 404.
    });

    const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    });
    const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
    new ARecord(this, 'AliasA', { zone, recordName: config.domainName, target });
    new AaaaRecord(this, 'AliasAAAA', { zone, recordName: config.domainName, target });

    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
