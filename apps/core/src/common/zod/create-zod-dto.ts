import type { z } from 'zod';

export interface ZodDto<TSchema extends z.ZodType = z.ZodType> {
  new (): z.output<TSchema>;
  schema: TSchema;
}

/**
 * Creates a DTO class backed by a Zod schema, so it can be used as a type in
 * controller signatures and validated by ZodValidationPipe.
 *
 * @example
 * export class CreateUserDto extends createZodDto(z.object({ name: z.string() })) {}
 */
export function createZodDto<TSchema extends z.ZodType>(schema: TSchema): ZodDto<TSchema> {
  class Dto {
    static schema = schema;
  }
  return Dto as unknown as ZodDto<TSchema>;
}

export function isZodDto(metatype: unknown): metatype is ZodDto {
  return typeof metatype === 'function' && 'schema' in metatype;
}
