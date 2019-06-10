function fatal(msg: string) {
    alert(msg);
    throw new Error(msg);
}

function checkCompat(prop: string) {
    if (prop in window) {
        return; // OK
    }
    fatal(`window.${prop} is not supported by this browser`);
}

checkCompat('Worker');
checkCompat('Atomics');
checkCompat('SharedArrayBuffer');

class VimWorker {
    public readonly sharedBuffer: Int32Array;
    private readonly worker: Worker;
    private readonly onMessage: (msg: MessageFromWorker) => void;

    constructor(scriptPath: string, onMessage: (msg: MessageFromWorker) => void) {
        this.worker = new Worker(scriptPath);
        this.worker.onmessage = this.recvMessage.bind(this);
        this.sharedBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1));
        this.onMessage = onMessage;
    }

    sendMessage(msg: MessageFromMain) {
        debug('send to worker:', msg);
        this.worker.postMessage(msg);
    }

    awakeWorkerThread() {
        // TODO: Define how to use the shared memory buffer
        Atomics.store(this.sharedBuffer, 0, 1);
    }

    private recvMessage(e: MessageEvent) {
        this.onMessage(e.data);
    }
}

class ResizeHandler {
    elemHeight: number;
    elemWidth: number;
    private readonly canvas: HTMLCanvasElement;
    private bounceTimerToken: number | null;
    private readonly worker: VimWorker;

    constructor(canvas: HTMLCanvasElement, worker: VimWorker) {
        this.canvas = canvas;
        this.worker = worker;
        const rect = this.canvas.getBoundingClientRect();
        this.elemHeight = rect.height;
        this.elemWidth = rect.width;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.bounceTimerToken = null;
        this.onResize = this.onResize.bind(this);
    }

    onVimInit() {
        window.addEventListener('resize', this.onResize, { passive: true });
    }

    onVimExit() {
        window.removeEventListener('resize', this.onResize);
    }

    private doResize() {
        const rect = this.canvas.getBoundingClientRect();
        debug('Resize Vim:', rect);
        this.elemWidth = rect.width;
        this.elemHeight = rect.height;
        this.worker.sendMessage({
            kind: 'resize',
            height: rect.height,
            width: rect.width,
        });
    }

    private onResize() {
        if (this.bounceTimerToken !== null) {
            window.clearTimeout(this.bounceTimerToken);
        }
        this.bounceTimerToken = window.setTimeout(() => {
            this.bounceTimerToken = null;
            this.doResize();
        }, 1000);
    }
}

// TODO: IME support
// TODO: Handle pre-edit IME state
// TODO: Follow cursor position
class InputHandler {
    private readonly worker: VimWorker;
    private readonly elem: HTMLInputElement;

    constructor(worker: VimWorker) {
        this.worker = worker;
        this.elem = document.getElementById('vim-input') as HTMLInputElement;
        // TODO: Bind compositionstart event
        // TODO: Bind compositionend event
        this.onKeydown = this.onKeydown.bind(this);
        this.onBlur = this.onBlur.bind(this);
        this.onFocus = this.onFocus.bind(this);
        this.focus();
    }

    setFont(name: string, size: number) {
        this.elem.style.fontFamily = name;
        this.elem.style.fontSize = size + 'px';
    }

    focus() {
        this.elem.focus();
    }

    onVimInit() {
        this.elem.addEventListener('keydown', this.onKeydown);
        this.elem.addEventListener('blur', this.onBlur);
        this.elem.addEventListener('focus', this.onFocus);
    }

    onVimExit() {
        this.elem.removeEventListener('keydown', this.onKeydown);
        this.elem.removeEventListener('blur', this.onBlur);
        this.elem.removeEventListener('focus', this.onFocus);
    }

    private onKeydown(event: KeyboardEvent) {
        event.preventDefault();
        event.stopPropagation();
        debug('onKeydown():', event, event.key, event.keyCode);

        const key = event.key;
        const ctrl = event.ctrlKey;
        const shift = event.shiftKey;
        const alt = event.altKey;
        const meta = event.metaKey;

        if (key.length > 1) {
            if (
                key === 'Unidentified' ||
                (ctrl && key === 'Control') ||
                (shift && key === 'Shift') ||
                (alt && key === 'Alt') ||
                (meta && key === 'Meta')
            ) {
                debug('Ignore key input', key);
                return;
            }
        }

        this.worker.awakeWorkerThread();
        this.worker.sendMessage({
            kind: 'key',
            code: event.code,
            keyCode: event.keyCode,
            key,
            ctrl,
            shift,
            alt,
            meta,
        });
        // TODO: wake worker thread by writing shared buffer
    }

    private onFocus() {
        debug('onFocus()');
        // TODO: Send <FocusGained> special character
    }

    private onBlur(event: Event) {
        debug('onBlur():', event);
        event.preventDefault();
        // TODO: Send <FocusLost> special character
    }
}

// Origin is at left-above.
//
//      O-------------> x
//      |
//      |
//      |
//      |
//      V
//      y

class ScreenCanvas implements DrawEventHandler {
    worker: VimWorker;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    resizer: ResizeHandler;
    input: InputHandler;
    fgColor: string;
    bgColor: string;
    spColor: string;
    fontName: string;
    queue: DrawEventMessage[];
    rafScheduled: boolean;

    constructor(worker: VimWorker) {
        this.worker = worker;
        this.canvas = document.getElementById('vim-screen') as HTMLCanvasElement;
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.canvas.addEventListener('click', this.onClick.bind(this));
        this.resizer = new ResizeHandler(this.canvas, this.worker);
        this.input = new InputHandler(this.worker);
        this.onAnimationFrame = this.onAnimationFrame.bind(this);
        this.queue = [];
        this.rafScheduled = false;
    }

    onVimInit() {
        this.resizer.onVimInit();
        this.input.onVimInit();
    }

    onVimExit() {
        this.resizer.onVimExit();
        this.input.onVimExit();
    }

    enqueue(msg: DrawEventMessage) {
        if (!this.rafScheduled) {
            window.requestAnimationFrame(this.onAnimationFrame);
            this.rafScheduled = true;
        }
        this.queue.push(msg);
    }

    setColorFG(name: string) {
        this.fgColor = name;
    }

    setColorBG(name: string) {
        this.bgColor = name;
    }

    setColorSP(name: string) {
        this.spColor = name;
    }

    setFont(name: string, size: number) {
        this.fontName = name;
        this.input.setFont(name, size);
    }

    drawRect(x: number, y: number, w: number, h: number, color: string, filled: boolean) {
        const dpr = window.devicePixelRatio || 1;
        x = Math.floor(x * dpr);
        y = Math.floor(y * dpr);
        w = Math.floor(w * dpr);
        h = Math.floor(h * dpr);
        this.ctx.fillStyle = color;
        if (filled) {
            this.ctx.fillRect(x, y, w, h);
        } else {
            this.ctx.rect(x, y, w, h);
        }
    }

    drawText(
        text: string,
        ch: number,
        lh: number,
        cw: number,
        x: number,
        y: number,
        bold: boolean,
        underline: boolean,
        undercurl: boolean,
        strike: boolean,
    ) {
        const dpr = window.devicePixelRatio || 1;
        ch = ch * dpr;
        lh = lh * dpr;
        cw = cw * dpr;
        x = x * dpr;
        y = y * dpr;

        let font = Math.floor(ch) + 'px ' + this.fontName;
        if (bold) {
            font = 'bold ' + font;
        }

        this.ctx.font = font;
        this.ctx.textBaseline = 'ideographic';
        this.ctx.fillStyle = this.fgColor;

        const yi = Math.floor(y + lh);
        for (let i = 0; i < text.length; ++i) {
            this.ctx.fillText(text[i], Math.floor(x + cw * i), yi);
        }

        if (underline) {
            this.ctx.strokeStyle = this.fgColor;
            this.ctx.lineWidth = 1 * dpr;
            this.ctx.setLineDash([]);
            this.ctx.beginPath();
            // Note: 3 is set with considering the width of line.
            // TODO: Calcurate the position of the underline with descent.
            const underlineY = Math.floor(y + lh - 3 * dpr);
            this.ctx.moveTo(Math.floor(x), underlineY);
            this.ctx.lineTo(Math.floor(x + cw * text.length), underlineY);
            this.ctx.stroke();
        } else if (undercurl) {
            this.ctx.strokeStyle = this.spColor;
            this.ctx.lineWidth = 1 * dpr;
            const curlWidth = Math.floor(cw / 3);
            this.ctx.setLineDash([curlWidth, curlWidth]);
            this.ctx.beginPath();
            // Note: 3 is set with considering the width of line.
            // TODO: Calcurate the position of the underline with descent.
            const undercurlY = Math.floor(y + lh - 3 * dpr);
            this.ctx.moveTo(Math.floor(x), undercurlY);
            this.ctx.lineTo(Math.floor(x + cw * text.length), undercurlY);
            this.ctx.stroke();
        } else if (strike) {
            this.ctx.strokeStyle = this.fgColor;
            this.ctx.lineWidth = 1 * dpr;
            this.ctx.beginPath();
            const strikeY = Math.floor(y + lh / 2);
            this.ctx.moveTo(Math.floor(x), strikeY);
            this.ctx.lineTo(Math.floor(x + cw * text.length), strikeY);
            this.ctx.stroke();
        }
    }

    invertRect(x: number, y: number, w: number, h: number) {
        const dpr = window.devicePixelRatio || 1;
        x = Math.floor(x * dpr);
        y = Math.floor(y * dpr);
        w = Math.floor(w * dpr);
        h = Math.floor(h * dpr);

        const img = this.ctx.getImageData(x, y, w, h);
        const data = img.data;
        const len = data.length;
        for (let i = 0; i < len; ++i) {
            data[i] = 255 - data[i];
            ++i;
            data[i] = 255 - data[i];
            ++i;
            data[i] = 255 - data[i];
            ++i; // Skip alpha
        }
        this.ctx.putImageData(img, x, y);
    }

    imageScroll(x: number, sy: number, dy: number, w: number, h: number) {
        const dpr = window.devicePixelRatio || 1;
        x = Math.floor(x * dpr);
        sy = Math.floor(sy * dpr);
        dy = Math.floor(dy * dpr);
        w = Math.floor(w * dpr);
        h = Math.floor(h * dpr);
        this.ctx.drawImage(this.canvas, x, sy, w, h, x, dy, w, h);
    }

    private onClick() {
        this.input.focus();
    }

    private onAnimationFrame() {
        debug('Rendering events on animation frame:', this.queue.length);
        for (const [method, args] of this.queue) {
            this[method].apply(this, args);
        }
        this.queue = [];
        this.rafScheduled = false;
    }
}

class VimWasm {
    private readonly worker: VimWorker;
    private readonly screen: ScreenCanvas;

    constructor(workerScript: string) {
        this.worker = new VimWorker(workerScript, this.onMessage.bind(this));
        this.screen = new ScreenCanvas(this.worker);
    }

    start() {
        this.worker.sendMessage({
            kind: 'start',
            buffer: this.worker.sharedBuffer,
            canvasDomHeight: this.screen.resizer.elemHeight,
            canvasDomWidth: this.screen.resizer.elemWidth,
            debug: DEBUGGING,
        });
    }

    private onMessage(msg: MessageFromWorker) {
        debug('from worker:', msg);
        switch (msg.kind) {
            case 'draw':
                this.screen.enqueue(msg.event);
                break;
            case 'started':
                this.screen.onVimInit();
                break;
            case 'exit':
                this.screen.onVimExit();
                break;
            case 'fatal':
                fatal(msg.message);
                break;
            default:
                throw new Error(`FATAL: Unexpected message from worker: ${msg}`);
                break;
        }
    }
}

const vim = new VimWasm('worker.js');
vim.start();
