import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
interface StaticSiteConfig {
    stackName: string;
    domainName: string;
    sslCertArn: string;
    region: string;
    accountNumber: string;
    name: string;
}
export declare class StaticSiteStack extends Stack {
    constructor(scope: Construct, id: string, config: StaticSiteConfig);
}
export {};
