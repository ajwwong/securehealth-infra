"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const aws_cdk_lib_1 = require("aws-cdk-lib");
const fs_1 = require("fs");
const path_1 = require("path");
const static_site_stack_1 = require("./static-site-stack");
const booking_api_stack_1 = require("./booking-api-stack");
const directory_api_stack_1 = require("./directory-api-stack");
const widget_stack_1 = require("./widget-stack");
function main() {
    const app = new aws_cdk_lib_1.App();
    const configFileName = app.node.tryGetContext('config');
    if (!configFileName) {
        throw new Error('Missing "config" context variable. Usage: cdk deploy -c config=config/dev.json');
    }
    const config = JSON.parse((0, fs_1.readFileSync)((0, path_1.resolve)(configFileName), 'utf-8'));
    // Stack names are `${config.name}-...`, so an entrypoint config must carry a name.
    // The credential files (config/booking.json, config/widget.json) have no name and are read
    // implicitly below — the deploy entrypoint is `-c config=config/dev.json`.
    if (!config.name) {
        throw new Error(`Config file "${configFileName}" has no "name" field and cannot be a deploy entrypoint. ` +
            'Use: cdk deploy -c config=config/dev.json');
    }
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
    // Directory API stack (requires config/directory.json with Medplum credentials)
    const directoryConfigPath = (0, path_1.resolve)('config/directory.json');
    if ((0, fs_1.existsSync)(directoryConfigPath)) {
        const directoryConfig = JSON.parse((0, fs_1.readFileSync)(directoryConfigPath, 'utf-8'));
        new directory_api_stack_1.DirectoryApiStack(app, `${directoryConfig.name}-DirectoryApi`, {
            name: directoryConfig.name,
            region: directoryConfig.region,
            accountNumber: directoryConfig.accountNumber,
            medplumBaseUrl: directoryConfig.medplumBaseUrl,
            medplumClientId: directoryConfig.medplumClientId,
            medplumClientSecret: directoryConfig.medplumClientSecret,
            recaptchaSecretKey: directoryConfig.recaptchaSecretKey,
        });
    }
    // Widget CDN stack (requires config/widget.json with domain + SSL cert)
    const widgetConfigPath = (0, path_1.resolve)('config/widget.json');
    if ((0, fs_1.existsSync)(widgetConfigPath)) {
        const widgetConfig = JSON.parse((0, fs_1.readFileSync)(widgetConfigPath, 'utf-8'));
        new widget_stack_1.WidgetStack(app, `${config.name}-Widget`, {
            stackName: `${config.name}-Widget`,
            name: config.name,
            region: config.region,
            accountNumber: config.accountNumber,
            domainName: widgetConfig.domainName,
            sslCertArn: widgetConfig.sslCertArn,
        });
    }
    app.synth();
}
main();
