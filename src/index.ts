import app from './app';
import { config } from './config';
import { prisma } from './services/db';
import { ExpiryService } from './services/expiry.service';

const expiryService = new ExpiryService(prisma);

/**
 * Bootstraps the application gateway server
 */
async function start() {
  try {
    // 1. Establish database connection pool
    await prisma.$connect();
    app.log.info('🔌 Connected to PostgreSQL successfully.');

    // 2. Start the soft-delete expiry background cron (Every hour)
    expiryService.start('0 * * * *');

    // 3. Launch the REST gateway server
    const port = config.PORT;
    const address = await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`🚀 Omnimate Inbox Gateway online at ${address}`);
  } catch (err) {
    app.log.error(err, '❌ Crash on boot:');
    process.exit(1);
  }
}

// Graceful exit handler
const shutdown = async () => {
  app.log.info('🛑 Shutting down server gracefully...');
  try {
    expiryService.stop();
    await app.close();
    await prisma.$disconnect();
    app.log.info('👋 Graceful shutdown complete.');
    process.exit(0);
  } catch (err) {
    app.log.error(err, '❌ Error during shutdown:');
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
