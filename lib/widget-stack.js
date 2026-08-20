"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WidgetStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_certificatemanager_1 = require("aws-cdk-lib/aws-certificatemanager");
const aws_cloudfront_1 = require("aws-cdk-lib/aws-cloudfront");
const aws_cloudfront_origins_1 = require("aws-cdk-lib/aws-cloudfront-origins");
const aws_s3_1 = require("aws-cdk-lib/aws-s3");
class WidgetStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, config) {
        super(scope, id, {
            env: {
                account: config.accountNumber,
                region: config.region,
            },
        });
        // S3 bucket for widget assets (booking.js)
        const widgetBucket = new aws_s3_1.Bucket(this, 'WidgetBucket', {
            bucketName: config.domainName,
            publicReadAccess: false,
        });
        // CloudFront distribution with CORS headers for cross-origin script loading
        const distribution = new aws_cloudfront_1.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: new aws_cloudfront_origins_1.S3Origin(widgetBucket),
                viewerProtocolPolicy: aws_cloudfront_1.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                responseHeadersPolicy: aws_cloudfront_1.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
            },
            domainNames: [config.domainName],
            certificate: aws_certificatemanager_1.Certificate.fromCertificateArn(this, 'Certificate', config.sslCertArn),
        });
        new aws_cdk_lib_1.CfnOutput(this, 'DistributionUrl', {
            value: distribution.distributionDomainName,
        });
        new aws_cdk_lib_1.CfnOutput(this, 'WidgetBucketName', {
            value: widgetBucket.bucketName,
        });
    }
}
exports.WidgetStack = WidgetStack;
