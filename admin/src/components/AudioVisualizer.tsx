/**
 * AudioVisualizer.tsx — Real-time frequency spectrum display for admin audio monitoring.
 *
 * Receives raw PCM Int16 audio over WebSocket from Queue B (server audio_ingest),
 * normalizes to Float32 for the Web Audio API, and renders a live frequency graph
 * using AnalyserNode + Canvas.
 *
 * Stereo-aware: If numChannels=2, it splits interleaved data and displays two
 * separate spectral plots for Left and Right channels.
 */
import { useEffect, useRef, useState } from 'react';

interface VisualizerProps {
    wsEndpoint: string;
    adminSessionToken: string;
    numChannels: number;
}

export default function AudioVisualizer({ wsEndpoint, adminSessionToken, numChannels }: VisualizerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserLRef = useRef<AnalyserNode | null>(null);
    const analyserRRef = useRef<AnalyserNode | null>(null);
    const [isRendering, setIsRendering] = useState(false);
    const [hasConnectedOnce, setHasConnectedOnce] = useState(false);

    useEffect(() => {
        let ws: WebSocket;
        let audioCtx: AudioContext;
        let reconnectTimeout: ReturnType<typeof setTimeout>;

        const connect = () => {
            // Scaffold Web Audio API context for raw PCM data stream (forced to 16kHz to match ingest)
            audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            audioCtxRef.current = audioCtx;

            const analyserL = audioCtx.createAnalyser();
            analyserL.fftSize = 256;
            analyserLRef.current = analyserL;

            const silentNode = audioCtx.createGain();
            silentNode.gain.value = 0;
            silentNode.connect(audioCtx.destination);

            if (numChannels === 2) {
                const analyserR = audioCtx.createAnalyser();
                analyserR.fftSize = 256;
                analyserRRef.current = analyserR;

                const splitter = audioCtx.createChannelSplitter(2);
                splitter.connect(analyserL, 0);
                splitter.connect(analyserR, 1);

                analyserL.connect(silentNode);
                analyserR.connect(silentNode);
                // The source will connect to the splitter
            } else {
                analyserRRef.current = null;
                analyserL.connect(silentNode);
            }

            ws = new WebSocket(wsEndpoint);
            ws.binaryType = "arraybuffer";

            ws.onopen = () => {
                ws.send(JSON.stringify({ token: adminSessionToken, is_admin: true }));
                setIsRendering(true);
                setHasConnectedOnce(true);
            };

            let nextStartTime = 0;

            ws.onmessage = (event) => {
                const ctx = audioCtxRef.current;
                if (!ctx || !analyserLRef.current) return;

                const pcmData = new Int16Array(event.data);
                const totalSamples = pcmData.length;
                const samplesPerChannel = totalSamples / numChannels;

                const audioBuffer = ctx.createBuffer(numChannels, samplesPerChannel, ctx.sampleRate);

                if (numChannels === 2) {
                    const leftData = new Float32Array(samplesPerChannel);
                    const rightData = new Float32Array(samplesPerChannel);
                    for (let i = 0; i < samplesPerChannel; i++) {
                        leftData[i] = pcmData[i * 2] / 32768.0;
                        rightData[i] = pcmData[i * 2 + 1] / 32768.0;
                    }
                    audioBuffer.copyToChannel(leftData, 0);
                    audioBuffer.copyToChannel(rightData, 1);
                } else {
                    const monoData = new Float32Array(totalSamples);
                    for (let i = 0; i < totalSamples; i++) {
                        monoData[i] = pcmData[i] / 32768.0;
                    }
                    audioBuffer.copyToChannel(monoData, 0);
                }

                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;

                if (numChannels === 2) {
                    // Splitter was defined in connect(), but nodes are per-packet? 
                    // No, the constant topology is better. Let's find the splitter.
                    // Actually, we can just create a splitter per packet or use a persistent one.
                    const splitter = ctx.createChannelSplitter(2);
                    splitter.connect(analyserLRef.current, 0);
                    if (analyserRRef.current) splitter.connect(analyserRRef.current, 1);
                    source.connect(splitter);
                } else {
                    source.connect(analyserLRef.current);
                }

                if (nextStartTime < ctx.currentTime) {
                    nextStartTime = ctx.currentTime;
                } else if (nextStartTime > ctx.currentTime + 0.3) {
                    nextStartTime = ctx.currentTime + 0.05;
                }

                source.start(nextStartTime);
                nextStartTime += audioBuffer.duration;
            };

            ws.onclose = async (event) => {
                setIsRendering(false);

                // 1008 is our server's standard code for "invalid/expired session token"
                if (event.code === 1008) {
                    const refreshToken = localStorage.getItem('admin_refresh_token');
                    if (refreshToken) {
                        try {
                            const refreshRes = await fetch('/api/admin/refresh', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ refresh_token: refreshToken })
                            });

                            if (refreshRes.ok) {
                                // Wait a moment and try connecting again, this time the 
                                // parent component will eventually pass down the new token 
                                // via props, but we can also just rely on the prop updating 
                                // to trigger a re-render. To avoid a race condition before 
                                // React state updates:
                                reconnectTimeout = setTimeout(connect, 1000);
                                return;
                            }
                        } catch (e) {
                            console.error("AudioVisualizer WS auto-refresh failed", e);
                        }
                    }
                    // If no refresh token or refresh failed, stop retrying. The main AdminApp
                    // polling will eventually hit a 401 and kick the user out properly.
                    return;
                }

                reconnectTimeout = setTimeout(connect, 2000);
            };

            ws.onerror = () => ws.close();
        };

        connect();

        return () => {
            clearTimeout(reconnectTimeout);
            if (ws) {
                ws.onclose = null;
                ws.close();
            }
            if (audioCtx) audioCtx.close();
        };
    }, [wsEndpoint, adminSessionToken, numChannels]);

    useEffect(() => {
        if (!canvasRef.current) return;

        const canvas = canvasRef.current;
        const canvasCtx = canvas.getContext('2d');
        if (!canvasCtx) return;

        let animationId: number;

        const draw = () => {
            animationId = requestAnimationFrame(draw);

            if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
                canvas.width = canvas.clientWidth;
                canvas.height = canvas.clientHeight;
            }

            canvasCtx.fillStyle = 'rgb(17, 24, 39)';
            canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

            const xAxisY = canvas.height - 30;
            const plotHeight = xAxisY;

            if (isRendering && analyserLRef.current) {
                const drawChannel = (analyser: AnalyserNode, xOffset: number, width: number, labelPrefix: string) => {
                    const bufferLength = analyser.frequencyBinCount;
                    const dataArray = new Uint8Array(bufferLength);
                    analyser.getByteFrequencyData(dataArray);

                    canvasCtx.lineWidth = 2;
                    canvasCtx.strokeStyle = labelPrefix === 'L' ? 'rgb(110, 231, 183)' : 'rgb(96, 165, 250)'; // Emerald vs Blue
                    canvasCtx.beginPath();

                    const sliceWidth = width / bufferLength;
                    let x = xOffset;

                    for (let i = 0; i < bufferLength; i++) {
                        const v = dataArray[i] / 255.0;
                        const y = plotHeight - (v * plotHeight);
                        if (i === 0) canvasCtx.moveTo(x, y);
                        else canvasCtx.lineTo(x, y);
                        x += sliceWidth;
                    }
                    canvasCtx.stroke();

                    // Labels for this channel
                    canvasCtx.fillStyle = 'rgb(156, 163, 175)';
                    canvasCtx.font = '9px Roboto, sans-serif';
                    canvasCtx.textAlign = 'center';

                    const labelFreqs = [0, 8000];
                    labelFreqs.forEach(freq => {
                        const xPos = xOffset + (freq / 8000) * width;
                        canvasCtx.beginPath();
                        canvasCtx.moveTo(xPos, xAxisY);
                        canvasCtx.lineTo(xPos, xAxisY + 4);
                        canvasCtx.stroke();

                        let text = freq === 0 ? `0` : `8k`;
                        if (numChannels === 2) text = `${labelPrefix} ${text}`;

                        let finalX = xPos;
                        if (freq === 0) finalX += 8;
                        if (freq === 8000) finalX -= 10;

                        canvasCtx.fillText(text, finalX, xAxisY + 15);
                    });
                };

                if (numChannels === 2 && analyserRRef.current) {
                    drawChannel(analyserLRef.current, 0, canvas.width / 2, 'L');
                    drawChannel(analyserRRef.current, canvas.width / 2, canvas.width / 2, 'R');
                } else {
                    drawChannel(analyserLRef.current, 0, canvas.width, '');
                    // Intermediate ticks for mono only to match user's current 0-1-2-4-8 display
                    [1000, 2000, 4000].forEach(freq => {
                        const xPos = (freq / 8000) * canvas.width;
                        canvasCtx.fillText(`${freq / 1000}k`, xPos, xAxisY + 15);
                    });
                }
            }

            // Always Draw X-Axis
            canvasCtx.strokeStyle = 'rgb(75, 85, 99)';
            canvasCtx.beginPath();
            canvasCtx.moveTo(0, xAxisY);
            canvasCtx.lineTo(canvas.width, xAxisY);
            if (numChannels === 2) {
                // Vertical divider
                canvasCtx.moveTo(canvas.width / 2, 0);
                canvasCtx.lineTo(canvas.width / 2, xAxisY);
            }
            canvasCtx.stroke();
        };

        draw();

        return () => cancelAnimationFrame(animationId);
    }, [isRendering, numChannels]);

    return (
        <div className="w-full bg-slate-800/50 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden flex flex-col shadow-2xl">
            <div className="px-6 py-3 bg-slate-800/80 border-b border-slate-700/50 flex justify-between items-center text-xs font-medium text-slate-400 select-none">
                <span className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                    </svg>
                    {numChannels === 2 ? 'Stereo' : 'Mono'} Spectrum Analysis
                </span>
                <span>
                    {!hasConnectedOnce ? (
                        <span className="text-yellow-500/80 italic tracking-wider text-[10px] uppercase font-semibold animate-pulse">Connecting...</span>
                    ) : isRendering ? (
                        <div className="flex items-center gap-2">
                            <span className="relative flex h-2.5 w-2.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                            </span>
                            <span className="text-emerald-400 font-semibold tracking-wider uppercase text-[10px]">Active</span>
                        </div>
                    ) : (
                        <span className="text-slate-500 italic">Awaiting Data...</span>
                    )}
                </span>
            </div>
            <div className="relative w-full h-48 bg-slate-900/50">
                <canvas
                    ref={canvasRef}
                    className="w-full h-full opacity-90 mix-blend-screen"
                ></canvas>
            </div>
        </div>
    );
}
