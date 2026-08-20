import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
interface WidgetStackConfig {
    stackName: string;
    domainName: string;
    sslCertArn: string;
    region: string;
    accountNumber: string;
    name: string;
}
export declare class WidgetStack extends Stack {
    constructor(scope: Construct, id: string, config: WidgetStackConfig);
}
export {};
