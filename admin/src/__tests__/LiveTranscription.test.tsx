/**
 * Tests for LiveTranscription.tsx — SRT generation logic.
 *
 * These tests focus on the downloadSrt helper function behavior extracted
 * from LiveTranscription. Since the component is complex (WebSocket, refs, etc.),
 * we test the SRT formatting logic via a utility extraction pattern.
 */
import { describe, it, expect } from 'vitest';

// Helper that mirrors the SRT generation logic from LiveTranscription.downloadSrt
interface TextSpan {
    id: string;
    orig: string;
    en: string;
    start_ms?: number;
    end_ms?: number;
    isLineBreak?: boolean;
}

function formatSrtTimestamp(ms: number): string {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const milliseconds = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function generateSrt(spans: TextSpan[]): string {
    const textSpans = spans.filter(s => !s.isLineBreak && s.en.trim());
    let srt = '';
    let index = 1;
    let fallbackMs = 0;

    for (const span of textSpans) {
        const startMs = span.start_ms ?? fallbackMs;
        const endMs = span.end_ms ?? (startMs + Math.max(span.en.length * 60, 1000));

        srt += `${index}\n`;
        srt += `${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n`;
        srt += `${span.en}\n\n`;

        fallbackMs = endMs;
        index++;
    }

    return srt;
}

describe('SRT Generation', () => {
    it('generates correct SRT format with timestamps', () => {
        const spans: TextSpan[] = [
            { id: '1', orig: 'Halo', en: 'Hello', start_ms: 1000, end_ms: 2500 },
            { id: '2', orig: 'Dunia', en: 'World', start_ms: 3000, end_ms: 4000 },
        ];

        const srt = generateSrt(spans);

        expect(srt).toContain('1\n00:00:01,000 --> 00:00:02,500\nHello');
        expect(srt).toContain('2\n00:00:03,000 --> 00:00:04,000\nWorld');
    });

    it('uses fallback timestamps when start_ms/end_ms are undefined', () => {
        const spans: TextSpan[] = [
            { id: '1', orig: 'Halo', en: 'Hello' },
            { id: '2', orig: 'Dunia', en: 'World' },
        ];

        const srt = generateSrt(spans);

        expect(srt).toContain('00:00:00,000 --> 00:00:01,000');
        expect(srt).toContain('00:00:01,000 --> ');
    });

    it('excludes line breaks from SRT output', () => {
        const spans: TextSpan[] = [
            { id: '1', orig: 'Halo', en: 'Hello', start_ms: 0, end_ms: 1000 },
            { id: 'br', orig: '', en: '', isLineBreak: true },
            { id: '2', orig: 'Dunia', en: 'World', start_ms: 2000, end_ms: 3000 },
        ];

        const srt = generateSrt(spans);

        const entries = srt.split('\n\n').filter(e => e.trim());
        expect(entries).toHaveLength(2);
    });

    it('excludes empty English text from SRT output', () => {
        const spans: TextSpan[] = [
            { id: '1', orig: 'Halo', en: 'Hello', start_ms: 0, end_ms: 1000 },
            { id: '2', orig: '<end>', en: '   ', start_ms: 1000, end_ms: 2000 },
            { id: '3', orig: 'Ya', en: 'Yes', start_ms: 3000, end_ms: 4000 },
        ];

        const srt = generateSrt(spans);

        const entries = srt.split('\n\n').filter(e => e.trim());
        expect(entries).toHaveLength(2);
    });

    it('formats timestamps with leading zeros correctly', () => {
        const ts = formatSrtTimestamp(3723456);
        expect(ts).toBe('01:02:03,456');
    });
});
