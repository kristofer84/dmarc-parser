import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Prisma 7 talks to SQLite through a driver adapter.
 *
 * `timestampFormat: 'unixepoch-ms'` is not optional here: the databases this app has been
 * running on 5.x store DateTime as INTEGER epoch-milliseconds. The adapter's default writes
 * ISO text, which sorts after every existing row - so a single new audit entry would appear
 * at the end of time and every ORDER BY createdAt would silently lie. Verified against a
 * copy of the live database before this was committed.
 */
const adapter = new PrismaBetterSqlite3(
  { url: process.env.DATABASE_URL ?? 'file:./data.db' },
  { timestampFormat: 'unixepoch-ms' },
);

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter,
  log: ['query', 'info', 'warn', 'error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Database connection test
export async function connectDatabase() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected successfully');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
}

// Graceful shutdown
export async function disconnectDatabase() {
  try {
    await prisma.$disconnect();
    console.log('✅ Database disconnected successfully');
  } catch (error) {
    console.error('❌ Database disconnection failed:', error);
    throw error;
  }
}

// Database initialization
export async function initializeDatabase() {
  try {
    console.log('🔄 Initializing database...');

    // Import exec to run prisma commands
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Always run prisma db push to ensure schema is up to date.
    //
    // Deliberately WITHOUT --accept-data-loss (dropped when moving to Prisma 7): additive
    // changes - the normal case - apply either way, while a destructive one now fails the
    // start with a clear message instead of silently dropping a column. For an app whose job
    // includes keeping audit evidence, refusing to start is the safer failure.
    try {
      console.log('📝 Ensuring database schema is up to date...');
      await execAsync('npx prisma db push', { cwd: process.cwd() });
      console.log('✅ Database schema synchronized');
    } catch (pushError) {
      console.error('❌ Failed to synchronize database schema:', pushError);
      throw pushError;
    }

    // Now connect to verify everything is working
    await connectDatabase();

    // Test the connection by running a simple query
    try {
      await prisma.report.count();
      console.log('✅ Database tables verified');
    } catch (queryError) {
      console.error('❌ Database table verification failed:', queryError);
      throw queryError;
    }

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}
