// CLI provider — talks to Codex (`codex exec --json`) or Claude Code
// (`claude -p --output-format stream-json`) as the LLM backend instead of
// Gemini Live or Ollama. Each user prompt spawns one process; the previous
// session id is passed via `--resume` so context carries over.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { app } = require('electron');

const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');

// Lazy require to avoid circular import (localai → gemini → cliprovider).
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

let cliBackend = 'codex';        // 'codex' or 'claude'
let cliBinary = null;            // resolved path to the binary
let cliExtraArgs = [];           // user-supplied extra args (split on spaces)
let currentSystemPrompt = null;
let currentProfile = null;
let currentCustomPrompt = null;
let workspaceDir = null;
let sessionId = null;            // codex thread_id / claude session_id, captured on first turn
let turnCount = 0;
let activeProc = null;
let isCliActive = false;
let isInitializing = false;      // guards against double-init from rapid Start clicks
let audioEnabled = false;        // Whisper VAD running for this session

function resolveBinary(backend, override) {
    if (override && override.trim()) {
        if (fs.existsSync(override.trim())) return override.trim();
    }
    const candidates = backend === 'claude'
        ? ['/Users/' + os.userInfo().username + '/.local/bin/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
        : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/Users/' + os.userInfo().username + '/.local/bin/codex'];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return backend; // fall back to PATH lookup
}

function ensureWorkspaceDir() {
    const dir = path.join(app.getPath('userData'), 'cli-workspace');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

async function initializeCliSession({ backend = 'codex', binaryPath = '', extraArgs = '', enableAudio = true, whisperModel = 'Xenova/whisper-small' }, profile, customPrompt) {
    if (isInitializing || isCliActive) {
        console.log('[CLI] Init refused: already', isInitializing ? 'initializing' : 'active');
        return isCliActive; // treat as success if already up — UI just re-tried
    }
    console.log('[CLI] Initializing CLI session:', { backend, binaryPath, profile });
    isInitializing = true;
    sendToRenderer('session-initializing', true);

    try {
        cliBackend = backend === 'claude' ? 'claude' : 'codex';
        cliBinary = resolveBinary(cliBackend, binaryPath);
        cliExtraArgs = (extraArgs || '').trim().length > 0 ? extraArgs.trim().split(/\s+/) : [];
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        currentProfile = profile;
        currentCustomPrompt = customPrompt;
        workspaceDir = ensureWorkspaceDir();
        sessionId = null;
        turnCount = 0;

        if (!cliBinary) {
            sendToRenderer('update-status', `${cliBackend} CLI not found`);
            return false;
        }

        // Smoke-test that the binary runs at all (--version is fast and offline).
        const ok = await new Promise(resolve => {
            const test = spawn(cliBinary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            test.stdout.on('data', d => (out += d.toString()));
            test.on('error', err => {
                console.error('[CLI] Binary check spawn error:', err.message);
                resolve(false);
            });
            test.on('close', code => {
                console.log(`[CLI] ${cliBackend} --version exit ${code}: ${out.trim()}`);
                resolve(code === 0);
            });
            setTimeout(() => { try { test.kill(); } catch (_) {} resolve(false); }, 5000);
        });

        if (!ok) {
            sendToRenderer('update-status', `${cliBackend} CLI failed to launch (path: ${cliBinary})`);
            return false;
        }

        initializeNewSession(profile, customPrompt);
        isCliActive = true;

        // Optionally start the Whisper VAD pipeline so spoken audio is transcribed
        // and routed to the CLI as a text turn.
        audioEnabled = false;
        if (enableAudio) {
            try {
                const audioOk = await getLocalAi().initializeAudioOnly(whisperModel, async (transcription) => {
                    if (!transcription || !transcription.trim()) return;
                    console.log('[CLI] Whisper transcribed:', transcription);
                    sendToRenderer('update-status', `${cliBackend} thinking...`);
                    await sendCliText(transcription);
                });
                audioEnabled = !!audioOk;
            } catch (e) {
                console.error('[CLI] Audio init failed:', e);
                audioEnabled = false;
            }
        }

        sendToRenderer('update-status', audioEnabled
            ? `${cliBackend} CLI ready — Listening...`
            : `${cliBackend} CLI ready — type to send a message`);
        console.log('[CLI] Session ready. Workspace:', workspaceDir, 'audio:', audioEnabled);
        return true;
    } finally {
        isInitializing = false;
        sendToRenderer('session-initializing', false);
    }
}

function processCliAudio(monoChunk24k) {
    if (audioEnabled) {
        getLocalAi().processLocalAudio(monoChunk24k);
    }
}

function buildArgs(prompt, imagePaths = []) {
    if (cliBackend === 'codex') {
        if (sessionId && turnCount > 0) {
            // Resume the existing thread. `codex exec resume` does not accept --sandbox/--cd —
            // the resumed session already has those settings; spawn cwd carries the workspace.
            return ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check',
                ...imagePaths.flatMap(p => ['--image', p]),
                ...cliExtraArgs,
                prompt,
            ];
        }
        const baseArgs = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', workspaceDir];
        for (const img of imagePaths) baseArgs.push('--image', img);
        return [...baseArgs, ...cliExtraArgs, prompt];
    }
    // claude
    const baseArgs = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-mode', 'dontAsk', '--tools', '',
        '--append-system-prompt', currentSystemPrompt || ''];
    if (sessionId && turnCount > 0) baseArgs.push('--resume', sessionId);
    return [...baseArgs, ...cliExtraArgs, prompt];
}

function handleCodexLine(line, ctx) {
    let evt;
    try { evt = JSON.parse(line); } catch (_) { return; }

    if (evt.type === 'thread.started' && evt.thread_id) {
        // Always update — if a previous turn was killed mid-flight, the dead
        // thread is empty. Whichever thread.started arrives last for a
        // *successful* turn is the one we want to resume next time. We only
        // bump turnCount on success, so unsuccessful turns won't trigger
        // `--resume` even though we update sessionId here.
        sessionId = evt.thread_id;
        console.log('[CLI] codex thread_id:', sessionId);
    }

    if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
        const text = evt.item.text || '';
        if (text) {
            ctx.fullText += text;
            sendToRenderer(ctx.isFirst ? 'new-response' : 'update-response', ctx.fullText);
            ctx.isFirst = false;
        }
    }

    if (evt.type === 'turn.completed') {
        ctx.done = true;
    }
}

function handleClaudeLine(line, ctx) {
    let evt;
    try { evt = JSON.parse(line); } catch (_) { return; }

    if (evt.session_id) {
        sessionId = evt.session_id;
    }

    if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
        const delta = evt.event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
            ctx.fullText += delta.text;
            sendToRenderer(ctx.isFirst ? 'new-response' : 'update-response', ctx.fullText);
            ctx.isFirst = false;
        }
    }

    if (evt.type === 'result') {
        ctx.done = true;
        if (evt.is_error) {
            ctx.errorMessage = evt.result || 'CLI error';
        }
    }
}

async function runCli(promptForLog, args, displayPromptForHistory) {
    if (activeProc) {
        // A previous turn is still running. Don't kill it — that races with
        // its in-flight thread.started events and can corrupt the resume id.
        // Refuse the new prompt and tell the user.
        sendToRenderer('update-status', `${cliBackend} still answering — wait or close session`);
        return { success: false, error: 'previous turn still running' };
    }

    sendToRenderer('update-status', `${cliBackend} thinking...`);

    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const proc = spawn(cliBinary, args, {
        cwd: workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProc = proc;

    const ctx = { fullText: '', isFirst: true, done: false, errorMessage: null };
    const handler = cliBackend === 'codex' ? handleCodexLine : handleClaudeLine;

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
        if (process.env.DEBUG_CLI) console.log('[CLI raw]', line.slice(0, 300));
        handler(line, ctx);
    });

    let stderrBuf = '';
    proc.stderr.on('data', d => {
        stderrBuf += d.toString();
        if (process.env.DEBUG_CLI) console.error('[CLI stderr]', d.toString());
    });

    return new Promise(resolve => {
        proc.on('error', err => {
            console.error('[CLI] spawn error:', err);
            sendToRenderer('update-status', `${cliBackend} error: ${err.message}`);
            activeProc = null;
            resolve({ success: false, error: err.message });
        });
        proc.on('close', code => {
            activeProc = null;
            if (code !== 0 && !ctx.done) {
                const msg = ctx.errorMessage || stderrBuf.trim().split('\n').pop() || `${cliBackend} exited with code ${code}`;
                console.error('[CLI] non-zero exit:', code, msg);
                sendToRenderer('update-status', `${cliBackend} error: ${msg}`);
                resolve({ success: false, error: msg });
                return;
            }
            const text = ctx.fullText.trim();
            if (text) {
                saveConversationTurn(displayPromptForHistory, text);
                turnCount++;
            } else if (!ctx.errorMessage) {
                sendToRenderer(ctx.isFirst ? 'new-response' : 'update-response', '_(empty response)_');
            }
            console.log(`[CLI] turn ${turnCount} done — ${text.length} chars`);
            sendToRenderer('update-status', `${cliBackend} CLI ready — Listening...`);
            resolve({ success: true, text });
        });
    });
}

async function sendCliText(text) {
    if (!isCliActive) {
        return { success: false, error: 'No active CLI session' };
    }
    if (!text || !text.trim()) {
        return { success: false, error: 'Empty text' };
    }

    let prompt = text.trim();
    // For codex, the system prompt has no flag — prepend it on the very first turn.
    if (cliBackend === 'codex' && turnCount === 0 && currentSystemPrompt) {
        prompt = `${currentSystemPrompt}\n\n---\n\n${prompt}`;
    }

    const args = buildArgs(prompt);
    return runCli(text, args, text);
}

async function sendCliImage(base64Data, prompt) {
    if (!isCliActive) {
        return { success: false, error: 'No active CLI session' };
    }
    const tmpFile = path.join(os.tmpdir(), `cd-screenshot-${Date.now()}.jpg`);
    try {
        fs.writeFileSync(tmpFile, Buffer.from(base64Data, 'base64'));
    } catch (e) {
        return { success: false, error: 'Failed to write screenshot: ' + e.message };
    }

    let userText = prompt || 'Describe the screen and answer any visible question.';
    if (cliBackend === 'codex' && turnCount === 0 && currentSystemPrompt) {
        userText = `${currentSystemPrompt}\n\n---\n\n${userText}`;
    }

    let args;
    if (cliBackend === 'codex') {
        args = buildArgs(userText, [tmpFile]);
    } else {
        // Claude in stream-json text mode doesn't accept --image directly via CLI flag;
        // fall back to text-only with a note. Image support for claude CLI can come later.
        args = buildArgs(`${userText}\n\n[Screenshot attached at ${tmpFile} — please describe your understanding of what is on screen based on the prompt.]`);
    }

    const result = await runCli(prompt, args, prompt);
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    return result;
}

function closeCliSession() {
    console.log('[CLI] Closing CLI session');
    isCliActive = false;
    if (activeProc) {
        try { activeProc.kill('SIGTERM'); } catch (_) {}
        activeProc = null;
    }
    if (audioEnabled) {
        try { getLocalAi().closeAudioOnly(); } catch (_) {}
        audioEnabled = false;
    }
    sessionId = null;
    turnCount = 0;
    currentSystemPrompt = null;
    currentProfile = null;
    currentCustomPrompt = null;
}

function isCliSessionActive() {
    return isCliActive;
}

module.exports = {
    initializeCliSession,
    sendCliText,
    sendCliImage,
    closeCliSession,
    isCliSessionActive,
    processCliAudio,
};
