import { describe, expect, it } from 'vitest';

import { isLocalHttpEndpoint } from '../../../src/shared/chat/local-endpoint';
import { OLLAMA_DEFAULT_BASE_URL } from '../../../src/shared/constants';

describe('isLocalHttpEndpoint — accepted local forms', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://LOCALHOST:11434/v1',
    'http://ollama.localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://127.1.2.3:11434',
    'https://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
    'http://10.0.0.5:11434/v1',
    'http://172.16.0.1:11434/v1',
    'http://172.31.255.255:11434/v1',
    'http://192.168.1.50:11434/v1',
    'http://169.254.1.1:11434/v1',
    'http://[fd00::1]:11434/v1',
    'http://[fe80::1]:11434/v1',
  ])('accepts %s', (value) => {
    expect(isLocalHttpEndpoint(value)).toBe(true);
  });

  it('accepts the shipped Ollama default', () => {
    expect(isLocalHttpEndpoint(OLLAMA_DEFAULT_BASE_URL)).toBe(true);
  });
});

describe('isLocalHttpEndpoint — rejected public and malformed forms', () => {
  it.each([
    'https://api.openai-like.test/v1',
    'https://open.bigmodel.cn/api/paas/v4',
    'http://example.test:11434/v1',
    'https://ollama.somecloud.test',
    'http://8.8.8.8:11434',
    'http://172.32.0.1:11434',
    'http://172.15.255.255:11434',
    'http://192.169.1.1:11434',
    'http://11.0.0.1:11434',
    'http://[2001:4860:4860::8888]:11434',
  ])('rejects the public endpoint %s', (value) => {
    expect(isLocalHttpEndpoint(value)).toBe(false);
  });

  it.each([
    '',
    'not a url',
    '127.0.0.1:11434',
    'localhost:11434',
    'ftp://127.0.0.1/v1',
    'file:///etc/hosts',
    'javascript:alert(1)',
    'data:text/plain,hi',
  ])('rejects the malformed or non-http value %s', (value) => {
    expect(isLocalHttpEndpoint(value)).toBe(false);
  });

  it('rejects a local address carrying embedded credentials', () => {
    expect(isLocalHttpEndpoint('http://user:pass@127.0.0.1:11434/v1')).toBe(false);
    expect(isLocalHttpEndpoint('http://user@localhost:11434/v1')).toBe(false);
  });

  it('rejects a hostname that merely looks local', () => {
    // A name can only be resolved by asking a resolver, which is exactly the
    // thing a typo or an attacker controls — so names other than `localhost`
    // are refused rather than trusted.
    for (const value of [
      'http://localhost.evil.test:11434',
      'http://127.0.0.1.evil.test:11434',
      'http://not-localhost:11434',
      'http://mylocalhost:11434',
    ]) {
      expect(isLocalHttpEndpoint(value)).toBe(false);
    }
  });

  it('rejects an octet outside the valid range rather than treating it as local', () => {
    expect(isLocalHttpEndpoint('http://127.0.0.999:11434')).toBe(false);
  });

  it('never throws, whatever it is given', () => {
    for (const value of ['', '::::', 'http://', 'http://[', '%%%', 'http://127.0.0.1:notaport']) {
      expect(() => isLocalHttpEndpoint(value)).not.toThrow();
    }
  });
});
