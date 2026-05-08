import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

// Compact pill UI pinned at top of screen. Default state after Start.
// Expands when a response is streaming/visible. A button switches to the
// full rectangular AssistantView.
export class NotchView extends LitElement {
    static styles = css`
        :host {
            display: block;
            height: 100vh;
            width: 100vw;
            font-family: var(--font);
            -webkit-app-region: drag;
        }

        .notch-root {
            box-sizing: border-box;
            height: 100%;
            width: 100%;
            background: rgba(18, 18, 22, 0.92);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 18px;
            backdrop-filter: blur(24px) saturate(160%);
            -webkit-backdrop-filter: blur(24px) saturate(160%);
            color: #ECECEE;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .strip {
            flex: 0 0 auto;
            height: 56px;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 0 12px 0 14px;
            -webkit-app-region: drag;
        }

        .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #6BCB77;
            box-shadow: 0 0 8px rgba(107, 203, 119, 0.5);
            flex: 0 0 auto;
            transition: background-color 200ms;
        }
        .dot.thinking {
            background: #FFC857;
            box-shadow: 0 0 8px rgba(255, 200, 87, 0.6);
            animation: pulse 1.2s ease-in-out infinite;
        }
        .dot.error {
            background: #EF4444;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.45; }
        }

        .status {
            font-size: 12px;
            color: rgba(236, 236, 238, 0.72);
            white-space: nowrap;
            flex: 0 0 auto;
        }

        .preview {
            flex: 1 1 auto;
            min-width: 0;
            font-size: 13px;
            color: #ECECEE;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            opacity: 0.85;
        }
        .preview.empty { opacity: 0.45; font-style: italic; }

        .icon-btn {
            -webkit-app-region: no-drag;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: rgba(236, 236, 238, 0.85);
            border-radius: 10px;
            width: 32px;
            height: 32px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: background-color 120ms, transform 120ms;
            flex: 0 0 auto;
        }
        .icon-btn:hover { background: rgba(255, 255, 255, 0.12); }
        .icon-btn:active { transform: scale(0.96); }
        .icon-btn svg { width: 16px; height: 16px; }

        .input-row {
            -webkit-app-region: no-drag;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0 14px 12px;
        }
        .input-row input {
            flex: 1 1 auto;
            min-width: 0;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 10px;
            color: #ECECEE;
            font-family: var(--font);
            font-size: 13px;
            padding: 8px 10px;
            outline: none;
            transition: border-color 120ms, background-color 120ms;
        }
        .input-row input:focus {
            border-color: rgba(120, 160, 255, 0.6);
            background: rgba(255, 255, 255, 0.08);
        }
        .input-row input::placeholder { color: rgba(236, 236, 238, 0.42); }

        .response {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
            padding: 0 14px 12px;
            font-size: 13px;
            line-height: 1.5;
            color: #ECECEE;
        }
        .response::-webkit-scrollbar { width: 6px; }
        .response::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.12);
            border-radius: 3px;
        }
        .response p { margin: 0 0 8px; }
        .response strong { color: #FFFFFF; font-weight: 600; }
        .response code {
            background: rgba(255, 255, 255, 0.08);
            padding: 1px 4px;
            border-radius: 4px;
            font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
            font-size: 12px;
        }
        .response ul, .response ol {
            padding-left: 18px;
            margin: 0 0 8px;
        }
    `;

    static properties = {
        responses: { type: Array },
        currentResponseIndex: { type: Number },
        status: { type: String },
        expanded: { type: Boolean },
        onExpandFull: { type: Function },
        onSendText: { type: Function },
    };

    constructor() {
        super();
        this.responses = [];
        this.currentResponseIndex = -1;
        this.status = 'Listening...';
        this.expanded = false;
        this.onExpandFull = () => {};
        this.onSendText = () => {};
    }

    updated(changed) {
        super.updated(changed);
        if (changed.has('responses') || changed.has('currentResponseIndex') || changed.has('expanded')) {
            // Auto-expand when a new response arrives.
            if (this.responses.length > 0 && !this.expanded && changed.has('responses')) {
                this.expanded = true;
                this.dispatchEvent(new CustomEvent('notch-mode-change', {
                    detail: { mode: 'expanded' }, bubbles: true, composed: true,
                }));
                return; // re-render will run with expanded=true
            }
            const body = this.shadowRoot.querySelector('.response');
            if (body) {
                body.innerHTML = this._renderMarkdown(this._currentResponse() || '_(waiting for first response)_');
                body.scrollTop = body.scrollHeight;
            }
        }
    }

    _currentResponse() {
        if (this.responses.length === 0 || this.currentResponseIndex < 0) return '';
        return this.responses[this.currentResponseIndex] || '';
    }

    _previewLine(text) {
        if (!text) return '';
        // Strip markdown for the one-line preview
        return text.replace(/[*_`#>]/g, '').replace(/\n+/g, ' ').slice(0, 80);
    }

    _renderMarkdown(content) {
        if (typeof window !== 'undefined' && window.marked) {
            try {
                window.marked.setOptions({ breaks: true, gfm: true, sanitize: false });
                return window.marked.parse(content);
            } catch (_) {}
        }
        return content;
    }

    _toggleExpanded() {
        this.expanded = !this.expanded;
        this.dispatchEvent(new CustomEvent('notch-mode-change', {
            detail: { mode: this.expanded ? 'expanded' : 'notch' },
            bubbles: true, composed: true,
        }));
    }

    _handleInputKey(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const inp = e.currentTarget;
            const text = (inp.value || '').trim();
            if (text) {
                this.onSendText(text);
                inp.value = '';
            }
        }
    }

    _statusKind() {
        const s = (this.status || '').toLowerCase();
        if (s.includes('thinking') || s.includes('transcribing') || s.includes('generating')) return 'thinking';
        if (s.includes('error') || s.includes('failed')) return 'error';
        return 'ok';
    }

    render() {
        const current = this._currentResponse();
        const preview = this._previewLine(current);
        const dotClass = this._statusKind();

        const expandIcon = this.expanded
            ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>`
            : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

        const fullIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;

        return html`
            <div class="notch-root">
                <div class="strip">
                    <div class="dot ${dotClass}"></div>
                    <div class="status">${this.status || 'Idle'}</div>
                    <div class="preview ${preview ? '' : 'empty'}">${preview || (this.expanded ? '' : 'no response yet')}</div>
                    <button class="icon-btn" title="${this.expanded ? 'Collapse' : 'Expand'}" @click=${this._toggleExpanded}>${expandIcon}</button>
                    <button class="icon-btn" title="Open full chat" @click=${() => this.onExpandFull()}>${fullIcon}</button>
                </div>
                ${this.expanded ? html`
                    <div class="response"></div>
                    <div class="input-row">
                        <input type="text" placeholder="Type to ask…" @keydown=${this._handleInputKey} />
                    </div>
                ` : ''}
            </div>
        `;
    }
}

customElements.define('notch-view', NotchView);
