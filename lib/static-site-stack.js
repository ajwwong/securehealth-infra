"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaticSiteStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_certificatemanager_1 = require("aws-cdk-lib/aws-certificatemanager");
const aws_cloudfront_1 = require("aws-cdk-lib/aws-cloudfront");
const aws_cloudfront_origins_1 = require("aws-cdk-lib/aws-cloudfront-origins");
const aws_s3_1 = require("aws-cdk-lib/aws-s3");
class StaticSiteStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, config) {
        super(scope, id, {
            env: {
                account: config.accountNumber,
                region: config.region
            }
        });
        // Create S3 bucket for static hosting
        const siteBucket = new aws_s3_1.Bucket(this, 'SiteBucket', {
            bucketName: config.domainName,
            websiteIndexDocument: 'index.html',
            websiteErrorDocument: 'index.html',
            publicReadAccess: false,
        });
        // CloudFront distribution
        const distribution = new aws_cloudfront_1.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: new aws_cloudfront_origins_1.S3Origin(siteBucket),
                viewerProtocolPolicy: aws_cloudfront_1.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
            domainNames: [config.domainName],
            certificate: aws_certificatemanager_1.Certificate.fromCertificateArn(this, 'Certificate', config.sslCertArn),
        });
        // Output the distribution URL
        new aws_cdk_lib_1.CfnOutput(this, 'DistributionUrl', {
            value: distribution.distributionDomainName,
        });
    }
}
exports.StaticSiteStack = StaticSiteStack;
