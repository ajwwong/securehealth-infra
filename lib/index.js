"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const aws_cdk_lib_1 = require("aws-cdk-lib");
const fs_1 = require("fs");
const path_1 = require("path");
const static_site_stack_1 = require("./static-site-stack");
const booking_api_stack_1 = require("./booking-api-stack");
function main() {
    const app = new aws_cdk_lib_1.App();
    const configFileName = app.node.tryGetContext('config');
    if (!configFileName) {
        throw new Error('Missing "config" context variable. Usage: cdk deploy -c config=config/dev.json');
    }
    const config = JSON.parse((0, fs_1.readFileSync)((0, path_1.resolve)(configFileName), 'utf-8'));
    if (config.sslCertArn) {
        new static_site_stack_1.StaticSiteStack(app, `${config.name}-StaticSite`, config);
    }
    // Booking API stack (requires config/booking.json with Medplum credentials)
    const bookingConfigPath = (0, path_1.resolve)('config/booking.json');
    if ((0, fs_1.existsSync)(bookingConfigPath)) {
        const bookingConfig = JSON.parse((0, fs_1.readFileSync)(bookingConfigPath, 'utf-8'));
        new booking_api_stack_1.BookingApiStack(app, `${config.name}-BookingApi`, {
            name: config.name,
            region: config.region,
            accountNumber: config.accountNumber,
            medplumBaseUrl: bookingConfig.medplumBaseUrl,
            medplumClientId: bookingConfig.medplumClientId,
            medplumClientSecret: bookingConfig.medplumClientSecret,
            recaptchaSecretKey: bookingConfig.recaptchaSecretKey,
        });
    }
    app.synth();
}
main();
