import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Pretend WebGL works so the stage takes the 3D path…
vi.mock('../src/features/interview-prep/avatar/webgl', () => ({ hasWebGL: () => true }));
// …and make the (lazily loaded) scene fail the way a broken/missing GLB does: useGLTF throws.
vi.mock('../src/features/interview-prep/avatar/InterviewerScene', () => ({
  default: function BrokenScene(): never {
    throw new Error('Could not load /models/interviewer.glb: 404 Not Found');
  },
}));

import InterviewerStage from '../src/features/interview-prep/avatar/InterviewerStage';

describe('InterviewerStage asset failure', () => {
  afterEach(() => vi.restoreAllMocks());

  it('switches to the 2D fallback and reports asset-error once', async () => {
    // React logs caught render errors; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFallback = vi.fn();

    render(<InterviewerStage status="asking" speaking onFallback={onFallback} />);

    expect(await screen.findByRole('img', { name: /alex, your interviewer/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Asking');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('asset-error');
  });
});
