import { useCallback, useEffect, useRef, useState } from 'react';
import { DomHelper } from '@bryntum/gantt';
import type { Button, Toolbar } from '@bryntum/gantt';
import { BryntumButton, BryntumFilePicker, BryntumGantt, BryntumTextField, BryntumToolbar } from '@bryntum/gantt-react';
import { ganttProps } from './GanttConfig';
import { buildPrompt, createGanttDiffusion, describeImageStyle, HIC_SUPPORTED, STYLE_PRESETS, type StyleKey } from './fluxDiffusion';
import { debounce } from './utils/debounce';
import './App.css';

const defaultPrompt = buildPrompt(STYLE_PRESETS[0].style);

// Experimental HTML-in-Canvas API surface (Chrome flag: canvas-draw-element)
type PaintableCanvas = HTMLCanvasElement & {
    onpaint? : (() => void) | null;
    requestPaint?() : void;
};
type ElementDrawingContext = CanvasRenderingContext2D & {
    drawElementImage(element : Element, x : number, y : number) : { toString() : string };
};

const App = () => {
    const gantt = useRef<BryntumGantt>(null);
    const toolbarRef = useRef<BryntumToolbar>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const captureCanvasRef = useRef<HTMLCanvasElement>(null);
    const diffusionRef = useRef<ReturnType<typeof createGanttDiffusion> | null>(null);
    const runningRef = useRef(false);
    // Read by the capture loop so prompt changes apply without reconnecting
    const promptRef = useRef(defaultPrompt);

    const [overlay, setOverlay] = useState(true);
    const [activeKey, setActiveKey] = useState<StyleKey | 'custom'>(STYLE_PRESETS[0].key);
    const [customPrompt, setCustomPrompt] = useState('');
    const [frameUrl, setFrameUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [styleThumbnail, setStyleThumbnail] = useState<string | null>(null);
    const [describing, setDescribing] = useState(false);

    useEffect(() => () => diffusionRef.current?.destroy(), []);

    // HTML-in-Canvas: the Gantt lives inside <canvas layoutsubtree>. The
    // browser fires the canvas's paint event whenever a child's rendering
    // changes; drawElementImage paints the live element and returns a CSS
    // transform that keeps the element's DOM position aligned with where it
    // was drawn (so clicks and drags keep working).
    useEffect(() => {
        const canvas = captureCanvasRef.current as PaintableCanvas | null;
        if (!HIC_SUPPORTED || !canvas) {
            return;
        }
        canvas.onpaint = () => {
            const ganttEl = stageRef.current;
            const ctx = canvas.getContext('2d') as ElementDrawingContext | null;
            if (!ganttEl || !ctx) {
                return;
            }
            ctx.reset();
            // drawElementImage is pixel-ratio aware: with the canvas bitmap
            // sized in device pixels (ResizeObserver below) and an identity
            // context transform, the element paints crisply at exactly its
            // own on-screen position — no ctx.scale needed.
            ctx.drawElementImage(ganttEl, 0, 0);
            // Deliberately NOT applying the returned transform. It exists to
            // relocate the live element when it is drawn somewhere OTHER
            // than its natural layout position — and in the current Canary
            // build it is expressed in page coordinates (it embeds the
            // canvas's page offset), so applying it verbatim displaces the
            // interactive Gantt away from the painted pixels, breaking
            // clicks (tab focus, which is not spatial, keeps working). We
            // draw in place, so the element is already aligned.
            ganttEl.style.transform = '';
        };
        // Match the canvas pixel grid to the device scale so the paint is
        // crisp, then request the first paint
        const observer = new ResizeObserver(([entry]) => {
            const box = entry.devicePixelContentBoxSize?.[0];
            if (!box) {
                return;
            }
            canvas.width = box.inlineSize;
            canvas.height = box.blockSize;
            canvas.requestPaint?.();
        });
        observer.observe(canvas, { box : 'device-pixel-content-box' });
        return () => {
            observer.disconnect();
            canvas.onpaint = null;
        };
    }, []);

    const toggleRunning = useCallback(() => {
        diffusionRef.current ??= createGanttDiffusion({
            captureSource : () => captureCanvasRef.current,
            getPrompt     : () => promptRef.current,
            onFrame       : url => {
                setFrameUrl(url);
                setError(null);
            },
            onError : message => setError(message)
        });
        const next = !runningRef.current;
        runningRef.current = next;
        // The Start button lives inside the Bryntum toolbar, so its state is
        // pushed to the widget instance via the toolbar widgetMap
        const toolbar = toolbarRef.current?.instance as Toolbar | undefined;
        const startButton = toolbar?.widgetMap.startButton as (Button & { color : string }) | undefined;
        const overlayButton = toolbar?.widgetMap.overlayButton as Button | undefined;
        if (startButton) {
            startButton.text = next ? 'Stop AI' : 'Start AI';
            startButton.color = next ? 'b-red' : 'b-purple';
        }
        if (overlayButton) {
            overlayButton.hidden = !next;
        }
        if (next) {
            setError(null);
            setOverlay(true);
            if (overlayButton) {
                overlayButton.pressed = true;
                overlayButton.text = 'Hide overlay';
            }
            diffusionRef.current.start();
        }
        else {
            diffusionRef.current.stop();
            setOverlay(false);
            if (overlayButton) {
                overlayButton.pressed = false;
                overlayButton.text = 'Show overlay';
            }
        }
    }, []);

    // Toolbar items are Bryntum widget configs (the Toolbar wrapper takes an
    // items config, not JSX children). Handlers only touch stable refs and
    // state setters, so the config is created once.
    const [toolbarItems] = useState(() => [
        {
            type : 'widget',
            cls  : 'toolbar-title'
        },
        // Spacer pushing the controls to the end (typed equivalent of '->')
        {
            type : 'widget',
            flex : 1
        },
        {
            type      : 'button',
            ref       : 'startButton',
            text      : 'Start AI',
            rendition : 'filled',
            color     : 'b-purple',
            onClick   : toggleRunning
        },
        {
            type       : 'button',
            ref        : 'overlayButton',
            text       : 'Hide overlay',
            hidden     : true,
            rendition  : 'outlined',
            toggleable : true,
            pressed    : true,
            onToggle({ pressed } : { pressed : boolean }) {
                setOverlay(pressed);
                const toolbar = toolbarRef.current?.instance as Toolbar | undefined;
                const overlayButton = toolbar?.widgetMap.overlayButton as Button | undefined;
                if (overlayButton) {
                    overlayButton.text = pressed ? 'Hide overlay' : 'Show overlay';
                }
            }
        },
        {
            type        : 'button',
            ref         : 'themeButton',
            icon        : 'fa fa-moon',
            rendition   : 'outlined',
            toggleable  : true,
            tooltip     : 'Toggle dark theme',
            pressedIcon : 'fa fa-sun',
            onToggle({ pressed } : { pressed : boolean }) {
                // Swaps the data-bryntum-theme <link> in index.html
                DomHelper.setTheme(pressed ? 'svalbard-dark' : 'svalbard-light');
                // Flips the app's own CSS variables (see index.css :root.dark)
                document.documentElement.classList.toggle('dark', pressed);
            }
        }
    ]);

    const selectStyle = (key : StyleKey) => {
        promptRef.current = buildPrompt(STYLE_PRESETS.find(s => s.key === key)!.style);
        setActiveKey(key);
        diffusionRef.current?.nudge();
    };

    const applyCustomPrompt = (value : string) => {
        setCustomPrompt(value);
        if (value.trim()) {
            promptRef.current = value;
            setActiveKey('custom');
            diffusionRef.current?.nudge();
        }
        else {
            selectStyle(STYLE_PRESETS[0].key);
        }
    };

    // Keep one debounced function across renders so all keystrokes share the
    // same timer. The input value itself is updated immediately below, while
    // the model prompt and nudge wait until typing has paused for 300ms.
    const [debouncedApplyCustomPrompt] = useState(() => debounce(applyCustomPrompt, 300));

    const applyStyleImage = async (file : File) => {
        setDescribing(true);
        setError(null);
        try {
            const { thumbnail, style } = await describeImageStyle(file);
            setStyleThumbnail(thumbnail);
            applyCustomPrompt(buildPrompt(style));
        }
        catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setDescribing(false);
        }
    };

    return (
        <div className="app">
            <BryntumToolbar ref={toolbarRef} cls="app-toolbar" items={toolbarItems} />
            {error && <div className="banner error">{error}</div>}
            <section className="source">
                <div className="stage">
                    {HIC_SUPPORTED ? (
                        <canvas
                            ref={captureCanvasRef}
                            className="capture-canvas"
                            {...{ layoutsubtree : 'true' }}
                        >
                            <div className="gantt-wrap" ref={stageRef}>
                                <BryntumGantt ref={gantt} {...ganttProps} />
                            </div>
                        </canvas>
                    ) : (
                        <div className="unsupported">
                            This demo uses the experimental HTML-in-Canvas API to capture the
                            Gantt. Open it in Chrome Canary with
                            <code>chrome://flags/#canvas-draw-element</code> enabled.
                        </div>
                    )}
                    {overlay && frameUrl && (
                        <img
                            className="ai-overlay"
                            src={frameUrl}
                            alt="AI-rendered Gantt chart"
                        />
                    )}
                </div>
            </section>
            <section className="prompt-board">
                <h2 className="section-title">Prompt</h2>
                <div className="prompt-grid">
                    {STYLE_PRESETS.map(style => (
                        <BryntumButton
                            key={style.key}
                            text={style.label}
                            rendition="outlined"
                            toggleGroup="style-presets"
                            pressed={style.key === activeKey}
                            onToggle={({ pressed }) => {
                                if (pressed) {
                                    selectStyle(style.key);
                                }
                            }}
                        />
                    ))}
                </div>
                <div className="custom-prompt-row">
                    <BryntumTextField
                        cls="custom-prompt"
                        placeholder="Custom prompt, e.g. Convert this Bryntum Gantt chart into a mosaic of stained glass"
                        value={customPrompt}
                        onInput={({ value }) => {
                            const nextPrompt = String(value ?? '');
                            setCustomPrompt(nextPrompt);
                            debouncedApplyCustomPrompt(nextPrompt);
                        }}
                    />
                    <BryntumFilePicker
                        buttonConfig={{
                            text : describing ? 'Describing…' : 'Style from image',
                            icon : 'fa fa-image'
                        }}
                        fileFieldConfig={{ accept : 'image/*' }}
                        disabled={describing}
                        onChange={({ files }) => {
                            const file = files?.item(0);
                            if (file) {
                                void applyStyleImage(file);
                            }
                        }}
                    />
                    {styleThumbnail && (
                        <img className="style-thumbnail" src={styleThumbnail} alt="Style reference preview" />
                    )}
                </div>
            </section>
        </div>
    );
};

export default App;
