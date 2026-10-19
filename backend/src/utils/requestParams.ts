import type { Request } from 'express';

/**
 * Express 5 types a path parameter as `string | string[]` (a repeated segment is technically
 * possible) and a query value as `string | string[] | ParsedQs | ParsedQs[]`. Every route in
 * this app declares a single-segment parameter and reads flat query strings, so these two
 * helpers do the narrowing once instead of casting at each of the twenty call sites.
 *
 * `pathParam` returns '' when the parameter is absent rather than throwing: the route would
 * not have matched without it, and an empty Prisma id is a clean "not found".
 */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** The first value of a flat query parameter, or undefined when it is absent or nested. */
export function queryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}
