import { prisma } from './prisma.js';

async function main() {
  console.log('🌱 Seeding database...');

  // Create sample report for development
  const sampleReport = await prisma.report.create({
    data: {
      domain: 'example.com',
      reportId: 'google.com!example.com!1640995200!1641081599',
      orgName: 'Google Inc.',
      email: 'noreply-dmarc-support@google.com',
      startDate: new Date('2022-01-01T00:00:00Z'),
      endDate: new Date('2022-01-01T23:59:59Z'),
      records: {
        create: [
          {
            sourceIp: '209.85.220.41',
            count: 150,
            disposition: 'none',
            dkim: 'pass',
            spf: 'pass',
            headerFrom: 'example.com',
          },
          {
            sourceIp: '192.168.1.100',
            count: 5,
            disposition: 'quarantine',
            dkim: 'fail',
            spf: 'fail',
            headerFrom: 'suspicious.com',
          },
        ],
      },
    },
  });

  console.log('✅ Sample report created:', sampleReport.id);
  console.log('🌱 Database seeded successfully');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });