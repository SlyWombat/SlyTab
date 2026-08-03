import { describe, expect, it } from 'vitest';

import { hostOf, isLocalHost, normaliseBase } from './backend-url';

describe('normaliseBase', () => {
  it('assumes https when no scheme is typed', () => {
    expect(normaliseBase('example.org')).toBe('https://example.org/api/v1');
  });

  it('accepts the address of the web app and finds the API under it', () => {
    expect(normaliseBase('https://example.org/slytab')).toBe('https://example.org/slytab/api/v1');
  });

  it('leaves an address that already names the API alone', () => {
    expect(normaliseBase('https://example.org/slytab/api/v1'))
      .toBe('https://example.org/slytab/api/v1');
  });

  it('ignores trailing slashes and surrounding space', () => {
    expect(normaliseBase('  https://example.org/slytab///  '))
      .toBe('https://example.org/slytab/api/v1');
  });

  it('keeps a non-default port', () => {
    expect(normaliseBase('https://example.org:8443/slytab'))
      .toBe('https://example.org:8443/slytab/api/v1');
  });

  // The point of the whole check: a bearer token that IS the account must not
  // travel in the clear across the internet.
  it('refuses plain http to a public host', () => {
    expect(() => normaliseBase('http://example.org/slytab')).toThrow(/https/);
  });

  it('allows plain http on the local network, where the wire is your own', () => {
    expect(normaliseBase('http://192.168.1.20:8080')).toBe('http://192.168.1.20:8080/api/v1');
    expect(normaliseBase('http://nas.local/slytab')).toBe('http://nas.local/slytab/api/v1');
    expect(normaliseBase('http://localhost:8100')).toBe('http://localhost:8100/api/v1');
  });

  it('rejects what is not an address at all', () => {
    expect(() => normaliseBase('')).toThrow();
    expect(() => normaliseBase('   ')).toThrow();
    expect(() => normaliseBase('https://')).toThrow(/web address/);
  });
});

describe('isLocalHost', () => {
  it('knows the private ranges apart from public addresses that resemble them', () => {
    expect(isLocalHost('172.16.0.4')).toBe(true);
    expect(isLocalHost('172.31.255.1')).toBe(true);
    // 172.32 is public, and a range check written as a prefix match gets this wrong.
    expect(isLocalHost('172.32.0.1')).toBe(false);
    expect(isLocalHost('172.15.0.1')).toBe(false);
    expect(isLocalHost('example.org')).toBe(false);
  });
});

describe('hostOf', () => {
  it('names the host a person is being asked to trust', () => {
    expect(hostOf('https://example.org/slytab/api/v1')).toBe('example.org');
    expect(hostOf('https://example.org:8443/x')).toBe('example.org:8443');
  });

  it('gives back what it was handed rather than throwing on nonsense', () => {
    expect(hostOf('not a url')).toBe('not a url');
  });
});
