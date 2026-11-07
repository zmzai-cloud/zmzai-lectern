import { expect, it } from 'vitest';
import { unexpectedWorkspacePaths } from './workspace-scope';

it('rejects extra writes even when required output and protected inputs are correct', () => {
  expect(unexpectedWorkspacePaths(['approvals.json', 'receipt.txt', 'extra.txt', 'nested', 'nested/file.txt'], ['approvals.json', 'receipt.txt']))
    .toEqual(['extra.txt', 'nested', 'nested/file.txt']);
});

it('ignores only framework revision metadata, preserving checks on hidden user files', () => {
  expect(unexpectedWorkspacePaths(['approvals.json', 'receipt.txt', '.fw-revisions.json', '.hidden'], ['approvals.json', 'receipt.txt']))
    .toEqual(['.hidden']);
});
