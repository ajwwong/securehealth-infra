import { App } from 'aws-cdk-lib';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { StaticSiteStack } from './static-site-stack';
import { BookingApiStack } from './booking-api-stack';
import { DirectoryApiStack } from './directory-api-stack';
import { WidgetStack } from './widget-stack';

function main(): void {
  const app = new App();

  const configFileName = app.node.tryGetContext('config');
  if (!configFileName) {
    throw new Error('Missing "config" context variable. Usage: cdk deploy -c config=config/dev.json');
  }

  const config = JSON.parse(readFileSync(resolve(configFileName), 'utf-8'));

  if (config.sslCertArn) {
    new StaticSiteStack(app, `${config.name}-StaticSite`, config);
  }

  // Booking API stack (requires config/booking.json with Medplum credentials)
  const bookingConfigPath = resolve('config/booking.json');
  if (existsSync(bookingConfigPath)) {
    const bookingConfig = JSON.parse(readFileSync(bookingConfigPath, 'utf-8'));
    new BookingApiStack(app, `${config.name}-BookingApi`, {
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
  const directoryConfigPath = resolve('config/directory.json');
  if (existsSync(directoryConfigPath)) {
    const directoryConfig = JSON.parse(readFileSync(directoryConfigPath, 'utf-8'));
    new DirectoryApiStack(app, `${directoryConfig.name}-DirectoryApi`, {
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
  const widgetConfigPath = resolve('config/widget.json');
  if (existsSync(widgetConfigPath)) {
    const widgetConfig = JSON.parse(readFileSync(widgetConfigPath, 'utf-8'));
    new WidgetStack(app, `${config.name}-Widget`, {
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
