import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

import { createZodDto } from './create-zod-dto.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

class CreateUserDto extends createZodDto(
  z.object({
    name: z.string().min(1),
    age: z.coerce.number().int(),
  }),
) {}

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe();

  it('returns parsed data for a valid zod DTO', () => {
    const result = pipe.transform(
      { name: 'Alice', age: '30' },
      { type: 'body', metatype: CreateUserDto },
    );

    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('throws BadRequestException with issue details for invalid input', () => {
    try {
      pipe.transform({ name: '', age: 'abc' }, { type: 'body', metatype: CreateUserDto });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        errors: { path: string }[];
      };
      expect(response.errors.map((e) => e.path)).toEqual(['name', 'age']);
    }
  });

  it('passes through values whose metatype is not a zod DTO', () => {
    expect(pipe.transform('42', { type: 'param', metatype: String })).toBe('42');
  });
});
