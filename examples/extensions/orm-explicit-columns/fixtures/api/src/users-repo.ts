// Fixture: a users repository with one good and one bad query per ORM style. Minimal local types stand in for
// the ORM clients (the rule is static).
interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
}

type Select = Partial<Record<keyof UserRow, boolean>>;

export interface PrismaLike {
  user: {
    findMany(args?: { select?: Select; where?: Partial<UserRow> }): Promise<Pick<UserRow, 'id' | 'email'>[]>;
    findUnique(args: { where: { id: string }; select?: Select }): Promise<UserRow | null>;
  };
}

export interface DrizzleLike {
  select(columns?: Record<string, string>): { from(table: string): Promise<unknown[]> };
  query: { users: { findMany(args?: { columns?: Select }): Promise<unknown[]> } };
}

const users = 'users';

export async function listEmails(prisma: PrismaLike) {
  return prisma.user.findMany({ select: { id: true, email: true } }); // good
}

export async function getUser(prisma: PrismaLike, id: string) {
  return prisma.user.findUnique({ where: { id } }); // bad: returns passwordHash
}

export async function listIds(db: DrizzleLike) {
  return db.select({ id: 'users.id' }).from(users); // good
}

export async function dumpUsers(db: DrizzleLike) {
  return db.select().from(users); // bad
}

export async function relationalGood(db: DrizzleLike) {
  return db.query.users.findMany({ columns: { id: true } }); // good
}
