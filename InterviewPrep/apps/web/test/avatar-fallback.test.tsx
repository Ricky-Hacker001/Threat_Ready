import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import InterviewerStage from '../src/features/interview-prep/avatar/InterviewerStage';
import { hasWebGL } from '../src/features/interview-prep/avatar/webgl';
import { clipForStatus } from '../src/features/interview-prep/avatar/clipMapping';

describe('InterviewerStage without WebGL', () => {
  it('reports no WebGL in jsdom', () => {
    expect(hasWebGL()).toBe(false);
  });

  it('renders the accessible 2D fallback and reports no-webgl once', () => {
    const onFallback = vi.fn();
    const { rerender } = render(<InterviewerStage status="preparing" speaking={false} onFallback={onFallback} />);

    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('Preparing');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText(/works fully in text mode/i)).toBeInTheDocument();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('no-webgl');

    rerender(<InterviewerStage status="asking" speaking onFallback={onFallback} />);
    expect(screen.getByRole('status')).toHaveTextContent('Asking');

    rerender(<InterviewerStage status="listening" speaking={false} candidateTyping onFallback={onFallback} />);
    expect(screen.getByRole('status')).toHaveTextContent('Listening');

    rerender(<InterviewerStage status="evaluating" speaking={false} onFallback={onFallback} />);
    expect(screen.getByRole('status')).toHaveTextContent('Evaluating');

    rerender(<InterviewerStage status="paused" speaking={false} onFallback={onFallback} />);
    expect(screen.getByRole('status')).toHaveTextContent('Paused');

    rerender(<InterviewerStage status="finished" speaking={false} onFallback={onFallback} />);
    expect(screen.getByRole('status')).toHaveTextContent('Finished');

    // still only reported once
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});

describe('clipForStatus', () => {
  it('maps interview status to clips', () => {
    expect(clipForStatus('asking')).toBe('Talk');
    expect(clipForStatus('evaluating')).toBe('Think');
    expect(clipForStatus('preparing')).toBe('Listen');
    expect(clipForStatus('listening')).toBe('Listen');
    expect(clipForStatus('listening', { quietFor: 30 })).toBe('Idle');
    expect(clipForStatus('paused')).toBe('Idle');
    expect(clipForStatus('finished')).toBe('Idle');
    expect(clipForStatus('asking', { reducedMotion: true })).toBe('Idle');
  });
});
