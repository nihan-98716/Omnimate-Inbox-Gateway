# Omnimate Inbox Gateway

A centralized, production-grade API Gateway and Triage Storage service designed to ingest, process, and route files sent from feeder applications (**Scanbox** and **Shots**). 

The application is built using **TypeScript**, **Fastify** (web gateway), **Prisma ORM** (PostgreSQL database integration), and includes atomic local file-system storage with modular driver support for future cloud staging (S3/R2).

---

## 🎨 Architectural Overview

```
                      +-------------------+
                      |   Feeder Apps     |
                      | (Scanbox / Shots) |
                      +---------+---------+
                                |
                                | POST /api/v1/inbox
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

### 4. Destination Presets & Compatibility
*   Supports routing files to custom local folder destinations or dispatching HTTP webhooks upon asset transition to `ARCHIVE`.
*   Includes dynamic schema versioning fallback: legacy version 1 configurations containing `legacy_folder_path` are normalized on the fly to `destination_path` inside the service.
*   Failed webhook dispatches cause the transition to fail with `502 Bad Gateway`, but the asset remains in `PROCESS_NOW` in the active inbox with error logs stored in the metadata column, preventing silent losses.

### 5. Expiry Lifecycle & Disk Sync Safety
*   A background cron daemon periodically sweeps soft-deleted (`DELETED`) assets.
*   Assets are hard-purged after 30 days.
*   **Sync Guarantee**: The purger deletes physical files first. If physical file unlinking fails (e.g., directory is locked or permissions error), the database delete transaction is aborted. This guarantees that no database records are removed if the physical file remains.

---

## 🛠️ Tech Stack
*   **Runtime**: Node.js (v18+)
*   **Language**: TypeScript
*   **Web Framework**: Fastify (with `@fastify/multipart` & `@fastify/cors`)
*   **Database ORM**: Prisma v6 (PostgreSQL)
*   **Validation**: Zod (strongly-typed runtime checks)
*   **Scheduler**: node-cron (background daemon)
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
```

*   `PORT`: Port the Fastify server runs on locally.
*   `DATABASE_URL`: Connection string for PostgreSQL.
*   `STORAGE_DRIVER`: Driver for storage (`local` / `s3`).
*   `UPLOAD_DIR`: Target directory path for file storage.
*   `EXPIRE_AFTER_DAYS`: Days before a soft-deleted asset is purged from the system.

---

## 📦 Local Installation & Setup

### 1. Start PostgreSQL Database
A pre-configured Docker Compose file is included:
```bash
docker-compose up -d
```
This spins up PostgreSQL on port `5432` with username `postgres` and password `postgrespassword`.

### 2. Install Project Dependencies
```bash
npm install
```

### 3. Run Database Migrations
Deploy the database schema via Prisma:
```bash
npx prisma migrate dev
```
This runs the SQL migrations located in `./prisma/migrations/`.

### 4. Build and Run Server
```bash
# Start in development mode (with hot-reload)
npx tsx src/index.ts

# Build TypeScript to Javascript
npm run build
```

---

## 📡 API Reference

### Ingestion Pipeline
*   **POST** `/api/v1/inbox`
    *   **Body**: `multipart/form-data`
        *   `file`: The target file stream.
        *   `source`: Feeder source name (e.g., `"scanbox"` or `"shots"`).
        *   `title`: Optional asset title.
    *   **Response (201 Created)**: Returns the newly created `Asset` object.
    *   **Response (200 OK)**: Returns the existing deduplicated `Asset` object if the checksum already existed.

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
    *   **Response (200 OK)**: Updated `Asset` metadata.
    *   **Response (502 Bad Gateway)**: Preset webhook execution failed (asset remains in `PROCESS_NOW`).

### Soft-Delete & Archives Page
*   **GET** `/api/v1/recents`
    *   **Query Params**: `limit`, `cursor`.
    *   **Response (200 OK)**: Returns list of deleted and archived assets. Soft-deleted assets include a computed `daysUntilPurge` countdown integer.

---

## 🧪 Testing and Verification

Run the full end-to-end integration test suite using standard npm scripting:

```bash
# Runs tests/inbox.test.ts
npm test
```

### Additional System Verification Scripts
*   `npx tsx src/test-system-validation.ts`: Executes a rigorous 36-check system test suite covering simultaneous uploads, transition concurrency, database rollbacks, webhook failures, and pagination.
*   `npx tsx src/test-database.ts`: Validates schema validity, unique constraints, and transaction rollback properties.
*   `npx tsx src/test-transitions.ts`: Validates states validation mapping.
*   `npx tsx src/test-failures.ts`: Tests webhook errors and unlinking failure locking blocks.
*   `npx tsx src/test-storage.ts`: Tests disk movements, staged moves, and temp deletes.
