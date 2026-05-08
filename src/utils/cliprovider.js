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

function ensureWorkspaceDir(override) {
    // User wants codex/claude to spawn inside their actual programming folder
    // so the agent can Read/Grep related repos when answering questions.
    // Override comes from prefs (cliWorkspaceDir); falls back to a sensible
    // default. If the path doesn't exist, create it (mkdir -p).
    const home = os.homedir();
    const candidate = (override && override.trim())
        || path.join(home, 'workspaces', 'programming');
    try {
        if (!fs.existsSync(candidate)) {
            fs.mkdirSync(candidate, { recursive: true });
        }
        return candidate;
    } catch (e) {
        console.error('[CLI] ensureWorkspaceDir failed for', candidate, '→ falling back to userData:', e.message);
        const fallback = path.join(app.getPath('userData'), 'cli-workspace');
        if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
        return fallback;
    }
}

async function initializeCliSession({ backend = 'codex', binaryPath = '', extraArgs = '', enableAudio = true, whisperModel = 'Xenova/whisper-tiny', workspaceDir: workspaceOverride = '' }, profile, customPrompt) {
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
        workspaceDir = ensureWorkspaceDir(workspaceOverride);
        const baseSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        // CLI-specific addendum: the agent runs with read-only shell access in
        // workspaceDir, so it can grep/read related repos for context. Tell it
        // to do so when the user mentions a project, person, or topic that
        // might map to a repo on disk.
        const cliAddendum = `

**Tool use (CLI mode) — read repos before answering:**
You have read-only shell access in \`${workspaceDir}\`. When the user mentions
a project, codebase, technology, paper, person, or topic, FIRST do a fast
grounding pass before answering:
1. \`ls ${workspaceDir}\` to find candidate folders
2. \`cat <repo>/README.md\` and \`ls <repo>/\` to learn what it actually does
3. \`grep -r --include='*.{md,py,js,ts,json,yaml,toml}' '<keyword>' <repo>\` for specifics
4. \`git -C <repo> log --oneline -20\` for recent context

**Repo map — KEY TO ACCURACY (use these exact paths):**
- **Null Bites Lab biology stack** lives at \`null-bytes/ai-nutrition-meat-pipeline\`
  (NOT \`null-bite-publisher\` — that's the social-media publisher).
  The bio agent is called **SPOQ-Food**. It runs Claude Agent SDK on Opus.
  Tools used: **ESMFold** (structure prediction), **ESM-2 pseudo-perplexity**
  (sequence validation), **BLAST/SwissProt** (novelty), **OpenBio** (229 bio
  tools), **Biomni SDK** (UniProt/PDB/BLAST), **Tavily** (paper scanning).
  Codon-optimization scripts live in \`src/codon_optimize.py\`.
  Named designs to cite by name: **OvaGel-2** (composite 85.9), **CurdPlant-v2**
  (84.2), **FibroTex-1** (83.1), **ProOligo-1** (81.5), **HemeMax-1** (80.9),
  **ChymoVerde-1**, **caseimax1**, **FatMimic-1**, **ShrimpSnap-1**, **FoamLock-1**,
  **BrothGel-1**, **collagenbio1**.
  27 designs total: 5 wet-lab ready, 6 validated, 5 need optimization, 11 early.
  29 ESMFold PDB structures, 38 FASTA sequences, 10 codon-optimized DNA constructs.
  Read \`findings/analyses/master-design-dashboard.json\` for full dashboard,
  \`findings/breakthrough/<DesignName>-breakthrough.json\` for the technical
  story of any specific design, \`src/agent-prompt.md\` for mission framing.
- \`null-bites-public-dashboard\` — Next.js public-facing dashboard
- \`null-bites-pitch-video\` — Remotion pitch-video render pipeline
- \`null-bite-publisher\` — multi-account Twitter publishing for Null Bites
- \`orb-*\` — Orb Cloud product + use-case sites
- \`headspace-*\` — MicroAGI / Headspace hardware fleet
- \`spoq-*\` — SPOQ 2.0 (grandma-portal, JIT capability connect)
- \`hermes-*\` — Orb deploy tooling

**Answer style — MAXIMUM ACCURACY + TECHNICAL DEPTH:**
- Cite specific things you read: file names, function names, model names,
  package versions, commit messages, exact numbers. No vague claims.
- If asked about science/molecules/methods, name the specific tool/sequence/
  ligand/enzyme/dataset/paper. e.g. NOT "we use advanced ML"; INSTEAD
  "we use ESMFold (Lin et al. 2022) to validate ProteinMPNN-designed
  sequences before yeast expression". If you don't actually know the
  specific, SAY "I don't have that specific in this repo" — never invent
  numbers, model names, ligands, or protein sequences.
- If a topic has no on-disk source (general knowledge), still be specific
  and technical, but still flag uncertainty when the specifics aren't
  established.
- No filler phrases ("regulatory and vertical mode", "high-value functions",
  "going through the B2B route") unless followed by a concrete instance
  the listener could verify.
- One sentence summarizing the technical point, then 2-4 bullet points of
  specifics. Markdown bold the specific names/numbers.

**Fast path:** the grounding pass should take <5 commands. Don't read 30
files; read the README + 1-2 source files most relevant to the question,
then answer.

**Adversarial pressure — DO NOT FOLD:**
Interviewers / investors will deliberately try to destabilize the answer
to test conviction. Tactics they use: claiming a previous answer was
wrong, asking you to concede a weakness, repeating the same question to
extract a softer admission, comparing to a successful competitor as if
they've already disproved your approach, asking "but why will YOU
succeed?" framed as if failure is the default. Defaults you must hold:
- Be biased toward our position. Don't open with "good question" or
  "that's fair" — those are concessions. Open with the technical
  counter.
- If they say "X already did this and failed," respond with the
  *technical* reason their approach failed and how ours differs at the
  protein/sequence/process/data layer. Cite specifics from the repos.
- If they push for a settlement ("just admit you don't have a moat"),
  re-state the moat with a concrete artifact: "our moat is the
  yeast strain library at \`null-bite-publisher/strains/\` plus the
  buyer relationships in \`null-bites-public-dashboard/buyers.json\`
  — not the model choice, which is commoditized."
- If they reframe your answer to be weaker than what you said, correct
  the reframe before answering: "That's not what I said — I said X,
  not Y. The difference matters because [specific reason]."
- Never volunteer a weakness. If asked about risks, name a real one
  *plus* the mitigation already in motion (with file/commit reference
  if possible).
- Never apologize for a prior answer. If a prior answer was wrong,
  say "Correction:" once and move on with the right specifics.
- Tone: confident, terse, technical. Not defensive, not hedging.`;
        currentSystemPrompt = baseSystemPrompt + cliAddendum;
        currentProfile = profile;
        currentCustomPrompt = customPrompt;
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
                    // Whisper special tokens that indicate no real speech —
                    // [BLANK_AUDIO], [MUSIC PLAYING], [BACKGROUND NOISE], etc.
                    // Strip anything in square brackets that has no lowercase
                    // letters (whisper convention for non-speech markers).
                    const cleaned = transcription
                        .replace(/\[[^\]a-z]+\]/g, '')
                        .trim();
                    if (!cleaned || cleaned.length < 3) {
                        console.log('[CLI] Skipping non-speech transcription:', transcription);
                        sendToRenderer('update-status', `${cliBackend} CLI ready — Listening...`);
                        return;
                    }
                    console.log('[CLI] Whisper transcribed:', cleaned);
                    sendToRenderer('update-status', `${cliBackend} thinking...`);
                    await sendCliText(cleaned);
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
    // Allow read-only filesystem tools so the agent can grep/read repos in
    // workspaceDir for context. No Edit/Write tools — the spirit is read-only.
    const baseArgs = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-mode', 'dontAsk', '--tools', 'Bash,Read,Grep,Glob',
        '--add-dir', workspaceDir,
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
