import { describe, expect, it } from 'vitest';
import { CreateUserBody, UpdateUserBody, UserIdParams } from '../../src/schemas/user.js';

describe('user schemas', () => {
  it('validates create bodies', () => {
    expect(CreateUserBody.safeParse({ email: 'a@example.com', name: 'A' }).success).toBe(true);
    expect(CreateUserBody.safeParse({ email: 'nope', name: 'A' }).success).toBe(false);
    expect(CreateUserBody.safeParse({ email: 'a@example.com', name: '' }).success).toBe(false);
    expect(CreateUserBody.safeParse({ email: 'a@example.com', name: 'A', id: 'x' }).success).toBe(false);
  });

  it('requires at least one field on update', () => {
    expect(UpdateUserBody.safeParse({}).success).toBe(false);
    expect(UpdateUserBody.safeParse({ name: 'B' }).success).toBe(true);
  });

  it('requires uuid ids', () => {
    expect(UserIdParams.safeParse({ id: 'x' }).success).toBe(false);
  });
});
