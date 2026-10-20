import { randomBytes } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { hashPassword, toAuthUser, validatePasswordStrength, type AuthUser } from './auth.js';

/**
 * Organisations (tenants) and their memberships.
 *
 * The tenancy model in one paragraph: an organisation owns domains, mailboxes and DNS accounts;
 * a user reaches an organisation through a Membership whose role is `admin` or `viewer`; the
 * instance superadmin (`User.role = 'admin'`) sees every organisation. Data scoping is done on
 * `Domain.orgId`, and the active organisation comes from the `X-Org-Id` header (validated
 * against membership on every request) or defaults to the user's first membership.
 *
 * `ensureDefaultOrganization()` is the migration: on the first start after this feature, every
 * existing user, domain, report and log is placed in a `Default` organisation so nothing
 * disappears and no data becomes invisible. It is idempotent and does nothing once any
 * organisation exists.
 */

export type OrganizationRole = 'admin' | 'viewer';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  createdAt: string;
}

export interface OrganizationMember {
  userId: string;
  email: string;
  name: string | null;
  role: OrganizationRole;
  createdAt: string;
}

function roleOf(value: unknown): OrganizationRole {
  return value === 'admin' ? 'admin' : 'viewer';
}

export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'org';
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await prisma.organization.findUnique({ where: { slug: candidate } });
    if (!existing) {
      return candidate;
    }
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export async function getDomainsForOrganization(orgId: string): Promise<string[]> {
  const rows = await prisma.domain.findMany({
    where: { orgId },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => row.name.toLowerCase());
}

export async function listUserOrganizations(userId: string): Promise<OrganizationSummary[]> {
  const rows = await prisma.membership.findMany({
    where: { userId },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.organization.id,
    name: row.organization.name,
    slug: row.organization.slug,
    role: roleOf(row.role),
    createdAt: row.organization.createdAt.toISOString(),
  }));
}

export async function getMembership(
  userId: string,
  orgId: string,
): Promise<{ orgId: string; role: OrganizationRole } | null> {
  const row = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  return row ? { orgId: row.orgId, role: roleOf(row.role) } : null;
}

export async function getOrganization(id: string) {
  return prisma.organization.findUnique({ where: { id } });
}

export async function listOrganizations() {
  return prisma.organization.findMany({ orderBy: { name: 'asc' } });
}

export async function createOrganization(input: {
  name: string;
  ownerUserId: string;
}): Promise<OrganizationSummary> {
  const name = input.name.trim();
  if (!name) {
    throw Object.assign(new Error('An organisation name is required'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const slug = await uniqueSlug(name);
  const org = await prisma.organization.create({ data: { name, slug } });
  const membership = await prisma.membership.create({
    data: { userId: input.ownerUserId, orgId: org.id, role: 'admin' },
  });
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: roleOf(membership.role),
    createdAt: org.createdAt.toISOString(),
  };
}

export async function listOrganizationMembers(orgId: string): Promise<OrganizationMember[]> {
  const rows = await prisma.membership.findMany({
    where: { orgId },
    include: { user: true },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((row) => ({
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: roleOf(row.role),
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Adds a member. An existing account is attached as-is; an unknown address creates a local
 * account with the password the org admin sets, flagged `mustChangePassword` so the admin's
 * choice is not the user's permanent password.
 */
export async function addOrganizationMember(
  orgId: string,
  input: { email: unknown; role: unknown; name?: unknown; password?: unknown },
): Promise<OrganizationMember> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('A valid email address is required'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const role = roleOf(input.role);
  const org = await getOrganization(orgId);
  if (!org) {
    throw Object.assign(new Error('Organisation not found'), {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  }

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const password = typeof input.password === 'string' ? input.password : '';
    if (!password) {
      throw Object.assign(
        new Error('This address has no account yet; provide a password for the new account'),
        { statusCode: 400, code: 'VALIDATION_ERROR' },
      );
    }
    validatePasswordStrength(password);
    user = await prisma.user.create({
      data: {
        email,
        name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null,
        passwordHash: hashPassword(password),
        role: 'user',
        isActive: true,
        mustChangePassword: true,
      },
    });
  }

  const existing = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: user.id, orgId } },
  });
  if (existing) {
    throw Object.assign(new Error('That account is already a member of this organisation'), {
      statusCode: 409,
      code: 'ALREADY_MEMBER',
    });
  }

  const row = await prisma.membership.create({
    data: { userId: user.id, orgId, role },
  });
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: roleOf(row.role),
    createdAt: row.createdAt.toISOString(),
  };
}

async function adminCount(orgId: string): Promise<number> {
  return prisma.membership.count({ where: { orgId, role: 'admin' } });
}

export async function updateOrganizationMemberRole(
  orgId: string,
  userId: string,
  role: unknown,
): Promise<OrganizationMember> {
  const row = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    include: { user: true },
  });
  if (!row) {
    throw Object.assign(new Error('Membership not found'), {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  }
  const next = roleOf(role);
  if (row.role === 'admin' && next !== 'admin' && (await adminCount(orgId)) <= 1) {
    throw Object.assign(new Error('An organisation needs at least one administrator'), {
      statusCode: 409,
      code: 'LAST_ADMIN',
    });
  }
  const updated = await prisma.membership.update({
    where: { id: row.id },
    data: { role: next },
  });
  return {
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: roleOf(updated.role),
    createdAt: updated.createdAt.toISOString(),
  };
}

/** Removes the membership only; the user account (and any other memberships) stays. */
export async function removeOrganizationMember(orgId: string, userId: string): Promise<boolean> {
  const row = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!row) {
    return false;
  }
  if (row.role === 'admin' && (await adminCount(orgId)) <= 1) {
    throw Object.assign(new Error('An organisation needs at least one administrator'), {
      statusCode: 409,
      code: 'LAST_ADMIN',
    });
  }
  await prisma.membership.delete({ where: { id: row.id } });
  return true;
}

export interface OrgSignupResult {
  user: AuthUser;
  organization: OrganizationSummary;
}

/**
 * Public org self-signup. Creates the account and makes it the organisation's first admin.
 * The email is globally unique: an existing account must sign in and create the organisation
 * from there, so a stranger cannot attach a membership to someone else's login.
 */
export async function signupOrganization(input: {
  organizationName: unknown;
  name: unknown;
  email: unknown;
  password: unknown;
}): Promise<OrgSignupResult> {
  const organizationName =
    typeof input.organizationName === 'string' ? input.organizationName.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';

  if (!organizationName) {
    throw Object.assign(new Error('An organisation name is required'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('A valid email address is required'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  validatePasswordStrength(password);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw Object.assign(
      new Error('An account with that email already exists; sign in and create the organisation from there'),
      { statusCode: 409, code: 'EMAIL_IN_USE' },
    );
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null,
      passwordHash: hashPassword(password),
      role: 'user',
      isActive: true,
    },
  });
  const organization = await createOrganization({ name: organizationName, ownerUserId: user.id });

  return { user: toAuthUser(user), organization };
}

/**
 * Migration/bootstrap: one Default organisation for everything that existed before tenancy.
 * Idempotent, and a no-op once any organisation exists (including one created by signup).
 */
export async function ensureDefaultOrganization(): Promise<{ created: boolean; orgId: string | null }> {
  const existing = await prisma.organization.findFirst();
  if (existing) {
    return { created: false, orgId: existing.id };
  }

  const org = await prisma.organization.create({
    data: { name: 'Default', slug: 'default' },
  });

  const users = await prisma.user.findMany({ select: { id: true, role: true } });
  for (const user of users) {
    await prisma.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      create: {
        userId: user.id,
        orgId: org.id,
        role: user.role === 'admin' ? 'admin' : 'viewer',
      },
      update: {},
    });
  }

  // Everything that predates tenancy becomes Default's. `orgId` is nullable on all of these
  // precisely so this can be a single pass rather than a destructive rewrite.
  await prisma.$transaction([
    prisma.domain.updateMany({ where: { orgId: null }, data: { orgId: org.id, claimSource: 'migration', claimedAt: new Date() } }),
    prisma.report.updateMany({ where: { orgId: null }, data: { orgId: org.id } }),
    prisma.forensicReport.updateMany({ where: { orgId: null }, data: { orgId: org.id } }),
    prisma.tlsRptReport.updateMany({ where: { orgId: null }, data: { orgId: org.id } }),
    prisma.processingLog.updateMany({ where: { orgId: null }, data: { orgId: org.id } }),
    prisma.alert.updateMany({ where: { orgId: null }, data: { orgId: org.id } }),
  ]);

  console.log(`🏢 Created the Default organisation and moved existing data into it (${users.length} member(s))`);
  return { created: true, orgId: org.id };
}

/** Superadmin bootstrap: existing admins should still be a member of the default org. */
export async function ensureSuperadminMembership(): Promise<void> {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) {
    return;
  }
  const superadmins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } });
  for (const user of superadmins) {
    await prisma.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      create: { userId: user.id, orgId: org.id, role: 'admin' },
      update: {},
    });
  }
}
