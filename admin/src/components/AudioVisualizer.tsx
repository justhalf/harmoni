import React, { useEffect, useRef, useState } from 'react';

interface VisualizerProps {
    wsEndpoint: string;
}

export default function AudioVisualizer({ wsEndpoint }: VisualizerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const [isRendering, setIsRendering] = useState(false);

    useEffect(() => {
        // Scaffold Web Audio API context for raw PCM data stream from Queue B
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        const analyser = audioCtx.createAnalyser();

        analyser.fftSize = 256;
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;

        const ws = new WebSocket(wsEndpoint);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
            console.log("Admin Queue B Connected");
            setIsRendering(true);
        };

        ws.onmessage = (event) => {
            // In production, Queue B pipes Int16 raw PCM arrays over the socket.
            // We read the Int16Array, map to Float32, and write to a buffer to feed the AudioContext/Analyser.
            // For this scaffold, we trigger the visual render loop when data flows.

            const pcmData = new Int16Array(event.data);
            // Dummy processing to populate frequency data:
            // We would normally pipe this into an AudioBufferSourceNode connected to the analyser.
        };

        ws.onclose = () => setIsRendering(false);

        return () => {
            ws.close();
            audioCtx.close();
        };
    }, [wsEndpoint]);

    useEffect(() => {
        if (!isRendering || !canvasRef.current || !analyserRef.current) return;

        const canvas = canvasRef.current;
        const canvasCtx = canvas.getContext('2d');
        if (!canvasCtx) return;

        const analyser = analyserRef.current;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        let animationId: number;

        const draw = () => {
            animationId = requestAnimationFrame(draw);

            analyser.getByteFrequencyData(dataArray);

            canvasCtx.fillStyle = 'rgb(17, 24, 39)'; // Tailwind gray-900
            canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

            const barWidth = (canvas.width / bufferLength) * 2.5;
            let barHeight;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                barHeight = dataArray[i];

                // Gradient color trick
                canvasCtx.fillStyle = `rgb(${barHeight + 100}, 50, 250)`;
                canvasCtx.fillRect(x, canvas.height - barHeight / 2, barWidth, barHeight / 2);

                x += barWidth + 1;
            }
        };

        draw();

        return () => {
            cancelAnimationFrame(animationId);
        };
    }, [isRendering]);

    return (
        <div className="w-full bg-gray-900 rounded border border-gray-700 overflow-hidden flex flex-col">
            <div className="px-4 py-2 bg-gray-800 border-b border-gray-700 flex justify-between items-center text-xs text-gray-400">
                <span>Web Audio API (AnalyserNode)</span>
                <span>{isRendering ? 'Receiving PCM...' : 'Awaiting Data...'}</span>
            </div>
            <canvas
                ref={canvasRef}
                width="800"
                height="200"
                className="w-full h-48 object-cover opacity-80"
            ></canvas>
        </div>
    );
}
