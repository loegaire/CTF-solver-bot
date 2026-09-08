/**
 * CLI status query: read the dispatcher DB and print a compact dashboard.
 *
 *   node dist/cli.js status [dbPath]
 *   node dist/cli.js jobs   [dbPath]
 *   node dist/cli.js show <jobId> [dbPath]
 */

import * as db from './database/db.js';
import * as path from 'node:path';

function usage(): void {
    console.log(`usage:
  cli.js status [dbPath]     summary dashboard
  cli.js jobs   [dbPath]     list all jobs
  cli.js show <id> [dbPath]  job details (output, error, flag)`);
}

function nameOf(p: string): string {
    return p.split('/').filter(Boolean).pop() ?? p;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) {
    usage();
    process.exit(1);
}
const dbFile = cmd === 'show' ? (rest[1] ?? 'data/ctf-worker.db') : (rest[0] ?? 'data/ctf-worker.db');

try {
    db.openDb(path.resolve(dbFile));
} catch (e) {
    console.error(`cannot open database: ${(e as Error).message}`);
    process.exit(1);
}

switch (cmd) {
    case 'status': {
        const counts = db.countJobsByStatus();
        const recent = db.getRecentJobsWithChallenge(10);
        console.log('CTF worker status');
        console.log('----------------');
        for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)} ${v}`);
        console.log('\nRecent jobs:');
        for (const r of recent) {
            console.log(`  #${r.job_id} ${nameOf(r.path).padEnd(24)} ${r.status.padEnd(14)} attempts=${r.attempts}`);
        }
        break;
    }
    case 'jobs': {
        const all = db.getRecentJobsWithChallenge(1000);
        console.log('id   challenge              status         attempts  updated');
        for (const r of all) {
            console.log(
                `#${String(r.job_id).padEnd(4)} ${nameOf(r.path).padEnd(22)} ${r.status.padEnd(14)} ${String(r.attempts).padEnd(9)} ${r.updated_at}`,
            );
        }
        break;
    }
    case 'show': {
        const id = Number(rest[0]);
        if (!Number.isFinite(id)) {
            usage();
            process.exit(1);
        }
        const job = db.getJobById(id);
        if (!job) {
            console.error(`job #${id} not found`);
            process.exit(1);
        }
        const ch = db.getChallengeById(job.challenge_id);
        console.log(`job #${job.id}`);
        console.log(`  challenge:   ${ch?.path ?? '?'} @ ${ch?.commit_sha.slice(0, 16)}`);
        console.log(`  status:      ${job.status}`);
        console.log(`  attempts:    ${job.attempts}`);
        console.log(`  solved:      ${job.solved === 1}`);
        console.log(`  flag:        ${job.last_flag ?? '-'}`);
        console.log(`  workspace:   ${job.workspace}`);
        console.log(`  pi session:  ${job.pi_session_id}`);
        if (job.last_error) console.log(`  error:       ${job.last_error}`);
        console.log(`  last output:\n${(job.last_output ?? '').slice(-3000)}`);
        break;
    }
    default:
        usage();
        process.exit(1);
}
