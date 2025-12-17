import { App } from 'aws-cdk-lib';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { StaticSiteStack } from './static-site-stack';

function main(): void {
  const app = new App();

  const configFileName = app.node.tryGetContext('config');
  if (!configFileName) {
    throw new Error('Missing "config" context variable. Usage: cdk deploy -c config=config/dev.json');
  }

  const config = JSON.parse(readFileSync(resolve(configFileName), 'utf-8'));
  
  new StaticSiteStack(app, `${config.name}-StaticSite`, config);
  
  app.synth();
}

main();
