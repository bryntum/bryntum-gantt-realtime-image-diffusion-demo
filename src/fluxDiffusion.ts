// DOM → PNG → FLUX.2 [klein] realtime loop: the experimental HTML-in-Canvas
// API paints the live Gantt into a canvas, and each frame is streamed to
// fal-ai/flux-2/klein/realtime over a websocket along with a style prompt.
//
// API usage based on research/fal-flux2-klein-realtime.md.

import { fal } from '@fal-ai/client';

// Experimental HTML-in-Canvas API (Chrome flag: canvas-draw-element). The
// Gantt renders inside a <canvas layoutsubtree> and each frame is a near-free
// drawImage from that canvas (~1ms). Capture only affects frame freshness;
// the fps ceiling is set by the model round trip.
export const HIC_SUPPORTED =
    typeof CanvasRenderingContext2D !== 'undefined' &&
    'drawElementImage' in CanvasRenderingContext2D.prototype;

// The model only outputs square images. We stretch the wide Gantt capture
// into a square before sending; stretching the result back over the Gantt
// cancels the distortion. Large Gantt text (see App.css) keeps labels legible
// to the model despite the squash. The endpoint's schema states the optimal
// input format is 704x704 JPEG at 50% quality (see
// research/fal-flux2-klein-realtime.md, OpenAPI section).
const INPUT_SIZE = 704;
const INPUT_JPEG_QUALITY = 0.5;

// Frames in flight at once: while the server renders one frame, the next is
// already being captured and uploaded. Raising this beyond 2 mostly adds lag
// between what you do on the Gantt and what you see rendered.
const MAX_IN_FLIGHT = 2;

// Style board inspired by the prompt grid in research/design/form.png
export function buildPrompt(style : string) : string {
    return `Convert this Bryntum Gantt chart project plan into ${style}. Keep the exact same layout, task bars, columns and text.`;
}

export const STYLE_PRESETS = [
    { key : 'felt', label : 'Felt Craft', style : 'a hand-stitched felt craft board with fabric textures and visible stitching' },
    { key : 'cork', label : 'Cork Board', style : 'a cork noticeboard with paper strips, push pins and handwritten labels' },
    { key : 'wood', label : 'Wood Carving', style : 'a hand-carved wooden planning board with burnt-in lettering' },
    { key : 'lego', label : 'LEGO', style : 'a scene built from LEGO bricks with studded tiles' },
    { key : 'playdoh', label : 'Play-Doh', style : 'a scene sculpted from Play-Doh modelling clay' },
    { key : 'clay', label : 'Claymation', style : 'a claymation scene with fingerprints in the plasticine' },
    { key : 'paper', label : 'Paper Diorama', style : 'a layered paper diorama cut from colored card' },
    { key : 'needle', label : 'Needle Felted', style : 'a needle-felted wool scene' },
    { key : 'knit', label : 'Knitted Wool', style : 'a chunky knitted wool blanket' },
    { key : 'sticker', label : 'Sticker Book', style : 'a glossy sticker book page' },
    { key : 'coloring', label : 'Coloring Book', style : 'a black and white coloring book page with bold outlines' },
    { key : 'comic', label : 'Comic Book', style : 'a vintage comic book panel with halftone dots' },

    { key : 'storybook', label : 'Storybook', style : 'a watercolor children’s storybook illustration' },
    { key : 'blueprint', label : 'Blueprint', style : 'a hand-drawn architect’s blueprint in white ink on blue paper' },
    { key : 'whiteboard', label : 'Whiteboard', style : 'a hand-drawn whiteboard sketch in marker pen' },
    { key : 'marble', label : 'Marble Statue', style : 'a relief carved from white marble' },
    { key : 'cyberpunk', label : 'Cyberpunk', style : 'a neon cyberpunk hologram interface' }
] as const;

export type StyleKey = typeof STYLE_PRESETS[number]['key'];

type FluxImage = {
    url? : string;
    content? : Uint8Array;
    data? : Uint8Array;
    content_type? : string;
};

type FluxResult = {
    images? : (FluxImage | string | Uint8Array)[];
};

// Input schema documented in research/fal-flux2-klein-realtime.md
type GanttDiffusionInput = {
    prompt : string;
    image_url : string;
    sync_mode : boolean;
    image_size : 'square' | 'square_hd';
    num_inference_steps : number;
    seed : number;
};

type DiffusionOptions = {
    // Live <canvas layoutsubtree> holding the Gantt, painted via
    // drawElementImage on the canvas's paint event
    captureSource : () => HTMLCanvasElement | null;
    getPrompt     : () => string;
    onFrame       : (url : string) => void;
    onError       : (message : string) => void;
};

// Fetches a short-lived JWT from the Vite dev-server endpoint (see
// vite.config.ts), so the fal.ai API key never reaches the browser
async function fetchRealtimeToken() : Promise<string> {
    const response = await fetch('/api/fal/token', { method : 'POST' });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(text);
    }
    return text;
}

// The realtime output arrives either as a base64 data URI (sync_mode) or as
// raw bytes (msgpack) — handle both. See research/fal-flux2-klein-realtime.md.
function toFrameUrl(image : FluxImage | string | Uint8Array | undefined) : string | null {
    if (!image) {
        return null;
    }
    if (typeof image === 'string') {
        return image;
    }
    if (image instanceof Uint8Array) {
        return URL.createObjectURL(new Blob([image as BlobPart], { type : 'image/jpeg' }));
    }
    if (typeof image.url === 'string') {
        return image.url;
    }
    const bytes = image.content ?? image.data;
    if (bytes) {
        return URL.createObjectURL(new Blob([bytes as BlobPart], { type : image.content_type ?? 'image/jpeg' }));
    }
    return null;
}

// Downscales a reference image and asks a vision LLM (via the Vite dev-server
// endpoint /api/fal/describe) to describe its visual style. The realtime Flux
// endpoint has no reference-image input, so "style from image" works by
// converting the image to a text prompt. See research/fal-any-llm-vision.md.
export async function describeImageStyle(file : File) : Promise<{ thumbnail : string; style : string }> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const thumbnail = canvas.toDataURL('image/jpeg', 0.8);

    const response = await fetch('/api/fal/describe', {
        method  : 'POST',
        headers : { 'Content-Type' : 'application/json' },
        body    : JSON.stringify({ image : thumbnail })
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(text);
    }
    const { output, error } = JSON.parse(text) as { output? : string; error? : string | null };
    if (error || !output) {
        throw new Error(error ?? 'The vision model returned no description');
    }
    return { thumbnail, style : output.trim() };
}

export function createGanttDiffusion({ captureSource, getPrompt, onFrame, onError } : DiffusionOptions) {
    let connection : { send(input : GanttDiffusionInput) : void; close() : void } | null = null;
    let running = false;
    let inFlight = 0;
    let lastBlobUrl : string | null = null;
    let lastActivity = 0;
    let watchdog : number | null = null;
    let lastSentKey = '';

    function pump() {
        const liveCanvas = captureSource();
        if (!running || inFlight >= MAX_IN_FLIGHT || !connection || !liveCanvas || liveCanvas.width === 0) {
            return;
        }
        try {
            // The Gantt is already painted into the live canvas by the
            // HTML-in-Canvas paint handler, so grabbing a frame is a single
            // drawImage
            const square = document.createElement('canvas');
            square.width = square.height = INPUT_SIZE;
            const squareCtx = square.getContext('2d')!;
            squareCtx.fillStyle = '#ffffff';
            squareCtx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
            squareCtx.drawImage(liveCanvas, 0, 0, INPUT_SIZE, INPUT_SIZE);

            const prompt = getPrompt();
            const imageUrl = square.toDataURL('image/jpeg', INPUT_JPEG_QUALITY);

            // Identical frame + identical prompt would generate an identical
            // (fixed-seed) result — skip the paid API call and poll again
            // shortly instead. Any Gantt interaction or prompt change alters
            // the key and resumes sending.
            const sendKey = prompt + imageUrl;
            if (sendKey === lastSentKey) {
                window.setTimeout(pump, 150);
                return;
            }
            lastSentKey = sendKey;

            connection.send({
                prompt,
                image_url           : imageUrl,
                sync_mode           : true,
                image_size          : 'square',
                num_inference_steps : 3,
                // Fixed seed keeps consecutive frames visually stable
                seed                : 35
            });
            inFlight++;
            lastActivity = performance.now();
        }
        catch (error) {
            onError(error instanceof Error ? error.message : String(error));
        }
        // Keep the pipeline full: capture the next frame while the server is
        // still rendering this one (bails out at MAX_IN_FLIGHT)
        pump();
    }

    function handleResult(result : FluxResult) {
        inFlight = Math.max(0, inFlight - 1);
        lastActivity = performance.now();
        const url = toFrameUrl(result.images?.[0]);
        if (url) {
            if (lastBlobUrl) {
                URL.revokeObjectURL(lastBlobUrl);
            }
            lastBlobUrl = url.startsWith('blob:') ? url : null;
            onFrame(url);
        }
        void pump();
    }

    return {
        start() {
            if (running) {
                return;
            }
            running = true;
            // A request dropped by the server would otherwise leave a stale
            // in-flight count from a previous run
            inFlight = 0;
            // Always send at least one frame on (re)start
            lastSentKey = '';
            lastActivity = performance.now();
            // A send swallowed by the client throttle or dropped by the server
            // never produces a result, which would strand the in-flight count
            // at the cap and freeze the stream — detect the silence and resume
            watchdog = window.setInterval(() => {
                if (running && inFlight > 0 && performance.now() - lastActivity > 4000) {
                    inFlight = 0;
                    void pump();
                }
            }, 1000);
            connection ??= fal.realtime.connect<GanttDiffusionInput>('fal-ai/flux-2/klein/realtime', {
                connectionKey          : 'gantt-diffusion',
                throttleInterval       : 128,
                tokenProvider          : fetchRealtimeToken,
                // Matches the endpoint's token_expiration so the client
                // refreshes tokens before they lapse
                tokenExpirationSeconds : 120,
                onResult               : handleResult,
                onError                : error => onError(error.message ?? String(error))
            });
            void pump();
        },

        stop() {
            running = false;
            if (watchdog !== null) {
                clearInterval(watchdog);
                watchdog = null;
            }
        },

        // Called when the prompt changes so the new style goes out on the next
        // capture immediately instead of waiting for the next result
        nudge() {
            void pump();
        },

        destroy() {
            this.stop();
            connection?.close();
            connection = null;
        }
    };
}
