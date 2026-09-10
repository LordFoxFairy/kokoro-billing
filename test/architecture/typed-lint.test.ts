import { assertDefined } from '../assert-defined.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });
const safeFixture = `
export const input: unknown = JSON.parse('{"name":"fixture"}');
export function readName(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('name' in value)
      || typeof value.name !== 'string') throw new Error('invalid name');
  return value.name;
}
export function classify(value: 'queued' | 'done'): number {
  switch (value) {
    case 'queued': return 0;
    case 'done': return 1;
    default: throw new Error('invalid state');
  }
}
export function legacy(value: string): number {
  switch (value) { case 'known': return 1; }
  return 0;
}
export async function consume(): Promise<string> {
  return await Promise.resolve(readName(input));
}
`;
const regressions = [
  ['no-unsafe-assignment', `export const value = JSON.parse('{}');`],
  ['no-unsafe-member-access', `export const value: unknown = JSON.parse('{}').name;`],
  ['no-unsafe-call', `export const value: unknown = JSON.parse('{}')();`],
  ['no-unsafe-return', `export function value(): string { return JSON.parse('{}'); }`],
  ['no-unsafe-argument', `export const value = Math.abs(JSON.parse('1'));`],
  ['no-floating-promises', `Promise.resolve(1);`],
  ['no-misused-promises', `if (Promise.resolve(true)) { throw new Error('bad'); }`],
  ['await-thenable', `export async function value(): Promise<number> { return await 1; }`],
  ['require-await', `export async function value(): Promise<number> { return 1; }`],
  ['no-non-null-assertion', `export function value(input?: string): string { return input!; }`],
  ['switch-exhaustiveness-check', `export function value(input: 'a' | 'b'): number {
    switch (input) { case 'a': return 1; default: return 0; }
  }`],
] as const;

describe('typed lint governance', () => {
  it.each(['src/main.ts', 'scripts/prisma-process.ts', 'test/architecture/typed-lint.test.ts'])(
    'runs the real configuration on positive and negative fixtures in %s',
    async (path) => {
      const filePath = resolve(path);
      const valid = await eslint.lintText(safeFixture, { filePath });
      expect(valid.flatMap((result) => result.messages)).toEqual([]);
      for (const [rule, source] of regressions) {
        const results = await eslint.lintText(source, { filePath });
        const messages = results.flatMap((result) => result.messages);
        expect(messages.some((message) => message.fatal), rule).toBe(false);
        expect(messages.map((message) => message.ruleId), rule).toContain(`@typescript-eslint/${rule}`);
      }
    },
  );

  it('explicitly checks import casing and side-effect imports', async () => {
    const config: unknown = JSON.parse(await readFile('tsconfig.json', 'utf8'));
    expect(config).toMatchObject({ compilerOptions: {
      forceConsistentCasingInFileNames: true,
      noUncheckedSideEffectImports: true,
    } });
  });
});


describe('required fixture values', () => {
  it('rejects only absent values and preserves object identity', () => {
    expect(() => assertDefined(undefined)).toThrow('Required test fixture value is missing');
    expect(() => assertDefined(null)).toThrow('Required test fixture value is missing');
    const object = {};
    for (const value of [false, 0, '', object]) expect(assertDefined(value)).toBe(value);
  });
});
