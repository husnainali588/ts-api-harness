import { describe, expect, it } from 'vitest';
import { routes } from '../../src/routes/index.js';

describe('route index', () => {
  it('lists every route module as defineRoute objects', () => {
    for (const route of routes) {
      expect(route.path).toMatch(/^\/v\d+\//);
      expect(['get', 'post', 'put', 'patch', 'delete']).toContain(route.method);
    }
  });
});
