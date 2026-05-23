# Omnimate Inbox Gateway Initialization Manifesto

This manifest defines the architectural boundaries, system rules, and design safeguards for the Omnimate Inbox Gateway. It serves as the project baseline to ensure development aligns with the long-term goals.

---

## 1. Project Goal
Build a centralized, containerized backend service (API Gateway + Storage + Database) that acts as the ingestion and triage repository for the feeder applications **Scanbox** and **Shots**.

---

## 2. Core Requirements Checklist

### A. Core Framework & Storage
- [ ] TypeScript/Node.js application inside Fastify.
- [ ] Centralized PostgreSQL instance using Prisma ORM.
- [ ] Uploaded assets stored locally (mapped via Docker volumes), with modular driver support for S3/R2 migration.
- [ ] Environment validation using strict schema checks.

### B. Triage State Machine
- [ ] Enforce the 4 core states: `PROCESS_NOW`, `SAVE_FOR_LATER`, `ARCHIVE`, and `DELETED`.
- [ ] Block invalid state transitions at the service layer.
- [ ] Automatically calculate `deletedAt` metadata timestamps on state transitions.

### C. Expiry and Purge Lifecycle
- [ ] 30-day default TTL rule for `DELETED` assets.
- [ ] Automatic, background clean-up daemon that deletes physical storage files first, then deletes database records.
- [ ] Clear tracking of soft-delete expiration days on the `/recents` endpoint.

### D. Destination Presets
- [ ] Dynamic JSON configuration storage supporting schema versioning (e.g. `schemaVersion`).
- [ ] Integration of Preset Execution for `local_folder`, `webhook`, and `s3` targets.
- [ ] Preset failure safety (assets remain in inbox with failure state rather than being lost).

---

## 3. Foolproof Architectural Rules

1.  **Deduplication Constraint**: Ingested files must be hashed (SHA-256) on the fly. Duplicate assets must be merged to prevent storage waste.
2.  **Transaction Priority**: Files must be written to `/uploads/tmp` before a database record is committed. On database commit success, files are moved to permanent storage. On failure, the tmp file is cleaned up.
3.  **Strict State Transition Map**:
    *   `PROCESS_NOW` $\leftrightarrow$ `SAVE_FOR_LATER` (Valid)
    *   `PROCESS_NOW` / `SAVE_FOR_LATER` $\rightarrow$ `ARCHIVE` (Valid)
    *   `PROCESS_NOW` / `SAVE_FOR_LATER` / `ARCHIVE` $\rightarrow$ `DELETED` (Valid)
    *   `DELETED` $\rightarrow$ `PROCESS_NOW` (Valid - Restore)
    *   Any other transition is rejected with a `400 Bad Request`.

---

## 4. Initial Setup Commands

To initialize this workspace:
1.  Run `npm init -y` to create the package base.
2.  Install dependencies: `typescript`, `fastify`, `@prisma/client`, `prisma`, `zod`, `dotenv`.
3.  Configure `tsconfig.json` for ESNext target and modern module resolution.
4.  Write the Prisma schema and spin up the PostgreSQL database in Docker Compose.
