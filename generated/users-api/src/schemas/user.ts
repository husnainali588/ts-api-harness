import { z } from 'zod';
import { pageOf } from '../http/pagination.js';

export const User = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof User>;

export const UserPage = pageOf(User);

export const UserIdParams = z.object({ id: z.uuid() });

export const CreateUserBody = z.strictObject({
  email: z.email(),
  name: z.string().min(1).max(100),
});

export const UpdateUserBody = z
  .strictObject({
    email: z.email().optional(),
    name: z.string().min(1).max(100).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });
