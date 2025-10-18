import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
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

    // Always run prisma db push to ensure schema is up to date
    // This will create tables if they don't exist or update them if needed
    try {
      console.log('📝 Ensuring database schema is up to date...');
      await execAsync('npx prisma db push --accept-data-loss', { cwd: process.cwd() });
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