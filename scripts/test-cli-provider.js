// Smoke-test the codex/claude line parsers from cliprovider.js without the
// Electron UI in the loop. Spawns the real binary, feeds the same args our
// provider builds, captures `new-response`/`update-response` IPC messages,
// and prints a verdict.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const backend = process.argv[2] || 'codex';
const prompt = process.argv[3] || "Reply with exactly the word PONG and nothing else.";

const workspaceDir = path.join(os.tmpdir(), 'cd-cli-test');
fs.mkdirSync(workspaceDir, { recursive: true });

let sessionId = null;
const events = [];
function fakeSendToRenderer(channel, data) {
    events.push({ channel, data });
    if (channel === 'new-response' || channel === 'update-response') {
        process.stdout.write(`\r[${channel}] ${String(data).slice(-80)}`);
    } else {
        console.log(`\n[${channel}]`, data);
    }
}

function handleCodex(line, ctx) {
    let evt;
    try { evt = JSON.parse(line); } catch (_) { return; }
    if (evt.type === 'thread.started' && evt.thread_id) sessionId = evt.thread_id;
    if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
        const text = evt.item.text || '';
        if (text) {
            ctx.fullText += text;
            fakeSendToRenderer(ctx.isFirst ? 'new-response' : 'update-response', ctx.fullText);
            ctx.isFirst = false;
        }
    }
    if (evt.type === 'turn.completed') ctx.done = true;
}

function handleClaude(line, ctx) {
    let evt;
    try { evt = JSON.parse(line); } catch (_) { return; }
    if (evt.session_id && !sessionId) sessionId = evt.session_id;
    if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
        const d = evt.event.delta;
        if (d?.type === 'text_delta' && d.text) {
            ctx.fullText += d.text;
            fakeSendToRenderer(ctx.isFirst ? 'new-response' : 'update-response', ctx.fullText);
            ctx.isFirst = false;
        }
    }
    if (evt.type === 'result') ctx.done = true;
}

function buildArgs(p, resume) {
    if (backend === 'codex') {
        if (resume) {
            return ['exec', 'resume', resume, '--json', '--skip-git-repo-check', p];
        }
        return ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', workspaceDir, p];
    }
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-mode', 'dontAsk', '--tools', '',
        '--append-system-prompt', 'You are a terse assistant. Reply briefly.'];
    if (resume) args.push('--resume', resume);
    args.push(p);
    return args;
}

async function run(p, resume) {
    const args = buildArgs(p, resume);
    console.log(`\n→ Running: ${backend} ${args.slice(0, 6).join(' ')} ... (prompt elided)`);
    const proc = spawn(backend, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    const ctx = { fullText: '', isFirst: true, done: false };
    const handler = backend === 'codex' ? handleCodex : handleClaude;
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', l => handler(l, ctx));
    let stderrBuf = '';
    proc.stderr.on('data', d => (stderrBuf += d.toString()));
    return new Promise(resolve => {
        proc.on('close', code => {
            console.log(`\n  ↳ exit ${code}, captured ${ctx.fullText.length} chars, sessionId=${sessionId}`);
            if (stderrBuf.trim()) console.log('  stderr:', stderrBuf.trim().slice(0, 300));
            resolve({ code, text: ctx.fullText, done: ctx.done });
        });
        proc.on('error', err => {
            console.error('spawn error:', err);
            resolve({ code: -1, error: err.message });
        });
    });
}

(async () => {
    // Turn 1
    const t1 = await run(prompt);
    if (t1.code !== 0 || !t1.text.trim()) {
        console.log('\n❌ FAIL: turn 1 produced no output');
        process.exit(1);
    }
    console.log(`\n✓ turn 1: ${JSON.stringify(t1.text.slice(0, 60))}`);

    // Turn 2 — resume to test session continuity
    if (!sessionId) {
        console.log('\n⚠ no sessionId captured — skipping resume test');
        process.exit(0);
    }
    const t2 = await run("What was the exact word I asked you to reply with on my previous message? Repeat just that one word.", sessionId);
    if (t2.code !== 0 || !t2.text.trim()) {
        console.log('\n❌ FAIL: resume turn produced no output');
        process.exit(2);
    }
    console.log(`\n✓ turn 2 (resumed): ${JSON.stringify(t2.text.slice(0, 80))}`);
    if (/pong/i.test(t2.text)) {
        console.log('\n✅ PASS: session resume preserved context');
    } else {
        console.log('\n⚠ PARTIAL: turn 2 ran but did not reference "PONG" — context may not have transferred');
    }
})();
