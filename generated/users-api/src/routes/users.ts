import { randomUUID } from 'node:crypto';
import { ListQuery } from '../http/pagination.js';
import { Conflict, NotFound } from '../http/problem.js';
import { NoContent, defineRoute, type AnyRoute } from '../http/route.js';
import { MemoryStore } from '../http/store.js';
import { CreateUserBody, UpdateUserBody, User, UserIdParams, UserPage } from '../schemas/user.js';

export function usersRoutes(store = new MemoryStore<User>()): AnyRoute[] {
  const emailTaken = (email: string, exceptId?: string) => store.find((u) => u.email === email && u.id !== exceptId) !== undefined;

  const createUser = defineRoute({
    method: 'post',
    path: '/v1/users',
    body: CreateUserBody,
    responses: { 201: User },
    handler: ({ body }) => {
      if (emailTaken(body.email)) throw new Conflict(`A user with email ${body.email} already exists.`);
      const user = store.insert({ id: randomUUID(), email: body.email, name: body.name, createdAt: new Date().toISOString() });
      return { status: 201, body: user, location: `/v1/users/${user.id}` };
    },
  });

  const listUsers = defineRoute({
    method: 'get',
    path: '/v1/users',
    query: ListQuery,
    responses: { 200: UserPage },
    handler: ({ query }) => ({ status: 200, body: store.page(query.cursor, query.limit) }),
  });

  const getUser = defineRoute({
    method: 'get',
    path: '/v1/users/:id',
    params: UserIdParams,
    responses: { 200: User },
    handler: ({ params }) => {
      const user = store.get(params.id);
      if (user === undefined) throw new NotFound(`User ${params.id} does not exist.`);
      return { status: 200, body: user };
    },
  });

  const updateUser = defineRoute({
    method: 'patch',
    path: '/v1/users/:id',
    params: UserIdParams,
    body: UpdateUserBody,
    responses: { 200: User },
    handler: ({ params, body }) => {
      const user = store.get(params.id);
      if (user === undefined) throw new NotFound(`User ${params.id} does not exist.`);
      if (body.email !== undefined && emailTaken(body.email, user.id)) throw new Conflict(`A user with email ${body.email} already exists.`);
      const updated = store.replace(user.id, { ...user, ...body });
      return { status: 200, body: updated };
    },
  });

  const deleteUser = defineRoute({
    method: 'delete',
    path: '/v1/users/:id',
    params: UserIdParams,
    responses: { 204: NoContent },
    handler: ({ params }) => {
      if (!store.delete(params.id)) throw new NotFound(`User ${params.id} does not exist.`);
      return { status: 204 };
    },
  });

  return [createUser, listUsers, getUser, updateUser, deleteUser];
}

export default usersRoutes();
