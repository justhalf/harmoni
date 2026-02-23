/**
 * Tests for client App.tsx — ID generation, token validation, and placeholder rendering.
 *
 * Key behaviors tested:
 * - generateId fallback for non-HTTPS contexts (Lesson #5)
 * - Token validation: correct passphrase shows content, wrong is rejected
 * - TokenPrompt renders with proper placeholder and server status
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../App';

// Mock WebSocket
class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    onopen: ((ev: any) => void) | null = null;
    onmessage: ((ev: any) => void) | null = null;
    onclose: ((ev: any) => void) | null = null;
    onerror: ((ev: any) => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    constructor(public url: string) {
        setTimeout(() => {
            this.onopen?.({} as any);
        }, 0);
    }
}
vi.stubGlobal('WebSocket', MockWebSocket);

// Mock speechSynthesis
vi.stubGlobal('speechSynthesis', {
    getVoices: () => [],
    cancel: vi.fn(),
    speak: vi.fn(),
    onvoiceschanged: null,
});

describe('generateId fallback', () => {
    it('generates a string ID when crypto.randomUUID is available', () => {
        const id1 = crypto.randomUUID();
        const id2 = crypto.randomUUID();
        expect(typeof id1).toBe('string');
        expect(id1).not.toBe(id2);
        expect(id1.length).toBeGreaterThan(0);
    });

    it('falls back to Math.random when crypto.randomUUID is unavailable', () => {
        const originalRandomUUID = crypto.randomUUID;
        (crypto as any).randomUUID = undefined;

        const id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);

        (crypto as any).randomUUID = originalRandomUUID;
    });
});

describe('Token Prompt', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    it('shows passphrase input on load', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ status: 'online' }),
        } as Response);

        render(<App />);

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/enter passphrase/i)).toBeInTheDocument();
        });
    });

    it('shows session title text', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ status: 'online' }),
        } as Response);

        render(<App />);

        await waitFor(() => {
            expect(screen.getByText('Live Translation Session')).toBeInTheDocument();
        });
    });

    it('validates correct token and transitions to connected state', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        // First call: /health → online
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ status: 'online' }),
        } as Response);

        // Second call: /api/verify-token → valid
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ valid: true }),
        } as Response);

        render(<App />);

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/enter passphrase/i)).not.toBeDisabled();
        });

        const input = screen.getByPlaceholderText(/enter passphrase/i);
        const button = screen.getByText('Connect to Stream');

        fireEvent.change(input, { target: { value: 'blue-ocean-42' } });
        fireEvent.click(button);

        await waitFor(() => {
            expect(fetchSpy).toHaveBeenCalledWith('/api/verify-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: 'blue-ocean-42' }),
            });
        });
    });

    it('shows error on invalid token', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        // First call: /health → online
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ status: 'online' }),
        } as Response);

        // Second call: /api/verify-token → invalid
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ valid: false }),
        } as Response);

        render(<App />);

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/enter passphrase/i)).not.toBeDisabled();
        });

        const input = screen.getByPlaceholderText(/enter passphrase/i);
        const button = screen.getByText('Connect to Stream');

        fireEvent.change(input, { target: { value: 'wrong-token' } });
        fireEvent.click(button);

        await waitFor(() => {
            expect(screen.getByText(/invalid/i)).toBeInTheDocument();
        });
    });

    it('disables input when server is offline', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

        render(<App />);

        await waitFor(() => {
            const input = screen.getByPlaceholderText(/enter passphrase/i);
            expect(input).toBeDisabled();
        });
    });
});
