import dotenv from 'dotenv';

dotenv.config();

interface Config {
  imap: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  database: {
    url: string;
  };
  server: {
    port: number;
    nodeEnv: string;
  };
}

function validateEnv(): Config {
  const requiredVars = [
    'IMAP_HOST',
    'IMAP_PORT', 
    'IMAP_USER',
    'IMAP_PASSWORD',
    'DATABASE_URL'
  ];

  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const imapPort = parseInt(process.env.IMAP_PORT!, 10);
  if (isNaN(imapPort) || imapPort <= 0 || imapPort > 65535) {
    throw new Error('IMAP_PORT must be a valid port number between 1 and 65535');
  }

  const serverPort = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(serverPort) || serverPort <= 0 || serverPort > 65535) {
    throw new Error('PORT must be a valid port number between 1 and 65535');
  }

  return {
    imap: {
      host: process.env.IMAP_HOST!,
      port: imapPort,
      user: process.env.IMAP_USER!,
      password: process.env.IMAP_PASSWORD!,
    },
    database: {
      url: process.env.DATABASE_URL!,
    },
    server: {
      port: serverPort,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
  };
}

export const config = validateEnv();