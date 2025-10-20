#!/usr/bin/env node

import { setupLogging } from '../utils/logger.js';
import { EmailProcessor } from '../services/emailProcessor.js';
import { initializeDatabase, disconnectDatabase } from '../db/prisma.js';

setupLogging();

async function main() {
  try {
    console.log('🚀 DMARC Email Processor CLI');
    console.log('============================');

    // Initialize database
    await initializeDatabase();

    // Create email processor
    const processor = new EmailProcessor();

    // Process emails
    const result = await processor.processEmails();

    // Display results
    console.log('\n📊 Processing Results:');
    console.log(`✅ Processed: ${result.processed}`);
    console.log(`❌ Errors: ${result.errors}`);
    console.log(`⏭️ Skipped: ${result.skipped}`);

    if (result.details.length > 0) {
      console.log('\n📋 Details:');
      result.details.forEach((detail, index) => {
        const icon = detail.status === 'success' ? '✅' : detail.status === 'error' ? '❌' : '⏭️';
        console.log(`${icon} ${index + 1}. ${detail.message}`);
      });
    }

    console.log('\n✅ CLI processing completed');

  } catch (error) {
    console.error('❌ CLI processing failed:', error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

// Handle CLI interruption
process.on('SIGINT', async () => {
  console.log('\n🛑 Processing interrupted by user');
  await disconnectDatabase();
  process.exit(0);
});

main();