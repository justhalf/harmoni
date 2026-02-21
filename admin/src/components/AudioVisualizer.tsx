import { useEffect, useRef, useState } from 'react';

interface VisualizerProps {
    wsEndpoint: string;
    adminPassword: string;
}

export default function AudioVisualizer({ wsEndpoint, adminPassword }: VisualizerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const [isRendering, setIsRendering] = useState(false);

    useEffect(() => {
        let ws: WebSocket;
        let audioCtx: AudioContext;
        let reconnectTimeout: ReturnType<typeof setTimeout>;

        const connect = () => {
            // Scaffold Web Audio API context for raw PCM data stream from Queue B
            audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            const analyser = audioCtx.createAnalyser();

            analyser.fftSize = 256;
            audioCtxRef.current = audioCtx;
            analyserRef.current = analyser;

            // Connect to a silent gain node so it processes correctly without recursive feedback or deafening feedback loops.
            // This MUST be done once per session, not per packet.
            const silentNode = audioCtx.createGain();
            silentNode.gain.value = 0;
            analyser.connect(silentNode);
            silentNode.connect(audioCtx.destination);

            ws = new WebSocket(wsEndpoint);
            ws.binaryType = "arraybuffer";

            ws.onopen = () => {
                ws.send(JSON.stringify({ authorization: adminPassword }));
                console.log("Admin Queue B Connected");
                setIsRendering(true);
            };

            let nextStartTime = 0;

            ws.onmessage = (event) => {
                const ctx = audioCtxRef.current;
                const activeAnalyser = analyserRef.current;
                if (!ctx || !activeAnalyser) return;

                // In production, Queue B pipes Int16 raw PCM arrays over the socket.
                const pcmData = new Int16Array(event.data);
                const floatData = new Float32Array(pcmData.length);

                // Normalize Int16 to Float32 (-1.0 to 1.0) for Web Audio API
                for (let i = 0; i < pcmData.length; i++) {
                    floatData[i] = pcmData[i] / 32768.0;
                }

                // Create an AudioBuffer and copy the normalized samples
                const audioBuffer = ctx.createBuffer(1, floatData.length, ctx.sampleRate);
                audioBuffer.copyToChannel(floatData, 0);

                // Play the buffer securely through the analyser node
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(activeAnalyser);

                // Schedule gapless playback, but drop frames if we fall behind too much
                // This guarantees zero-latency live sync over time instead of building an infinite lag queue 
                if (nextStartTime < ctx.currentTime) {
                    nextStartTime = ctx.currentTime;
                } else if (nextStartTime > ctx.currentTime + 0.3) {
                    // We are rendering extremely far in the future due to a packet wave or lag drop.
                    // Snap the pointer back to reality to clear the backlog instantly.
                    nextStartTime = ctx.currentTime + 0.05;
                }

                source.start(nextStartTime);
                nextStartTime += audioBuffer.duration;
            };

            ws.onclose = () => {
                setIsRendering(false);
                // Auto-reconnect every 2 seconds if the server drops or is offline
                reconnectTimeout = setTimeout(connect, 2000);
            };

            ws.onerror = () => {
                // Silently drop connection errors (expected when server is down)
                ws.close(); // Force the close handler to trigger reconnect
            };
        };

        connect();

        return () => {
            clearTimeout(reconnectTimeout);
            if (ws) {
                // Prevent onclose reconnect triggers when React intentionally unmounts it
                ws.onclose = null;
                ws.close();
            }
            if (audioCtx) audioCtx.close();
        };
    }, [wsEndpoint]);

    useEffect(() => {
        if (!canvasRef.current) return;

        const canvas = canvasRef.current;
        const canvasCtx = canvas.getContext('2d');
        if (!canvasCtx) return;

        let animationId: number;

        const draw = () => {
            animationId = requestAnimationFrame(draw);

            // Sync internal canvas resolution to CSS element size to prevent squishing
            if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
                canvas.width = canvas.clientWidth;
                canvas.height = canvas.clientHeight;
            }

            // Always draw background
            canvasCtx.fillStyle = 'rgb(17, 24, 39)'; // Tailwind gray-900 (background)
            canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

            // Only draw the frequency data overlay if actively connected
            if (isRendering && analyserRef.current) {
                const analyser = analyserRef.current;
                const bufferLength = analyser.frequencyBinCount;
                const dataArray = new Uint8Array(bufferLength);

                analyser.getByteFrequencyData(dataArray);

                // Draw Frequency Line Graph
                canvasCtx.lineWidth = 2;
                canvasCtx.strokeStyle = 'rgb(110, 231, 183)'; // Tailwind emerald-300
                canvasCtx.beginPath();

                const sliceWidth = canvas.width / bufferLength;
                let x = 0;

                for (let i = 0; i < bufferLength; i++) {
                    const v = dataArray[i] / 255.0;
                    // Leave bottom 30px for labels
                    const plotHeight = canvas.height - 30;
                    const y = plotHeight - (v * plotHeight);

                    if (i === 0) {
                        canvasCtx.moveTo(x, y);
                    } else {
                        canvasCtx.lineTo(x, y);
                    }

                    x += sliceWidth;
                }

                canvasCtx.stroke();
            }

            // Always Draw X-Axis and Labels
            canvasCtx.strokeStyle = 'rgb(75, 85, 99)'; // Tailwind gray-600
            canvasCtx.fillStyle = 'rgb(156, 163, 175)'; // Tailwind gray-400
            canvasCtx.font = '10px Roboto, sans-serif';
            canvasCtx.textAlign = 'center';
            canvasCtx.beginPath();

            const xAxisY = canvas.height - 30;
            canvasCtx.moveTo(0, xAxisY);
            canvasCtx.lineTo(canvas.width, xAxisY);
            canvasCtx.stroke();

            // Web Audio API sampleRate is 16000, Nyquist is 8000
            const nyquist = 8000;
            // Draw labels for 0, 1k, 2k, 4k, 8k
            const labelFreqs = [0, 1000, 2000, 4000, 8000];

            labelFreqs.forEach(freq => {
                const xPos = (freq / nyquist) * canvas.width;

                canvasCtx.beginPath();
                canvasCtx.moveTo(xPos, xAxisY);
                canvasCtx.lineTo(xPos, xAxisY + 5);
                canvasCtx.stroke();

                const labelText = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
                let finalX = xPos;
                if (freq === 8000) finalX = xPos - 10;
                if (freq === 0) finalX = xPos + 4;
                canvasCtx.fillText(labelText, finalX, xAxisY + 20);
            });
        };

        draw();

        return () => {
            cancelAnimationFrame(animationId);
        };
    }, [isRendering]);

    return (
        <div className="w-full bg-slate-800/50 backdrop-blur-md rounded-xl border border-slate-700/50 overflow-hidden flex flex-col shadow-2xl">
            <div className="px-6 py-3 bg-slate-800/80 border-b border-slate-700/50 flex justify-between items-center text-xs font-medium text-slate-400 select-none">
                <span className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                    </svg>
                    Web Audio API (AnalyserNode)
                </span>
                <span>
                    {isRendering ? (
                        <div className="flex items-center gap-2">
                            <span className="relative flex h-2.5 w-2.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                            </span>
                            <span className="text-emerald-400 font-semibold tracking-wider">LIVE</span>
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
