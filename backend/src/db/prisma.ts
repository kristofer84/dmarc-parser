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
    
    // First, try to connect and create the database if it doesn't exist
    try {
      await connectDatabase();
    } catch (error) {
      console.log('📝 Database file not found, creating...');
      
      // Import exec to run prisma db push
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      try {
        await execAsync('npx prisma db push', { cwd: process.cwd() });
        console.log('✅ Database schema created');
        
        // Try connecting again
        await connectDatabase();
      } catch (pushError) {
        console.error('❌ Failed to create database schema:', pushError);
        throw pushError;
      }
    }
    
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}