import { App } from 'aws-cdk-lib';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { StaticSiteStack } from './static-site-stack';
import { BookingApiStack } from './booking-api-stack';

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

  app.synth();
}

main();
