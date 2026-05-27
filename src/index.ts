import app from './app';
import { config } from './config';
import { prisma } from './services/db';
import { ExpiryService } from './services/expiry.service';
import { webhookWorker, webhookQueue } from './services/queue.service';

const expiryService = new ExpiryService(prisma);

/**
 * Bootstraps the application gateway server
 */
async function start() {
  try {
    await prisma.$connect();
    app.log.info('🔌 Connected to PostgreSQL successfully.');

    expiryService.start('0 * * * *');

    const port = config.PORT;
    const address = await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`🚀 Omnimate Inbox Gateway online at ${address}`);
  } catch (err) {
    app.log.error(err, '❌ Crash on boot:');
    process.exit(1);
  }
}

const shutdown = async () => {
  app.log.info('🛑 Shutting down server gracefully...');
  try {
    expiryService.stop();
    
    // Gracefully shut down BullMQ worker and queue connections
    await webhookWorker.close();
    await webhookQueue.close();
    
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
