import { validateEnv } from './env.schema.js';

describe('validateEnv', () => {
  it('applies defaults and coerces types', () => {
    expect(validateEnv({ PORT: '8080' })).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
    });
  });

  it('throws a readable error for invalid values', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(
      /Invalid environment variables[\s\S]*NODE_ENV/,
    );
  });
});
