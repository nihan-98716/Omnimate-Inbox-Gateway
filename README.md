# Omnimate Inbox Gateway

A centralized, production-grade API Gateway and Triage Storage service designed to ingest, process, and route files sent from feeder applications (**Scanbox** and **Shots**). 

The application is built using **TypeScript**, **Fastify** (web gateway), **Prisma ORM** (PostgreSQL database integration), **BullMQ** (Redis-backed asynchronous background jobs), and includes atomic local file-system storage with modular driver support for S3.

---

## 🎨 Architectural Overview

```
                      +-------------------+
                      |   Feeder Apps     |
                      | (Scanbox / Shots) |
                      +---------+---------+
                                |
                                | POST /api/v1/inbox (with Bearer / API-Key Auth)
                                v
                   +------------+------------+
                   |  Fastify Ingestion API  |
                   +------------+------------+
                                |
        +-----------------------+-----------------------+
        | (Ingestion Phase 1)                           | (Ingestion Phase 2)
        v                                               v
+-------+-------+                               +-------+-------+
|  Temporary    | --[ Calculate SHA-256 Hash ]->| Check DB for  |
| Staging Dir   |                               |  Deduplication|
| (/upload/tmp) |                               +-------+-------+
+---------------+                                       |
                                                        | No Duplicate Found
                                                        v
                                                +-------+-------+
                                                | Promote File  |
                                                | to Permanent  |
                                                |  (/assets/..) |
                                                +-------+-------+
                                                        |
                                                        v
                                                +-------+-------+
                                                | Commit Asset  |
                                                | to PostgreSQL |
                                                +---------------+
```

---

## 🚀 Core Features & Safeguards

### 1. Ingestion Checksum Deduplication
*   Files are hashed (SHA-256) on the fly during upload.
*   If a duplicate hash is found in the database, the uploaded file in temp storage is discarded, and the existing asset record is returned to prevent database and disk bloat.
*   If the existing matching asset was in the `DELETED` (soft-deleted) state, it is restored back to `PROCESS_NOW`.

### 2. Transaction safety & Orphan Prevention
*   Inbound files are staged in `/uploads/tmp` first.
*   If database insertion fails, the temporary file is immediately unlinked.
*   If database insertion fails *after* promotion to permanent storage `/uploads/assets/`, the permanent file is also unlinked (excluding unique checksum constraint collisions `P2002` where the file was uploaded by a concurrent request), preventing file leaks.

### 3. Row-Locked State transitions
*   State transitions are enforced via a formal state machine:
    *   `PROCESS_NOW` $\leftrightarrow$ `SAVE_FOR_LATER` (Valid)
    *   `PROCESS_NOW` / `SAVE_FOR_LATER` $\rightarrow$ `ARCHIVE` (Valid)
    *   `PROCESS_NOW` / `SAVE_FOR_LATER` / `ARCHIVE` $\rightarrow$ `DELETED` (Valid)
    *   `DELETED` $\rightarrow$ `PROCESS_NOW` (Valid - Restore)
*   State transitions use raw PostgreSQL **Pessimistic Row Locking** (`SELECT ... FOR UPDATE` inside a Prisma Transaction). This prevents race conditions under high load, ensuring that concurrent PATCH requests do not trigger duplicate preset webhook dispatches on the same asset.

### 4. Destination Presets & Asynchronous Processing
*   Supports routing files to custom local folder destinations or dispatching HTTP webhooks when an asset transitions to `ARCHIVE`.
*   **Decoupled Webhooks**: Webhook executions are moved out of database transaction blocks to prevent holding DB connections and row locks.
*   **Job Queue (BullMQ + Redis)**: Background processing is handled asynchronously via a BullMQ worker queue backed by persistent Redis.
*   **State Separation**: Decouples active inbox status from processing details using `presetStatus` (`PENDING`, `PROCESSING`, `FAILED`, `COMPLETED`) and `presetError` on the DB schema.
*   **Circuit Breaker**: Webhook dispatches are protected by a custom Circuit Breaker (CLOSED, OPEN, HALF_OPEN) to prevent cascading failures.
*   **Retries**: Webhooks have exponential backoff retries (3 attempts).

### 5. Expiry Lifecycle & Disk Sync Safety
*   A background cron daemon periodically sweeps soft-deleted (`DELETED`) assets.
*   Assets are hard-purged after 30 days.
*   **Sync Guarantee**: The purger deletes physical files first. If physical file unlinking fails (e.g., directory is locked or permissions error), the database delete transaction is aborted. This guarantees that no database records are removed if the physical file remains.

### 6. Disk Capacity Safeguard
*   Ingestion requests verify available disk space in the uploads directory.
*   If the available free space drops below the configurable limit (default: **15%**), uploads are rejected immediately with a `507 Insufficient Storage` status code, shielding the server against disk depletion crashes.

### 7. Security & DDoS Protection
*   **API Authentication**: All API endpoints (except health and metrics) are protected using header-based authorization. Clients must provide `Authorization: Bearer <key>` or `x-api-key: <key>`.
*   **Rate Limiting**: Integrated `@fastify/rate-limit` for DDoS shielding, capping requests per minute per IP.

### 8. Observability & Graceful Shutdowns
*   **Health Endpoints**:
    *   `/health/live`: Basic liveness check.
    *   `/health/ready`: Assesses database and Redis connectivity.
    *   `/health/circuit-breaker`: Reports the current state of the preset webhook circuit breaker.
*   **Telemetry Metrics**: `/metrics` returns Prometheus-compatible metrics tracking HTTP request latency, count, database query durations, and background worker queue size.
*   **Graceful Shutdown**: The service cleanly terminates Redis client connections and BullMQ queues/workers when shutting down, preventing open-handle process hangs.

---

## 🛠️ Tech Stack
*   **Runtime**: Node.js (v18+)
*   **Language**: TypeScript
*   **Web Framework**: Fastify (with `@fastify/multipart`, `@fastify/cors`, and `@fastify/rate-limit`)
*   **Database ORM**: Prisma v6 (PostgreSQL)
*   **Background Worker**: BullMQ + Redis (`ioredis`)
*   **Validation**: Zod (strongly-typed runtime checks)
*   **Scheduler**: node-cron (background daemon)
*   **Disk Check**: check-disk-space
*   **Test Runner**: tsx + assert (lightweight typed runner)

---

## ⚙️ Configuration & Environment Variables

Configure the gateway using a `.env` file at the project root:

```env
PORT=3000
DATABASE_URL=postgresql://postgres:postgrespassword@localhost:5432/omnimate_inbox?schema=public
STORAGE_DRIVER=local
UPLOAD_DIR=./uploads
EXPIRE_AFTER_DAYS=30

# Redis configuration for background queue
REDIS_HOST=localhost
REDIS_PORT=6379

# Queue settings
WEBHOOK_CONCURRENCY=5

# Disk Space Safeguard
MIN_FREE_SPACE_PERCENT=15

# API Authentication Key
API_KEY=your-secure-api-key-here

# Rate Limiting max requests per minute
RATE_LIMIT_MAX=100
```

---

## 📦 Local Installation & Setup

### 1. Start PostgreSQL & Persistent Redis Database
A pre-configured Docker Compose file is included that starts PostgreSQL and Redis with append-only persistence enabled:
```bash
docker-compose up -d
```

### 2. Install Project Dependencies
```bash
npm install
```

### 3. Run Database Migrations
Deploy the database schema via Prisma:
```bash
npx prisma migrate dev
```

### 4. Build and Run Server
```bash
# Start in development mode (with hot-reload)
npx tsx src/index.ts

# Build TypeScript to Javascript
npm run build
```

---

## 📡 API Reference

*Note: All core API routes require authentication header: `Authorization: Bearer <your-api-key>` or `x-api-key: <your-api-key>`.*

### Ingestion Pipeline
*   **POST** `/api/v1/inbox`
    *   **Body**: `multipart/form-data`
        *   `file`: The target file stream.
        *   `source`: Feeder source name (e.g., `"scanbox"` or `"shots"`).
        *   `title`: Optional asset title.
    *   **Response (201 Created)**: Returns the newly created `Asset` object.
    *   **Response (200 OK)**: Returns the existing deduplicated `Asset` object if the checksum already existed.
    *   **Response (507 Insufficient Storage)**: Upload rejected because disk free space is below the safe threshold.

### Inbox Listing
*   **GET** `/api/v1/inbox`
    *   **Query Params**:
        *   `limit`: Page size limit (default `20`, max `100`).
        *   `cursor`: Last asset ID (for cursor pagination).
        *   `type`: Filter by asset type (`PDF`, `IMAGE`, `SCREENSHOT`, `TEXT`, `OTHER`).
        *   `state`: Comma-separated list of active states (defaults to `PROCESS_NOW,SAVE_FOR_LATER`).
    *   **Response (200 OK)**: Returns paginated data and the `nextCursor` key.

### State Transitions
*   **PATCH** `/api/v1/inbox/:id/state`
    *   **Body**:
        ```json
        {
          "state": "ARCHIVE",
          "presetId": "optional-uuid-preset-id",
          "executePreset": true
        }
        ```
    *   **Response (200 OK)**: Updated `Asset` metadata (presetStatus is updated to `PENDING` and queued in BullMQ background job processor).

### Soft-Delete & Archives Page
*   **GET** `/api/v1/recents`
    *   **Query Params**: `limit`, `cursor`.
    *   **Response (200 OK)**: Returns list of deleted and archived assets. Soft-deleted assets include a computed `daysUntilPurge` countdown integer.

### Health and Metrics (Public)
*   **GET** `/health/live`
*   **GET** `/health/ready`
*   **GET** `/health/circuit-breaker`
*   **GET** `/metrics` (Prometheus telemetry metrics)

---

## 🧪 Testing and Verification

Run the full end-to-end integration and stress validation suite using standard npm scripting:

```bash
# Runs the full stress and integration test runner
npx tsx tests/stress/run-stress-suite.ts
```

### Additional System Verification Scripts
*   `npx tsx tests/stress/stress-queue.ts`: Tests BullMQ queueing concurrency limits and Redis container restart persistence mid-flight.
*   `npx tsx tests/stress/stress-disk.ts`: Tests low disk space simulation and unlinking error fallback unlinking.
*   `npx tsx tests/stress/stress-endurance.ts`: Simulates sustained production API traffic for endurance testing.
*   `npx tsx src/test-system-validation.ts`: Executes baseline verification checks.
