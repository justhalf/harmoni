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

        let nextStartTime = 0;

        ws.onmessage = (event) => {
            const ctx = audioCtxRef.current;
            const analyser = analyserRef.current;
            if (!ctx || !analyser) return;

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
            source.connect(analyser);

            // Connect to a silent gain node so it processes correctly without recursive feedback or deafening feedback loops
            const silentNode = ctx.createGain();
            silentNode.gain.value = 0;
            analyser.connect(silentNode);
            silentNode.connect(ctx.destination);

            // Schedule gapless playback
            if (nextStartTime < ctx.currentTime) {
                nextStartTime = ctx.currentTime;
            }
            source.start(nextStartTime);
            nextStartTime += audioBuffer.duration;
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
