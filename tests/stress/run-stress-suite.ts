import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { prisma } from '../../src/services/db';

async function runChildScript(scriptPath: string): Promise<boolean> {
  const absolutePath = path.resolve(scriptPath);
  console.log(`\n---------------------------------------------------------`);
  console.log(`🚀 Running script: ${path.basename(absolutePath)}`);
  console.log(`---------------------------------------------------------`);

  return new Promise((resolve) => {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npxCmd, ['tsx', absolutePath], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test', ENDURANCE_DURATION_SEC: process.env.ENDURANCE_DURATION_SEC || '30' },
      shell: process.platform === 'win32'
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Script completed successfully: ${path.basename(absolutePath)}`);
        resolve(true);
      } else {
        console.error(`❌ Script failed with exit code ${code}: ${path.basename(absolutePath)}`);
        resolve(false);
      }
    });

    child.on('error', (err) => {
      console.error(`❌ Spawn error for script ${path.basename(absolutePath)}:`, err);
      resolve(false);
    });
  });
}

async function main() {
  console.log('=========================================================');
  console.log('🏁 OMNIMATE INBOX GATEWAY FINAL SYSTEM VALIDATION RUNNER');
  console.log('=========================================================\n');

  // 1. Reset database tables
  console.log('🧹 Re-applying database schema & migrations...');
  try {
    await prisma.$connect();
    const migrateCmd = process.platform === 'win32' ? 'npx.cmd prisma migrate dev --name init_stress_run' : 'npx prisma migrate dev --name init_stress_run';
    execSync(migrateCmd, { stdio: 'inherit' });
    console.log('✅ DB Migrations completed successfully.');
  } catch (err) {
    console.error('❌ Failed to run migrations:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }

  // 2. Base functional and integration tests
  const baseTests = [
    'src/test-database.ts',
    'src/test-transitions.ts',
    'src/test-storage.ts',
    'src/test-failures.ts',
    'src/test-api.ts',
    'src/test-system-validation.ts',
    'tests/inbox.test.ts'
  ];

  // 3. Performance, load, queue, and stress tests
  const stressTests = [
    'tests/stress/stress-ingestion.ts',
    'tests/stress/stress-transitions.ts',
    'tests/stress/stress-large-files.ts',
    'tests/stress/stress-disk.ts',
    'tests/stress/stress-queue.ts',
    'tests/stress/stress-endurance.ts'
  ];

  console.log('\nRunning baseline health-check and unit/integration tests...');
  const failedScripts: string[] = [];

  for (const testScript of baseTests) {
    if (!fs.existsSync(testScript)) {
      console.warn(`⚠️ Warning: Test file not found: ${testScript}`);
      continue;
    }
    const success = await runChildScript(testScript);
    if (!success) {
      failedScripts.push(testScript);
    }
  }

  if (failedScripts.length > 0) {
    console.error(`\n❌ Base unit/integration tests failed:`, failedScripts);
    console.error('Abort: Stress tests will not run on a failing system.');
    process.exit(1);
  }

  console.log('\n✅ All base health-check and integration tests passed!');
  console.log('=========================================================');
  console.log('🚀 Running Stress and Load validation modules...');
  console.log('=========================================================\n');

  for (const stressScript of stressTests) {
    if (!fs.existsSync(stressScript)) {
      console.warn(`⚠️ Warning: Stress test file not found: ${stressScript}`);
      continue;
    }
    const success = await runChildScript(stressScript);
    if (!success) {
      failedScripts.push(stressScript);
    }
  }

  console.log(`\n=========================================================`);
  console.log(`📊 FINAL TEST RUN SUMMARY`);
  console.log(`=========================================================`);
  if (failedScripts.length === 0) {
    console.log(`🎉 ALL TESTS PASSED SUCCESSFULLY!`);
  } else {
    console.error(`❌ SOME TESTS FAILED:`, failedScripts);
    process.exit(1);
  }
  console.log(`=========================================================\n`);
}

if (require.main === module) {
  main();
}
