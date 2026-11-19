import errorCodes from '../../../../contracts/error_codes.json' with { type: 'json' };
import { MUTATION_ERROR_CODES } from './mutation-error-codes.js';

describe('errorCode của phần tử sync', () => {
  it('là tập con của contracts/error_codes.json', () => {
    for (const code of MUTATION_ERROR_CODES)
      expect(errorCodes).toHaveProperty(code);
  });
});
