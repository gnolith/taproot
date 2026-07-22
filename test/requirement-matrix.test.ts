import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expected =
  'A02,A03,A04,A05,A07,A08,A09,A10,A11,A12,A13,A14,B01,B02,B03,B04,B05,B06,B07,B08,B09,B10,B11,B12,B13,C01,C02,C03,C04,C05,C06,C10,C11,C12,C13,C14,C15,C16,D01,D03,D04,E01,E02,E03,E04,E05,E06,E07,E08,E09,E10,E11,E12,F01,F02,F03,F04,F05,F06,F07,F08,F09,F10,F11,G01,G02,G03,G04,G05,G06,G08,H01,H02,H03,H04,H09,I01,I02,I03,I04,I06,I07,I09,I10,I11,I12,I13,I14,I15'.split(
    ',',
  );

describe('Taproot acceptance ledger', () => {
  it('maps every owned contract ID exactly once to repository-owned blocking automation', () => {
    const matrix = JSON.parse(
      readFileSync(
        join(root, 'docs/taproot-requirement-test-matrix.json'),
        'utf8',
      ),
    ) as {
      version: number;
      requirements: Array<{ id: string; evidence: string[] }>;
    };
    expect(matrix.version).toBe(1);
    expect(matrix.requirements.map(({ id }) => id)).toEqual(expected);
    expect(new Set(matrix.requirements.map(({ id }) => id)).size).toBe(89);
    for (const requirement of matrix.requirements) {
      expect(requirement.evidence.length, requirement.id).toBeGreaterThan(0);
      for (const evidence of requirement.evidence)
        expect(
          existsSync(join(root, evidence)),
          `${requirement.id}: ${evidence}`,
        ).toBe(true);
    }
  });
});
