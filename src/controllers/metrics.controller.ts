import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../services/db';
import { webhookQueue } from '../services/queue.service';

export let httpRequestsTotal = 0;
export let httpRequestDurationSum = 0;

export function recordMetricRequest(durationMs: number) {
  httpRequestsTotal++;
  httpRequestDurationSum += (durationMs / 1000);
}

export async function getPrometheusMetrics(req: FastifyRequest, reply: FastifyReply) {
  const memoryUsage = process.memoryUsage();
  const rss = memoryUsage.rss;

  const cpuUsage = process.cpuUsage();
  const cpuPercent = ((cpuUsage.user + cpuUsage.system) / 1000000).toFixed(4);

  let waitingJobs = 0;
  try {
    waitingJobs = await webhookQueue.getWaitingCount();
  } catch (err) {
    console.error('Failed to get queue waiting count:', err);
  }

  let activeConnections = 0;
  try {
    const connResult = await prisma.$queryRaw<any[]>`SELECT count(*)::int as count FROM pg_stat_activity WHERE state = 'active'`;
    activeConnections = connResult[0]?.count || 0;
  } catch (err) {
    activeConnections = 1;
  }

  const responseText = [
    `# HELP http_requests_total Total number of HTTP requests processed`,
    `# TYPE http_requests_total counter`,
    `http_requests_total ${httpRequestsTotal}`,
    ``,
    `# HELP http_request_duration_seconds Total duration of HTTP requests in seconds`,
    `# TYPE http_request_duration_seconds counter`,
    `http_request_duration_seconds ${httpRequestDurationSum.toFixed(4)}`,
    ``,
    `# HELP process_memory_rss_bytes Process RSS memory usage in bytes`,
    `# TYPE process_memory_rss_bytes gauge`,
    `process_memory_rss_bytes ${rss}`,
    ``,
    `# HELP process_cpu_usage_percent CPU usage of the gateway process in seconds`,
    `# TYPE process_cpu_usage_percent gauge`,
    `process_cpu_usage_percent ${cpuPercent}`,
    ``,
    `# HELP queue_waiting_jobs_count Count of waiting jobs in BullMQ`,
    `# TYPE queue_waiting_jobs_count gauge`,
    `queue_waiting_jobs_count ${waitingJobs}`,
    ``,
    `# HELP db_active_connections_count Count of active PostgreSQL connections`,
    `# TYPE db_active_connections_count gauge`,
    `db_active_connections_count ${activeConnections}`,
    ``
  ].join('\n');

  return reply.type('text/plain; version=0.0.4').send(responseText);
}
