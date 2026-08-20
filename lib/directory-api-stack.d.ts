import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface DirectoryApiConfig {
    name: string;
    region: string;
    accountNumber: string;
    medplumBaseUrl: string;
    medplumClientId: string;
    medplumClientSecret: string;
    recaptchaSecretKey?: string;
}
export declare class DirectoryApiStack extends Stack {
    constructor(scope: Construct, id: string, config: DirectoryApiConfig);
}
