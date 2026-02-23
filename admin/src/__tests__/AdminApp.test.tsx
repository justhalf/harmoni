/**
 * Tests for AdminApp.tsx — Login flow and authentication behavior.
 *
 * Key behaviors tested:
 * - Login form renders when unauthenticated
 * - Server-side validation: password is POSTed to /api/admin/login (Lesson #11)
 * - Invalid password shows error message
 * - Successful login clears raw password from state and transitions to dashboard
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdminApp from '../AdminApp';

// Mock child components to isolate AdminApp behavior
vi.mock('../components/LiveTranscription', () => ({
    default: () => <div data-testid="live-transcription">LiveTranscription Mock</div>,
}));
vi.mock('../components/AudioVisualizer', () => ({
    default: () => <div data-testid="audio-visualizer">AudioVisualizer Mock</div>,
}));

describe('AdminApp Login', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
        mockFetch.mockReset();
        global.fetch = mockFetch as any;
    });

    it('renders login form when unauthenticated', () => {
        render(<AdminApp />);
        expect(screen.getByPlaceholderText(/admin password/i)).toBeInTheDocument();
    });

    it('shows error on invalid password', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
        });

        render(<AdminApp />);
        const input = screen.getByPlaceholderText(/admin password/i);
        const form = input.closest('form')!;

        fireEvent.change(input, { target: { value: 'wrong-password' } });
        fireEvent.submit(form);

        await waitFor(() => {
            expect(screen.getByText(/invalid admin password/i)).toBeInTheDocument();
        });
    });

    it('does not call fetch with empty password', async () => {
        render(<AdminApp />);
        const input = screen.getByPlaceholderText(/admin password/i);
        const form = input.closest('form')!;

        fireEvent.change(input, { target: { value: '   ' } });
        fireEvent.submit(form);

        // fetch should not have been called for login
        expect(mockFetch).not.toHaveBeenCalledWith(
            '/api/admin/login',
            expect.anything()
        );
    });

    it('transitions to dashboard on successful login', async () => {
        // First call: login success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ admin_session_token: 'test-token-123' }),
        });
        // Subsequent calls: health + passphrase fetches after login
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                status: 'online',
                soniox_connected: false,
                soniox_active: false,
                active_clients: 0,
                active_admins: 0,
                audio_alive: false,
                active_token: 'blue-ocean-42',
            }),
        });

        render(<AdminApp />);
        const input = screen.getByPlaceholderText(/admin password/i);
        const form = input.closest('form')!;

        fireEvent.change(input, { target: { value: 'correct-password' } });
        fireEvent.submit(form);

        await waitFor(() => {
            // After successful login, the login form should be gone
            expect(screen.queryByPlaceholderText(/admin password/i)).not.toBeInTheDocument();
        });

        // Verify the password was sent to the server
        expect(mockFetch).toHaveBeenCalledWith('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'correct-password' }),
        });
    });

    it('shows "Server unreachable" on fetch failure', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        render(<AdminApp />);
        const input = screen.getByPlaceholderText(/admin password/i);
        const form = input.closest('form')!;

        fireEvent.change(input, { target: { value: 'any-password' } });
        fireEvent.submit(form);

        await waitFor(() => {
            expect(screen.getByText(/server unreachable/i)).toBeInTheDocument();
        });
    });
});
