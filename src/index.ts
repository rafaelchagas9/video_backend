import { buildServer } from './server';
import { env } from './config/env';
import { logger } from './utils/logger';

async function main() {
  try {
    const server = await buildServer();

    await server.listen({
      port: env.PORT,
      host: env.HOST,
    });

    logger.info(`Server listening on http://${env.HOST}:${env.PORT}`);
    logger.info(`API documentation available at http://${env.HOST}:${env.PORT}/docs`);
    logger.info(`Health check available at http://${env.HOST}:${env.PORT}/health`);

  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
}

main();
