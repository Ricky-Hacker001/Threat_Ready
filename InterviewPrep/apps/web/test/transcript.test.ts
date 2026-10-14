import { describe, expect, it } from 'vitest';
import { appendPhrase, cleanTranscript } from '../src/features/interview-prep/lib/transcript';

describe('speech transcript clean-up', () => {
  it('fixes spelled-out acronyms and misheard security terms', () => {
    expect(cleanTranscript('i would check the s i e m and the e d r console')).toBe('i would check the SIEM and the EDR console');
    expect(cleanTranscript('map the ttps to mitre attack and look for c two beacons')).toBe('map the TTPs to MITRE ATT&CK and look for C2 beacons');
    expect(cleanTranscript('we pushed the sim alerts into splunk')).toBe('we pushed the SIEM alerts into Splunk');
    expect(cleanTranscript('a fishing email with a link')).toBe('a phishing email with a link');
  });
  it('leaves ordinary words alone', () => {
    expect(cleanTranscript('it would seem like the sim card was swapped')).toBe('it would seem like the sim card was swapped');
    expect(cleanTranscript('I am going fishing')).toBe('I am going fishing');
  });
  it('joins phrases into tidy sentences', () => {
    expect(appendPhrase('', 'first i would isolate the host')).toBe('First i would isolate the host');
    expect(appendPhrase('I would isolate it.', 'then collect memory')).toBe('I would isolate it. Then collect memory');
    expect(appendPhrase('I would isolate it', 'and collect memory')).toBe('I would isolate it and collect memory');
  });
});
